// YouTube videos lead with their own captions: plays an official music video (whose uploaded captions are its
// lyrics) in a test player, feeds an invisible test copy of the app through the extension, and checks that the
// app shows the captions, keeps the online lyrics as another version, and leaves the page's captions as they were.
//   npm run test:captions        FL_URL=<watch url> to try another video
import puppeteer from 'puppeteer';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9335;
const BRIDGE_PORT = 47296;
const URL = process.env.FL_URL || 'https://www.youtube.com/watch?v=4TYv2PhG89A'; // Sade, Smooth Operator (official)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'floatlyrics-ext-'));
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
const bg = path.join(EXT, 'background.js');
fs.writeFileSync(bg, fs.readFileSync(bg, 'utf8').replace('127.0.0.1:47231', `127.0.0.1:${BRIDGE_PORT}`));
const player = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  // YouTube serves captions only to a browser it does not take for a robot.
  ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=900,640',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--disable-features=HardwareMediaKeyHandling', // stays out of macOS Now Playing
  ],
});
let appProc = null;
let appBrowser = null;
try {
  const page = (await player.pages())[0];
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => {
      const v = document.querySelector('#movie_player video');
      if (v) v.volume = 0.02;
      return v && !v.paused && v.currentTime > 1 && !document.querySelector('#movie_player.ad-showing');
    },
    { timeout: 150000, polling: 500 },
  );
  const cdp = await page.createCDPSession();
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  // Captions off, as most people watch (YouTube turns them on by itself for muted autoplay, as here).
  await page.evaluate(() => {
    const p = document.getElementById('movie_player');
    p.setOption('captions', 'track', {});
    p.unloadModule('captions');
  });
  await sleep(500);

  // Now the app: the extension finds it listening and asks the player for the captions, out of sight.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'floatlyrics-test-'));
  appProc = spawn(electronPath, ['.'], { cwd: ROOT, env: { ...process.env, FL_DEBUG_PORT: String(PORT), FL_USER_DATA: userData, FL_BRIDGE_PORT: String(BRIDGE_PORT), FL_TEST: '1', FL_NO_NOWPLAYING: '1' }, stdio: 'ignore' });
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


  const read = () => win.evaluate(() => ({ ...document.body.dataset, version: document.getElementById('version').hidden ? '' : document.getElementById('version').textContent }));
  let s = await read();
  for (let i = 0; i < 150 && !(s.status === 'synced' && s.provider === 'YouTube'); i++) {
    await sleep(200);
    s = await read();
  }
  check(s.status === 'synced' && s.provider === 'YouTube', "the video's own captions are its lyrics", `${s.status} from ${s.provider || '?'} · ${s.match}`);
  check(/^1\/[2-9]/.test(s.version), 'the online lyrics stay one click away as another version', `version ${s.version || '(none)'}`);
  const lines = await win.evaluate(() => [...document.querySelectorAll('#lines .fl-line')].map((x) => x.textContent.trim()).filter(Boolean).slice(0, 3));
  console.log('  first lines:', lines.join(' / '));

  // The page is as the person left it: captions off, nothing hidden.
  const cc = await page.evaluate(() => {
    const p = document.getElementById('movie_player');
    const track = p.getOption('captions', 'track') || {};
    const hidden = [...document.querySelectorAll('style')].some((x) => x.textContent.includes('ytp-caption-window-container'));
    return { on: !!track.languageCode, hidden };
  });
  check(!cc.on && !cc.hidden, "the page's captions are left off, as they were", JSON.stringify(cc));
} catch (err) {
  check(false, 'test ran to completion', String(err && err.stack));
} finally {
  if (appBrowser) appBrowser.disconnect();
  if (appProc) appProc.kill();
  await player.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
