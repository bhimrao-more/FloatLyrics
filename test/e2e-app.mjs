// End-to-end test of the desktop app. A test browser plays a song on YouTube Music (at 2% volume) so macOS
// Now Playing reports it; the app, driven over the DevTools protocol, must show that song's synced lyrics in
// time with the player, and its play/pause/next buttons must control that player.
//   npm run test:app            FL_SHOT=<png path> also saves screenshots of the window
import puppeteer from 'puppeteer';
import electronPath from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;
const SHOT = process.env.FL_SHOT || '';
const TOLERANCE = 0.5; // seconds
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const player = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--autoplay-policy=no-user-gesture-required', '--window-size=900,640'] });
let appProc = null;
let appBrowser = null;
try {
  const page = (await player.pages())[0];
  await page.goto('https://music.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const video = () =>
    page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { t: v.currentTime, paused: v.paused, title: navigator.mediaSession.metadata && navigator.mediaSession.metadata.title } : null;
    });
  // Quiet, past any advert, and long enough to be the song.
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video');
      if (v) v.volume = 0.02;
      return v && !v.paused && v.currentTime > 1 && v.duration > 60 && !document.querySelector('.ad-showing');
    },
    { timeout: 150000, polling: 500 },
  );
  check(true, 'test player is playing the song');

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'floatlyrics-test-'));
  appProc = spawn(electronPath, ['.'], { cwd: ROOT, env: { ...process.env, FL_DEBUG_PORT: String(PORT), FL_USER_DATA: userData }, stdio: 'ignore' });
  for (let i = 0; i < 60 && !appBrowser; i++) {
    await sleep(500);
    appBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }).catch(() => null);
  }
  let win = null;
  for (let i = 0; i < 20 && !win; i++) {
    win = (await appBrowser.pages()).find((p) => p.url().endsWith('/renderer/index.html')) || null;
    if (!win) await sleep(500);
  }
  check(!!win, 'app window opened');
  const read = () => win.evaluate(() => ({ ...document.body.dataset }));
  const waitFor = async (pred, ms) => {
    const end = Date.now() + ms;
    let s = await read();
    while (!pred(s) && Date.now() < end) {
      await sleep(200);
      s = await read();
    }
    return s;
  };

  let s = await waitFor((x) => x.status === 'synced' || x.status === 'none' || x.status === 'error', 30000);
  check(/testing|chromium/i.test(s.app || ''), 'app follows the playing app via Now Playing', `${s.app} · ${s.track}`);
  check(s.status === 'synced', 'synced lyrics found', `status=${s.status} · matched ${s.match}`);
  s = await waitFor((x) => x.glass && x.art === 'loaded', 8000);
  check(s.glass === 'liquid', 'native Liquid Glass behind the window', `glass=${s.glass}`);
  check(s.art === 'loaded', 'cover art loaded from Now Playing');

  // Jump into the first verse; the highlighted line must then follow the player's own clock.
  await page.evaluate(() => (document.querySelector('video').currentTime = 42));
  await sleep(1500);
  let good = 0;
  let total = 0;
  const seen = new Set();
  for (let n = 0; n < 30; n++) {
    await sleep(400);
    const a = await read();
    const v = await video();
    if (a.line === '' || Number(a.line) < 0) continue;
    total++;
    seen.add(a.line);
    const ok = v.t >= Number(a.lineT) - TOLERANCE && (a.nextT === '' || v.t <= Number(a.nextT) + TOLERANCE);
    if (ok) good++;
    else console.log(`  off: player t=${v.t.toFixed(2)} app line ${a.line} [${a.lineT}–${a.nextT}] "${a.text}"`);
  }
  if (!total || good / total < 0.9) {
    const dbg = await win.evaluate(() => ({ pos: window.__floatlyrics.position(), np: window.__floatlyrics.nowPlaying() }));
    console.log('  debug:', JSON.stringify({ appPosition: dbg.pos, player: (await video()).t, np: dbg.np }));
  }
  check(total > 0 && good / total >= 0.9, 'highlighted line matches the player', `${good}/${total} samples in sync`);
  check(seen.size >= 2, 'lines advance with the song', `${seen.size} lines in 12s`);

  // Appearance: the popover changes theme and text size; Advanced opens Settings, which updates the window live.
  const press = async (target, sel) => {
    const r = await target.evaluate((q) => {
      const b = document.querySelector(q).getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, sel);
    await target.mouse.move(r.x, r.y);
    await sleep(200);
    await target.mouse.click(r.x, r.y);
    await sleep(400);
  };
  // Lyric lines may be swapping (track changes); the scale they are sized by is always there.
  const fontSize = () => win.evaluate(() => parseFloat(getComputedStyle(document.getElementById('fl')).getPropertyValue('--text-scale')));
  await press(win, '#look');
  check(await win.evaluate(() => !document.getElementById('pop').hidden), 'appearance popover opens');
  const f0 = await fontSize();
  await press(win, '#larger');
  const f1 = await fontSize();
  check(f1 > f0, 'larger text', `scale ${f0} → ${f1} · now showing: ${(await read()).status} ${(await read()).track}`);
  await press(win, '#smaller');
  const themed = [];
  for (const theme of ['clear', 'tinted', 'graphite', 'light', 'cover']) {
    if (await win.evaluate(() => document.getElementById('pop').hidden)) await press(win, '#look');
    await press(win, `.fl-swatch[data-theme="${theme}"]`);
    if ((await read()).theme === theme) themed.push(theme);
    if (SHOT) {
      await win.keyboard.press('Escape');
      await win.mouse.move(190, 150);
      await sleep(1300);
      await win.screenshot({ path: SHOT.replace(/\.png$/, `-theme-${theme}.png`), omitBackground: true });
    }
  }
  check(themed.length === 5, 'all five themes apply', themed.join(', '));
  if (await win.evaluate(() => document.getElementById('pop').hidden)) await press(win, '#look');
  await press(win, '#advanced');
  const settingsTarget = await appBrowser.waitForTarget((t) => t.url().endsWith('/renderer/settings.html'), { timeout: 8000 }).catch(() => null);
  check(!!settingsTarget, 'Advanced opens the Settings window');
  if (settingsTarget) {
    const pane = await settingsTarget.asPage();
    await pane.waitForSelector('.theme', { timeout: 5000 });
    await pane.evaluate(() => {
      const r = document.getElementById('clarity');
      r.value = '4';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(500);
    const clarity = await win.evaluate(() => getComputedStyle(document.getElementById('fl')).getPropertyValue('--clarity').trim());
    check(clarity === '1.8', 'Settings changes reach the lyrics window live', `--clarity=${clarity}`);
    if (SHOT) await pane.screenshot({ path: SHOT.replace(/\.png$/, '-settings.png') });
    await pane.evaluate(() => document.getElementById('reset').click());
    await sleep(500);
    check((await read()).theme === 'cover', 'Restore Defaults brings the default look back');
    await pane.close();
  }

  // Minimise: the window goes into the notch and the island carries the lyrics.
  await press(win, '#min');
  const islandTarget = await appBrowser.waitForTarget((t) => t.url().endsWith('/renderer/island.html'), { timeout: 5000 }).catch(() => null);
  check(!!islandTarget, 'island window exists');
  if (islandTarget) {
    const isl = await islandTarget.asPage();
    const readIsland = () => isl.evaluate(() => ({ ...document.body.dataset }));
    const islandWait = async (pred, ms) => {
      const end = Date.now() + ms;
      let x = await readIsland();
      while (!pred(x) && Date.now() < end) {
        await sleep(200);
        x = await readIsland();
      }
      return x;
    };
    let st = await islandWait((x) => x.active === '1' && (x.state === 'lyric' || x.state === 'compact'), 6000);
    check(st.active === '1' && st.state !== 'hidden', 'minimise hands the lyrics to the island', `state=${st.state} "${st.text}"`);
    let same = 0;
    let n = 0;
    for (let k = 0; k < 12; k++) {
      await sleep(500);
      const [i, a] = [await readIsland(), await read()];
      n++;
      if (i.text === a.text) same++;
    }
    check(same / n >= 0.8, 'island shows the same line as the lyrics clock', `${same}/${n} samples agree`);
    st = await islandWait((x) => x.state === 'lyric', 8000);
    if (SHOT) await isl.screenshot({ path: SHOT.replace(/\.png$/, '-island.png'), omitBackground: true });
    await isl.mouse.move(320, 14);
    await sleep(120);
    await isl.mouse.move(322, 16);
    st = await islandWait((x) => x.state === 'expanded', 3000);
    check(st.state === 'expanded', 'hovering the island expands it');
    await sleep(700);
    if (SHOT) await isl.screenshot({ path: SHOT.replace(/\.png$/, '-island-expanded.png'), omitBackground: true });
    await press(isl, '#open');
    st = await islandWait((x) => x.active === '0', 4000);
    check(st.active === '0' && st.state === 'hidden', 'opening from the island restores the window', `state=${st.state}`);
    await sleep(600);
  }

  // Controls go to the player through Now Playing. Only press them while the test player is the one in charge.
  if (/testing|chromium/i.test(s.app || '')) {
    // macOS follows one player at a time; never press a button while it follows someone else's.
    const ours = async () => /testing|chromium/i.test((await read()).app || '');
    const click = async (id) => {
      if (!(await ours())) throw new Error('Now Playing switched to another app; stopped before sending a command');
      const r = await win.evaluate((sel) => {
        const b = document.getElementById(sel).getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }, id);
      await win.mouse.move(r.x, r.y);
      await sleep(250);
      await win.mouse.click(r.x, r.y);
    };
    const until = async (pred, ms) => {
      const end = Date.now() + ms;
      let v = await video();
      while (!pred(v) && Date.now() < end) {
        await sleep(200);
        v = await video();
      }
      return v;
    };
    await click('play');
    check((await until((v) => v.paused, 4000)).paused, 'pause button pauses the player');
    if (SHOT) {
      await win.mouse.move(190, 120);
      await sleep(600);
    }
    await click('play');
    check(!(await until((v) => !v.paused, 4000)).paused, 'play button resumes the player');
    const before = (await video()).title;
    await click('next');
    const after = (await until((v) => v.title !== before, 8000)).title;
    check(after !== before, 'next button skips to the next track', `${before} → ${after}`);
    const song = after.replace(/\s*[([].*$/, '');
    s = await waitFor((x) => (x.track || '').startsWith(song) || !/testing|chromium/i.test(x.app || ''), 8000);
    if (/testing|chromium/i.test(s.app || '')) check((s.track || '').startsWith(song), 'window follows the new track', s.track);
    else console.log(`SKIP  window follows the new track  — macOS moved Now Playing to ${s.app} (${s.track})`);
  }

  if (SHOT) {
    await sleep(6000); // let the next song's lyrics and cover settle
    await win.mouse.move(190, 120);
    await sleep(800);
    await win.screenshot({ path: SHOT, omitBackground: true });
    console.log(`  screenshot (web layer only): ${SHOT}`);
    // The real composite, native glass included, needs a window capture (asks for Screen Recording permission).
    try {
      const swift = path.join(os.tmpdir(), 'fl-window-id.swift');
      fs.writeFileSync(
        swift,
        'import CoreGraphics\nlet list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]\n' +
          'for w in list where (w[kCGWindowOwnerName as String] as? String) == "Electron" { print(w[kCGWindowNumber as String] as! Int) }\n',
      );
      const id = execFileSync('swift', [swift], { encoding: 'utf8' }).trim().split('\n')[0];
      const file = SHOT.replace(/\.png$/, '-window.png');
      execFileSync('screencapture', ['-o', '-x', `-l${id}`, file]);
      console.log(`  screenshot (whole window): ${file}`);
    } catch (err) {
      console.log('  whole-window screenshot skipped:', String(err.message || err).split('\n')[0]);
    }
  }
} catch (err) {
  check(false, 'test ran to completion', String(err));
} finally {
  if (appBrowser) appBrowser.disconnect();
  if (appProc) appProc.kill();
  await player.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
