// End-to-end smoke test: loads the unpacked extension into Chrome for Testing, plays a song on YouTube Music
// (no login needed) and checks that synced lyrics load, follow playback, and render in the floating window.
//   npm run test:e2e            FL_URL=<watch url> and FL_SHOT=<png path> are optional
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const URL = process.env.FL_URL || 'https://music.youtube.com/watch?v=dQw4w9WgXcQ';
const SHOT = process.env.FL_SHOT || '';
const TOLERANCE = 0.45; // seconds; the view re-checks the line 5x a second

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1100,760',
  ],
});

try {
  const page = (await browser.pages())[0] || (await browser.newPage());
  page.on('console', (m) => m.text().includes('FloatLyrics') && console.log('  [page]', m.text()));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const read = () =>
    page.evaluate(() => {
      const h = document.getElementById('floatlyrics-host');
      const v = document.querySelector('video');
      return { ...(h ? { ...h.dataset } : { missing: true }), t: v ? v.currentTime : null, paused: v ? v.paused : null };
    });
  const waitFor = async (pred, ms) => {
    const end = Date.now() + ms;
    let s = await read();
    while (!pred(s) && Date.now() < end) {
      await sleep(150);
      s = await read();
    }
    return s;
  };

  let s = await waitFor((x) => !x.missing, 20000);
  check(!s.missing, 'launcher injected into the page');

  s = await waitFor((x) => x.t != null, 20000);
  if (s.paused) await page.click('#play-pause-button').catch(() => {});
  s = await waitFor((x) => x.paused === false && x.t > 0.5, 25000);
  check(s.paused === false, 'song is playing', `t=${s.t}`);

  // Signed-out playback often starts with an advert; give it time to finish before judging the lookup.
  let last = '';
  const t0 = Date.now();
  s = await waitFor((x) => {
    const now = `${x.flStatus} · ${x.flTrack}`;
    if (now !== last) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${(last = now)}`);
    return x.flStatus === 'synced' || (x.flStatus !== 'loading' && x.flStatus !== 'ad' && Number(x.flDuration) > 60);
  }, 120000);
  check(!!s.flTrack, 'track detected', `${s.flTrack} · ${s.flDuration}s · position source: ${s.flSrc}`);
  check(s.flStatus === 'synced', 'synced lyrics found', `status=${s.flStatus} · matched ${s.flMatch}`);

  // Open the floating window with a real click (the API needs a user gesture).
  const box = await page.evaluate(() => {
    const r = document.getElementById('floatlyrics-host').shadowRoot.querySelector('.fl-launch').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  s = await waitFor((x) => x.flMode && x.flMode !== 'closed', 8000);
  check(s.flMode === 'pip', 'Document Picture-in-Picture window opened', `mode=${s.flMode}`);
  check(Number(s.flRendered) > 10, 'lyric lines rendered in the window', `${s.flRendered} lines`);
  check(s.flCss === 'ok', 'styles applied inside the window', `css=${s.flCss}`);

  // Jump into the first verse and watch the highlighted line track the audio.
  await page.evaluate(() => (document.querySelector('video').currentTime = 42));
  await sleep(1500);
  const seen = new Set();
  let good = 0;
  let total = 0;
  for (let n = 0; n < 30; n++) {
    await sleep(400);
    s = await read();
    if (s.flLine === '' || Number(s.flLine) < 0) continue;
    total++;
    seen.add(s.flLine);
    const inWindow = s.t >= Number(s.flLineT) - TOLERANCE && (s.flNextT === '' || s.t <= Number(s.flNextT) + TOLERANCE);
    const shown = s.flActiveText === (s.flText || '♪');
    if (inWindow && shown) good++;
    else console.log(`  off: t=${s.t.toFixed(2)} line ${s.flLine} [${s.flLineT}–${s.flNextT}] "${s.flText}" shown="${s.flActiveText}"`);
  }
  check(total > 0 && good / total >= 0.9, 'highlighted line matches playback position', `${good}/${total} samples in sync`);
  check(seen.size >= 3, 'lines advance as the song plays', `${seen.size} different lines in 12s, last: "${s.flText}"`);

  // Pause: the line must hold still.
  await page.evaluate(() => document.querySelector('video').pause());
  await sleep(600);
  const before = (await read()).flLine;
  await sleep(2500);
  check((await read()).flLine === before, 'lyrics hold while paused');

  if (SHOT) {
    for (const target of browser.targets()) {
      if (target === page.target() || target.url() !== 'about:blank') continue;
      const pip = await target.asPage().catch(() => null);
      if (!pip) continue;
      const isOurs = await pip.evaluate(() => !!document.querySelector('.fl')).catch(() => false);
      if (isOurs) {
        await pip.screenshot({ path: SHOT });
        console.log(`  screenshot of the floating window: ${SHOT}`);
      }
    }
  }
} catch (err) {
  check(false, 'test ran to completion', String(err));
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
