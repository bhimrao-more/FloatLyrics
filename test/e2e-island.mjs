// Island robustness: plays a song in a test player, minimises an invisible test copy of the app into the island,
// then (1) storms play/pause, from the page and from the island's own button, and (2) moves the island between
// every connected screen, again and again. After each step the island must be alive, in the right mode for its
// screen (notch or glass), and drawn entirely inside its window: nothing cropped.
//   npm run test:island          FL_QUICK=1 FL_URL=<watch url>: only the pause and the gaps, on another song
import puppeteer from 'puppeteer';
import electronPath from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9334;
const BRIDGE_PORT = 47298;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

// The screens, from AppKit (top-left origin like Electron's), and which has a notch.
const screens = JSON.parse(
  execFileSync(
    'osascript',
    ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); const r = []; const s = $.NSScreen.screens; const H = s.objectAtIndex(0).frame.size.height; for (let i = 0; i < s.count; i++) { const c = s.objectAtIndex(i); const f = c.frame; r.push({ name: c.localizedName.js, x: f.origin.x, y: H - f.origin.y - f.size.height, w: f.size.width, h: f.size.height, notch: c.safeAreaInsets.top > 0 && c.auxiliaryTopLeftArea.size.width > 0 }); } JSON.stringify(r)'],
    { encoding: 'utf8' },
  ),
);
console.log('screens:', screens.map((s) => `${s.name} ${s.w}×${s.h} @${s.x},${s.y}${s.notch ? ' (notch)' : ''}`).join(' · '));

const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'floatlyrics-ext-'));
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
const bg = path.join(EXT, 'background.js');
fs.writeFileSync(bg, fs.readFileSync(bg, 'utf8').replace('127.0.0.1:47231', `127.0.0.1:${BRIDGE_PORT}`));
const player = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=900,640',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--disable-features=HardwareMediaKeyHandling', // stays out of macOS Now Playing: your own music is left alone
  ],
});
let appProc = null;
let appBrowser = null;
try {
  const page = (await player.pages())[0];
  const cdp = await page.createCDPSession();
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await page.goto(process.env.FL_URL || 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Past any advert and playing the song. Polled, because the page swaps its context when an advert ends.
  for (let end = Date.now() + 180000; ; ) {
    const ok = await page
      .evaluate(() => {
        const v = document.querySelector('#movie_player video') || document.querySelector('video');
        if (v) v.volume = 0.02;
        return !!v && !v.paused && v.currentTime > 1 && v.duration > 60 && !document.querySelector('.ad-showing');
      })
      .catch(() => false);
    if (ok) break;
    if (Date.now() > end) throw new Error('the test player never started the song');
    await sleep(500);
  }
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }); // out of the way; it keeps playing
  const video = () =>
    page.evaluate(() => {
      const v = document.querySelector('#movie_player video') || document.querySelector('video');
      return { t: v.currentTime, paused: v.paused };
    });
  await page.evaluate(() => (document.querySelector('video').currentTime = 40));

  // The app window starts on the first screen without a notch when there is one, so "Window's screen" has
  // somewhere else to go than the notch.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'floatlyrics-test-'));
  const plain = screens.find((s) => !s.notch) || screens[0];
  fs.writeFileSync(path.join(userData, 'window.json'), JSON.stringify({ x: Math.round(plain.x + plain.w / 2 - 190), y: Math.round(plain.y + plain.h / 2), width: 380, height: 220 }));
  appProc = spawn(electronPath, ['.'], { cwd: ROOT, env: { ...process.env, FL_DEBUG_PORT: String(PORT), FL_USER_DATA: userData, FL_BRIDGE_PORT: String(BRIDGE_PORT), FL_TEST: '1', FL_NO_NOWPLAYING: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 60 && !appBrowser; i++) {
    await sleep(500);
    appBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }).catch(() => null);
  }
  const findPage = async (suffix) => {
    for (let i = 0; i < 30; i++) {
      for (const t of appBrowser.targets()) if (t.url().endsWith(suffix)) {
        const p = await t.asPage().catch(() => null);
        if (p && !p.isClosed()) {
          const alive = await p.evaluate(() => 1).catch(() => 0);
          if (alive) return p;
        }
      }
      await sleep(300);
    }
    return null;
  };
  const win = await findPage('/renderer/index.html');
  check(!!win, 'app window opened');
  const read = () => win.evaluate(() => ({ ...document.body.dataset }));
  for (let i = 0; i < 100 && (await read()).status !== 'synced'; i++) await sleep(300);
  check((await read()).status === 'synced', 'synced lyrics found', (await read()).track);

  // Everything about the island that can go wrong, read from inside it.
  const inspect = (isl) =>
    isl.evaluate(() => {
      const W = innerWidth;
      const H = innerHeight;
      const d = document.body.dataset;
      const island = document.getElementById('island');
      const box = island.getBoundingClientRect();
      const problems = [];
      const inside = (r) => r.left >= -0.5 && r.top >= -0.5 && r.right <= W + 0.5 && r.bottom <= H + 0.5;
      const live = d.state !== 'hidden' && d.state !== 'idle';
      // hard: never acceptable, even for a frame. The rest only once the island has settled.
      const hard = [];
      if (d.state !== 'hidden' && !inside(box)) hard.push(`island ${Math.round(box.width)}×${Math.round(box.height)} spills out of its ${W}×${H} window`);
      if (d.mode === 'glass' && W >= 640 && H >= 240) hard.push('glass island in a notch-sized window');
      if (d.mode === 'notch' && W < 640) hard.push(`notch island in a ${W}×${H} glass window`);
      problems.push(...hard);
      if (live) {
        const clip = document.getElementById('lyric').getBoundingClientRect();
        for (const sel of ['.disc', '.bars']) {
          const r = document.querySelector(sel).getBoundingClientRect();
          if (!inside(r)) problems.push(`${sel} cropped`);
        }
        const row = document.querySelector('.row.is-on');
        if (row) {
          const r = row.getBoundingClientRect();
          if (r.top < clip.top - 1 || r.bottom > clip.bottom + 1) problems.push(`lyric line cropped (${Math.round(r.top)}–${Math.round(r.bottom)} in ${Math.round(clip.top)}–${Math.round(clip.bottom)})`);
        }
      }
      if (d.state === 'paused') {
        const pm = document.getElementById('pmeta').getBoundingClientRect();
        if (!inside(pm)) problems.push("paused song name cropped");
      }
      return { mode: d.mode, state: d.state, item: d.item, active: d.active, shown: d.shown, text: d.text || d.soon || '', W, H, x: screenX, y: screenY, pos: window.__floatlyrics.position(), problems, hard };
    });

  await win.evaluate(() => document.getElementById('min').click());
  let isl = await findPage('/renderer/island.html');
  check(!!isl, 'island window exists');
  const settle = async (pred, ms) => {
    const end = Date.now() + ms;
    let x = null;
    while (Date.now() < end) {
      isl = (await findPage('/renderer/island.html')) || isl;
      x = await inspect(isl).catch(() => null);
      if (x && pred(x)) return x;
      await sleep(250);
    }
    return x;
  };
  const healthy = (x) => x && x.active === '1' && x.shown === '1' && (x.state === 'lyric' || x.state === 'compact') && !x.problems.length;
  let st = await settle(healthy, 8000);
  check(healthy(st), 'minimise hands the lyrics to the island', JSON.stringify(st));

  // Play/pause storms: from the page at uneven speeds, then from the island's own ⏯. The island must still be
  // there and following the song afterwards.
  const ensurePlaying = async () => {
    if ((await video()).paused) await page.evaluate(() => document.querySelector('video').play());
  };
  async function storm(where) {
    for (let k = 0; k < 24; k++) {
      await page.evaluate(() => {
        const v = document.querySelector('#movie_player video') || document.querySelector('video');
        if (v.paused) v.play();
        else v.pause();
      });
      await sleep([120, 400, 60, 900, 250][k % 5]);
    }
    await ensurePlaying();
    let x = await settle(healthy, 8000);
    const p0 = x && x.pos;
    await sleep(1500);
    // a line rolling in is clipped on purpose for a moment; judge the island once the roll has settled
    x = await settle((y) => healthy(y) && y.pos - p0 > 1, 3000);
    check(healthy(x) && x.pos - p0 > 1, `${where}: after a play/pause storm the island still follows the song`, `${x.mode} ${x.state} "${x.text}" moved ${(x.pos - p0).toFixed(2)}s ${x.problems.join('; ')}`);
    for (let k = 0; k < 16; k++) {
      await isl.evaluate(() => document.getElementById('play').click()).catch(() => {});
      await sleep([150, 500, 90, 700][k % 4]);
    }
    await sleep(1500);
    await ensurePlaying();
    x = await settle(healthy, 8000);
    const p1 = x && x.pos;
    await sleep(1500);
    x = await settle((y) => healthy(y) && y.pos - p1 > 1, 3000);
    check(healthy(x) && x.pos - p1 > 1, `${where}: after storming the island's ⏯ it still follows the song`, `${x.mode} ${x.state} "${x.text}" ${x.problems.join('; ')}`);
  }

  // Every screen, back and forth, notch and glass. Nothing may be cropped once it settles, and no frame on
  // screen may be cropped while it moves.
  const options = await win.evaluate(() => window.floatlyrics.displays());
  console.log('island screens offered:', options.map((o) => `${o.label}${o.notch ? ' (notch)' : ''}`).join(' · '));
  check(options.filter((o) => o.id.startsWith('display:')).length === screens.length, 'every connected screen is offered for the island', `${options.length} options for ${screens.length} screens`);
  // FL_QUICK=1: skip the screen tour and storms (for trying the gaps and pause on another song, with FL_URL).
  const QUICK = !!process.env.FL_QUICK;
  const order = QUICK ? [] : [...options, ...options.slice().reverse(), ...options];
  for (const o of order) {
    await win.evaluate((id, name) => window.floatlyrics.setSettings({ islandScreen: id, islandScreenName: name || '' }), o.id, o.name);
    const glitches = [];
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      isl = (await findPage('/renderer/island.html')) || isl;
      const x = await inspect(isl).catch(() => null);
      if (x && x.shown === '1' && x.state !== 'hidden' && x.hard.length) glitches.push(x.hard[0]);
      await sleep(40);
    }
    const kind = o.notch ? 'notch' : 'glass';
    const onIt = (x) => x.mode === kind && x.x >= o.bounds.x - 1 && x.x < o.bounds.x + o.bounds.width && Math.abs(x.y - o.bounds.y) <= 20;
    const st = await settle((x) => healthy(x) && onIt(x), 6000);
    check(!!st && healthy(st) && onIt(st), `island on ${o.label} (${o.screen}): ${kind}, at the top, nothing cropped`, st ? `${st.mode} ${st.W}×${st.H} at ${st.x},${st.y} ${st.problems.join('; ')}` : 'no island');
    check(!glitches.length, `moving to ${o.label} shows no broken frame`, glitches.slice(0, 3).join(' | '));
  }

  // Paused: the island stays (longer than the old 15s timeout) with the song's name and ▶; ▶ plays again, the
  // button goes and the lyric rises.
  const styleOf = () =>
    isl.evaluate(() => ({
      resume: Number(getComputedStyle(document.getElementById('resume')).opacity),
      pmeta: Number(getComputedStyle(document.getElementById('pmeta')).opacity),
      title: document.getElementById('ptitle').textContent,
      line: Number((document.querySelector('.row.is-on') && getComputedStyle(document.querySelector('.row.is-on')).opacity) || 0),
    }));
  async function pausedAndBack(where) {
    await page.evaluate(() => document.querySelector('video').pause());
    await settle((y) => y.state === 'paused' && y.shown === '1', 4000);
    await sleep(17000);
    let x = await inspect(isl);
    let v = await styleOf();
    check(x.state === 'paused' && x.shown === '1' && !x.problems.length && v.resume > 0.9 && v.pmeta > 0.9 && !!v.title, `${where}: paused for 17s, the island stays with the song's name and ▶`, `${x.state} shown=${x.shown} ${JSON.stringify(v)} ${x.problems.join('; ')}`);
    await isl.evaluate(() => document.getElementById('resume').click());
    x = await settle((y) => y.state === 'lyric' && healthy(y), 5000);
    await sleep(700);
    v = await styleOf();
    const playing = !(await video()).paused;
    check(playing && !!x && x.state === 'lyric' && v.resume < 0.1 && v.pmeta < 0.1 && v.line > 0.9, `${where}: ▶ plays; the button goes and the lyric comes up`, `playing=${playing} ${x && x.state} ${JSON.stringify(v)}`);
  }

  // Between lines: the song's name in the intro; in an instrumental break the island draws in to the cover and the
  // equaliser, with no empty space between them.
  async function gaps(where) {
    const list = await isl.evaluate(() => window.__floatlyrics.rows());
    const intro = list[0] && list[0].kind === 'title' && list[0].end < 1e9 ? list[0] : null;
    const brk = (await isl.evaluate(() => window.__floatlyrics.breaks()))[0];
    if (intro) {
      await page.evaluate((t) => (document.querySelector('video').currentTime = t), Math.max(0.5, intro.end - 8));
      const x = await settle((y) => y.item === 'title' && healthy(y), 4000);
      check(!!x && x.item === 'title', `${where}: the intro shows the song's name`, x ? `${x.item} at ${x.pos.toFixed(1)}s` : 'nothing');
    } else console.log(`SKIP  ${where}: intro — this song starts singing straight away`);
    if (brk) {
      await page.evaluate((t) => (document.querySelector('video').currentTime = t), brk.t + 2.5);
      // glass: the window itself narrows; notch: the island is the notch plus the cover and equaliser either side
      const x = await settle((y) => y.item === 'break' && y.state === 'compact' && healthy(y) && (y.mode !== 'glass' || y.W <= 100), 4000);
      check(!!x && x.item === 'break' && x.state === 'compact', `${where}: an instrumental break draws in to the cover and the equaliser`, x ? `${x.state} ${x.W}×${x.H} at ${x.pos.toFixed(1)}s (break ${brk.t.toFixed(1)}–${brk.end.toFixed(1)}s)` : 'nothing');
    } else console.log(`SKIP  ${where}: break — no instrumental break of 6s or more in this song`);
    await page.evaluate(() => (document.querySelector('video').currentTime = 42));
    await settle(healthy, 4000);
  }

  // Storm both kinds of island.
  for (const kind of ['notch', 'glass']) {
    const o = options.find((x) => x.id.startsWith('display:') && x.notch === (kind === 'notch'));
    if (!o) {
      console.log(`SKIP  ${kind} island storms — no such screen connected`);
      continue;
    }
    await win.evaluate((id, name) => window.floatlyrics.setSettings({ islandScreen: id, islandScreenName: name }), o.id, o.name);
    await settle((x) => healthy(x) && x.mode === kind, 6000);
    if (!QUICK) await storm(`${kind} island on ${o.label}`);
    await pausedAndBack(`${kind} island`);
    await gaps(`${kind} island`);
  }
} catch (err) {
  check(false, 'test ran to completion', String(err && err.stack));
} finally {
  if (appBrowser) appBrowser.disconnect();
  if (appProc) appProc.kill();
  await player.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
