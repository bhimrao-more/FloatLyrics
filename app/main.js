/*
 * FloatLyrics desktop app (macOS). A frameless, see-through, always-on-top window that shows synced lyrics for
 * whatever macOS reports as Now Playing, with play/pause/next for that player.
 */
const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { NowPlaying } = require('./nowplaying');
const { createLyrics } = require('./lyrics');
const { normalize, videoTrack } = require('../extension/core.js');
const looks = require('./renderer/looks.js');

// For the e2e test: a DevTools port to drive the window, and a throwaway settings folder.
if (process.env.FL_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.FL_DEBUG_PORT);
if (process.env.FL_USER_DATA) app.setPath('userData', process.env.FL_USER_DATA);

// Browsers report web players as they are: YouTube video titles, channel names as artists.
const BROWSER = /^(com\.google\.chrome|com\.apple\.safari|company\.thebrowser|com\.microsoft\.edgemac|com\.brave\.browser|org\.mozilla\.firefox|com\.operasoftware|com\.vivaldi)/i;
// Chrome hands Now Playing a position ~0.2s behind the page's own clock (measured), so lead it by that much.
const leadFor = (bundle) => (/^com\.google\.chrome/i.test(bundle) ? 0.2 : 0);

const np = new NowPlaying();
let lyrics;
let win = null; // the floating lyrics window: the app itself
let island = null; // the Dynamic Island around the notch, active while the window is minimised
let islandActive = false;
let settingsWin = null;
let settings = looks.DEFAULTS;
const last = {}; // latest message per channel, replayed when a window (re)loads
let trackKey = '';
let lookupTimer = null;
const offsets = new Map(); // the user's timing nudge per track, shared by the window and the island

function send(channel, data) {
  last[channel] = data;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isLoading()) w.webContents.send(channel, data);
  }
}

function replay(w) {
  for (const [channel, data] of Object.entries(last)) w.webContents.send(channel, data);
}

function trackOf(s) {
  if (!s.title) return null;
  const base = BROWSER.test(s.bundleIdentifier || '') ? videoTrack(s.title, s.artist) : { title: s.title, artist: s.artist || '' };
  return { ...base, album: s.album || '', duration: (s.durationMicros || 0) / 1e6 };
}

function onNowPlaying(state, diff) {
  const track = trackOf(state);
  const app = state.bundleIdentifier || '';
  const key = track ? `${app}|${normalize(track.title)}|${normalize(track.artist)}|${Math.round(track.duration / 10)}` : '';
  const rate = state.playbackRate || 0;
  send('np', {
    key,
    app,
    title: track ? track.title : '',
    artist: track ? track.artist : '',
    duration: track ? track.duration : 0,
    elapsed: (state.elapsedTimeMicros || 0) / 1e6,
    at: state.timestampEpochMicros ? state.timestampEpochMicros / 1000 : Date.now(),
    rate: rate || 1,
    playing: state.playing != null ? !!state.playing : rate > 0,
    lead: leadFor(app),
  });
  if ('artworkData' in diff || 'artworkMimeType' in diff) {
    send('art', state.artworkData ? `data:${state.artworkMimeType || 'image/jpeg'};base64,${state.artworkData}` : '');
  }

  if (key === trackKey) return;
  trackKey = key;
  clearTimeout(lookupTimer);
  send('offset', { key, value: offsets.get(key) || 0 });
  if (!track) return send('lyrics', { key, status: 'idle' });
  // Adverts (YouTube) and short clips: wait for the song itself.
  if (track.duration > 0 && track.duration < 30) return send('lyrics', { key, status: 'ad' });
  send('lyrics', { key, status: 'loading' });
  // Metadata can arrive in pieces; look up once it has settled.
  lookupTimer = setTimeout(() => {
    lyrics.lookup(track).then(
      (result) => key === trackKey && send('lyrics', { ...result, key }),
      () => key === trackKey && send('lyrics', { key, status: 'error' }),
    );
  }, 350);
}

/* ---------- appearance settings ---------- */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = looks.sanitize(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch (err) {
    settings = looks.sanitize({});
  }
}

function setSettings(next) {
  settings = looks.sanitize(next);
  fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), () => {});
  send('settings', settings);
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(settings.onTop, 'floating');
  if (!settings.island && islandActive) restoreFromIsland();
  return settings;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 700,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'FloatLyrics Settings',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  // Opened from a floating widget, so it must not land behind other apps' windows.
  settingsWin.setAlwaysOnTop(true, 'floating');
  settingsWin.webContents.on('did-finish-load', () => {
    settingsWin.webContents.send('settings', settings);
    settingsWin.show();
    app.focus({ steal: true });
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
}

/* ---------- window ---------- */

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

function initialBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const fallback = { width: 380, height: 220, x: area.x + area.width - 380 - 24, y: area.y + area.height - 220 - 24 };
  try {
    const saved = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x < a.x + a.width - 40 && saved.x + saved.width > a.x + 40 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40;
    });
    return visible ? saved : fallback;
  } catch (err) {
    return fallback;
  }
}

function applyGlass() {
  let mode = 'none';
  try {
    const mod = require('electron-liquid-glass');
    const liquidGlass = mod.default || mod;
    liquidGlass.addView(win.getNativeWindowHandle(), { cornerRadius: 22, tintColor: '#0c0c1018' });
    mode = 'liquid';
  } catch (err) {
    console.warn('[FloatLyrics] native Liquid Glass unavailable, using vibrancy:', err.message);
    try {
      win.setVibrancy('hud');
      mode = 'vibrancy';
    } catch (e) {}
  }
  send('glass', mode);
}

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 220,
    minHeight: 90,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    title: 'FloatLyrics',
    // A floating widget must keep animating while other apps have focus.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // Above ordinary windows, on every Space, and over full-screen apps.
  win.setAlwaysOnTop(settings.onTop, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  let saveTimer = null;
  const saveBounds = () => {
    if (animating) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFile(boundsFile(), JSON.stringify(win.getBounds()), () => {}), 400);
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);

  win.webContents.on('did-finish-load', () => {
    if (!last.glass) applyGlass();
    replay(win);
    win.showInactive();
  });
  // The system minimise (yellow button, Window menu) also hands over to the island.
  win.on('minimize', () => settings.island && setIslandActive(true));
  win.on('restore', () => setIslandActive(false));
  win.on('closed', () => {
    win = null;
    app.quit(); // the window is the app; closing it quits
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/* ---------- Dynamic Island ---------- */

// The notch's size, from AppKit (Electron does not expose it). null on Macs and displays without one.
let notchCache;
function notch() {
  if (notchCache !== undefined) return notchCache;
  notchCache = null;
  try {
    const out = execFileSync(
      'osascript',
      ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); const r = []; const s = $.NSScreen.screens; for (let i = 0; i < s.count; i++) { const c = s.objectAtIndex(i); r.push({ w: c.frame.size.width, top: c.safeAreaInsets.top, left: c.auxiliaryTopLeftArea.size.width, right: c.auxiliaryTopRightArea.size.width }); } JSON.stringify(r)'],
      { encoding: 'utf8', timeout: 5000 },
    );
    const n = JSON.parse(out).find((x) => x.top > 0 && x.left > 0 && x.right > 0);
    if (n) notchCache = { width: n.w - n.left - n.right, height: n.top, screenWidth: n.w };
  } catch (err) {}
  return notchCache;
}

// The island lives on the built-in display when it has a notch, otherwise as a floating pill on the main display.
function islandPlace() {
  const n = notch();
  const internal = screen.getAllDisplays().find((d) => d.internal && (!n || Math.abs(d.bounds.width - n.screenWidth) < 2));
  return n && internal ? { display: internal, notch: n } : { display: screen.getPrimaryDisplay(), notch: null };
}

const ISLAND_W = 640;
const ISLAND_H = 240;

function sendIsland() {
  const { notch: n } = islandPlace();
  send('island', { active: islandActive, hasNotch: !!n, notchWidth: n ? n.width : 0, notchHeight: n ? n.height : 0 });
}

function placeIsland() {
  if (!island) return;
  const b = islandPlace().display.bounds;
  island.setBounds({ x: Math.round(b.x + b.width / 2 - ISLAND_W / 2), y: b.y, width: ISLAND_W, height: ISLAND_H });
  sendIsland();
}

function createIsland() {
  island = new BrowserWindow({
    width: ISLAND_W,
    height: ISLAND_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    type: 'panel',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // Above the menu bar, on every Space, over full-screen apps; clicks pass through except on the island itself.
  island.setAlwaysOnTop(true, 'screen-saver');
  island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  island.setIgnoreMouseEvents(true, { forward: true });
  island.webContents.on('did-finish-load', () => {
    replay(island);
    placeIsland();
    island.showInactive();
  });
  island.on('closed', () => {
    island = null;
  });
  island.loadFile(path.join(__dirname, 'renderer', 'island.html'));
}

function setIslandActive(on) {
  islandActive = on;
  sendIsland();
}

let animating = false; // window bounds are mid-animation; do not save them

// The window shrinks into the notch and hides; the island takes over the lyrics.
function minimizeToIsland() {
  if (!win || !win.isVisible() || animating) return;
  if (!settings.island) return win.minimize();
  const { display, notch: n } = islandPlace();
  const b = display.bounds;
  const w = n ? Math.round(n.width) : 200;
  const h = n ? Math.round(n.height) : 34;
  const saved = win.getBounds();
  animating = true;
  win.setMinimumSize(1, 1);
  win.setBounds({ x: Math.round(b.x + b.width / 2 - w / 2), y: b.y, width: w, height: h }, true);
  setIslandActive(true);
  setTimeout(() => {
    if (win) {
      win.hide();
      win.setBounds(saved);
      win.setMinimumSize(220, 90);
    }
    animating = false;
  }, 340);
}

// The window grows back out of the notch; the island tucks away.
function restoreFromIsland() {
  if (!win) return createWindow();
  setIslandActive(false);
  if (win.isMinimized()) return win.restore();
  if (win.isVisible() || animating) return undefined;
  const { display, notch: n } = islandPlace();
  const b = display.bounds;
  const w = n ? Math.round(n.width) : 200;
  const h = n ? Math.round(n.height) : 34;
  const target = win.getBounds();
  animating = true;
  win.setMinimumSize(1, 1);
  win.setBounds({ x: Math.round(b.x + b.width / 2 - w / 2), y: b.y, width: w, height: h });
  win.showInactive();
  win.setBounds(target, true);
  setTimeout(() => {
    if (win) win.setMinimumSize(220, 90);
    animating = false;
  }, 340);
  return undefined;
}

app.setName('FloatLyrics');

app.whenReady().then(() => {
  lyrics = createLyrics(path.join(app.getPath('userData'), 'lyrics-cache.json'));
  loadSettings();
  send('settings', settings);
  ipcMain.handle('command', (_event, name) => np.send(name));
  ipcMain.handle('settings:set', (_event, patch) => setSettings({ ...settings, ...patch }));
  ipcMain.handle('settings:reset', () => setSettings(looks.DEFAULTS));
  ipcMain.on('settings:open', openSettings);
  ipcMain.on('close', () => app.quit());
  ipcMain.on('window:minimize', minimizeToIsland);
  ipcMain.on('window:restore', restoreFromIsland);
  ipcMain.on('island:hover', (_event, inside) => island && island.setIgnoreMouseEvents(!inside, { forward: true }));
  ipcMain.on('nudge', (_event, delta) => {
    const value = Math.round(((offsets.get(trackKey) || 0) + Number(delta || 0)) * 10) / 10;
    offsets.set(trackKey, value);
    send('offset', { key: trackKey, value });
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'FloatLyrics',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'Window',
        submenu: [
          { label: 'Minimise to Notch', accelerator: 'CmdOrCtrl+M', click: minimizeToIsland },
          { label: 'Show Lyrics Window', click: restoreFromIsland },
        ],
      },
    ]),
  );
  np.on('change', onNowPlaying);
  np.on('log', (line) => line && console.log('[now-playing]', line));
  np.start();
  createWindow();
  createIsland();
  for (const evt of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(evt, () => {
      notchCache = undefined;
      placeIsland();
    });
  }
});

// Clicking the Dock icon brings the window back from the notch.
app.on('activate', () => restoreFromIsland());
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => np.stop());
