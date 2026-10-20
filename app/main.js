/*
 * FloatLyrics desktop app (macOS). A frameless, see-through, always-on-top window that shows synced lyrics for
 * whatever macOS reports as Now Playing, with play/pause/next for that player.
 */
const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { NowPlaying } = require('./nowplaying');
const { createLyrics } = require('./lyrics');
const { normalize, videoTrack } = require('../extension/core.js');
const looks = require('./renderer/looks.js');

// For the e2e test: a DevTools port to drive the window, and a throwaway settings folder. Test copies are
// invisible and click-through (FL_TEST), so nobody mistakes them for the real app or clicks them by accident.
const TEST = !!process.env.FL_TEST;
const hideForTest = (w) => {
  if (!TEST) return;
  w.setOpacity(0);
  w.setIgnoreMouseEvents(true);
};
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
const offsets = new Map(); // the user's timing nudge per song, shared by the window and the island

function send(channel, data) {
  last[channel] = data;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isLoading()) w.webContents.send(channel, data);
  }
}

function replay(w) {
  for (const [channel, data] of Object.entries(last)) w.webContents.send(channel, data);
}

/* ---------- what is playing ----------
 * Two sources. The browser extension reads the page's own <video>, so for Chrome tabs it is exact: position,
 * length and adverts. macOS Now Playing covers every other app (Music, Spotify, Safari…), but for browsers it
 * follows whichever media element is active, which on YouTube includes pause ads and previews.
 */

let npState = {}; // merged Now Playing state from the adapter
let npArt = '';
const tabs = new Map(); // extension reports by browser tab
const TAB_FRESH_MS = 2500;
let lastSong = null; // the last real song (≥ 30s), to see through YouTube's short pause ads
let current = null; // the report on screen
let emptySince = 0;
let npPlayingSince = 0; // when Now Playing started playing its current item

// Chrome sometimes reports a playing web player with no length and no clock at all (position stuck at 0).
const npHasPosition = () => !!(npState.timestampEpochMicros || npState.durationMicros);
const positionOf = (r, now) => r.elapsed + (r.playing ? Math.max(0, ((now - r.at) / 1000) * r.rate) : 0);
const sameTitle = (a, b) => !!a && !!b && normalize(a.title) === normalize(b.title);

function nowPlayingReport() {
  const s = npState;
  if (!s.title) return null;
  const bundle = s.bundleIdentifier || '';
  const base = BROWSER.test(bundle) ? videoTrack(s.title, s.artist) : { title: s.title, artist: s.artist || '' };
  const rate = s.playbackRate || 0;
  return {
    ...base,
    source: 'nowplaying',
    app: bundle,
    album: s.album || '',
    duration: (s.durationMicros || 0) / 1e6,
    elapsed: (s.elapsedTimeMicros || 0) / 1e6,
    at: s.timestampEpochMicros ? s.timestampEpochMicros / 1000 : Date.now(),
    rate: rate || 1,
    playing: s.playing != null ? !!s.playing : rate > 0,
    lead: leadFor(bundle),
    ad: false,
    art: npArt,
  };
}

const SITE_NAMES = { ytmusic: 'YouTube Music', youtube: 'YouTube', spotify: 'Spotify', applemusic: 'Apple Music' };
const APP_NAMES = {
  'com.apple.Music': 'Music',
  'com.spotify.client': 'Spotify',
  'com.google.Chrome': 'Chrome',
  'com.apple.Safari': 'Safari',
  'company.thebrowser.Browser': 'Arc',
  'com.microsoft.edgemac': 'Edge',
  'com.brave.Browser': 'Brave',
  'org.mozilla.firefox': 'Firefox',
};
// Players that are about music (as opposed to a YouTube tab, which might be a talk or a movie clip).
const MUSIC_APP = /^(com\.apple\.Music|com\.apple\.iTunes|com\.spotify\.client|com\.tidal|com\.amazon\.music|com\.deezer|sh\.cider|com\.pear)/i;
const isMusicSource = (r) => (r.source === 'extension' ? /^(ytmusic|spotify|applemusic)$/.test(r.site) : MUSIC_APP.test(r.app));
const labelOf = (r) =>
  r.source === 'extension' ? SITE_NAMES[r.site] || 'Browser' : APP_NAMES[r.app] || (r.app || 'App').split('.').pop();

// Every open tab the extension reports on, as a report. Tabs that stopped reporting (closed, navigated) drop out.
function tabReports(now) {
  const out = [];
  for (const [id, t] of tabs) {
    if (now - t.receivedAt > TAB_FRESH_MS) {
      tabs.delete(id);
      continue;
    }
    if (!t.title && !t.ad) continue;
    out.push({
      id: `tab:${id}`,
      tabId: id,
      site: t.site || 'web',
      title: t.title || '',
      artist: t.artist || '',
      alt: t.alt,
      tempo: t.tempo,
      source: 'extension',
      app: `extension:${t.site || 'web'}`,
      album: t.album || '',
      duration: t.duration || 0,
      elapsed: t.position || 0,
      at: t.at || now,
      rate: t.rate || 1,
      playing: !t.paused,
      startedAt: t.startedAt || 0,
      lead: 0,
      ad: !!t.ad,
      art: t.artwork || '',
    });
  }
  return out;
}

// Everything that could be followed right now. Now Playing joins unless it is just one of the tabs again.
function candidates(now) {
  const list = tabReports(now);
  const n = nowPlayingReport();
  if (n && !(BROWSER.test(n.app) && list.some((t) => sameTitle(t, n)))) list.push({ ...n, id: 'np', startedAt: npPlayingSince });
  return list;
}

let pinned = null; // a source the person chose with the ⇄ button; held until it goes away
let shownPausedAt = 0; // when what is on screen paused
let sources = [];

// Which source to follow when nobody picked one:
//  - the most recently started of those playing;
//  - when a music player and a plain video play together, the music player;
//  - a song you just paused stays, unless something started after you paused it.
function pickAuto(list, now) {
  const shown = current && list.find((c) => c.id === current.id);
  if (shown && !shown.playing) shownPausedAt = shownPausedAt || now;
  else shownPausedAt = 0;
  let playing = list.filter((c) => c.playing);
  if (shown && !shown.playing) playing = playing.filter((c) => c.startedAt > shownPausedAt);
  if (playing.length) {
    const music = playing.filter(isMusicSource);
    const pool = music.length ? music : playing;
    return pool.sort((a, b) => b.startedAt - a.startedAt)[0];
  }
  if (shown) return shown;
  return list.sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}

function choose(now) {
  const list = candidates(now);
  sources = list;
  let r = (pinned && list.find((c) => c.id === pinned)) || null;
  if (!r) {
    pinned = null;
    r = pickAuto(list, now);
  }
  // A short clip under the song's title (YouTube pause ad, preview): keep the song, paused where it stopped.
  if (r && r.source === 'nowplaying' && r.duration > 0 && r.duration < 30 && lastSong && lastSong.app === r.app && sameTitle(lastSong, r)) {
    r = lastSong.playing ? { ...lastSong, elapsed: positionOf(lastSong, now), at: now, playing: false } : lastSong;
  }
  // No position from Now Playing: carry on from the last position we knew for this song (often where it paused).
  if (r && r.source === 'nowplaying' && !npHasPosition() && lastSong && lastSong.app === r.app && sameTitle(lastSong, r)) {
    r = r.playing === lastSong.playing ? lastSong : { ...lastSong, elapsed: positionOf(lastSong, now), at: now, playing: r.playing };
  }
  if (r && r.source === 'nowplaying' && !npHasPosition() && r !== lastSong) r = { ...r, noPosition: true };
  if (r && r.duration >= 30 && !r.ad) lastSong = r;
  // Now Playing empties for a moment when macOS switches players; ride that out.
  if (!r) {
    if (!emptySince) emptySince = now;
    if (current && now - emptySince < 1500) return current;
  } else {
    emptySince = 0;
  }
  return r;
}

let song = { key: '', duration: null, since: 0 }; // the song the lyrics are for
let lookupTimer = null;
let shownArt = null;

function publish(r) {
  current = r;
  const isAd = !!r && (r.ad || (r.duration > 0 && r.duration < 30));
  const key = !r ? '' : isAd ? '~ad' : `${normalize(r.title)}|${normalize(r.artist)}`;
  send('np', {
    key,
    source: r ? r.source : '',
    app: r ? r.app : '',
    title: r ? r.title : '',
    artist: r ? r.artist : '',
    duration: r ? r.duration : 0,
    elapsed: r ? r.elapsed : 0,
    at: r ? r.at : Date.now(),
    rate: r ? r.rate : 1,
    playing: !!(r && r.playing),
    lead: r ? r.lead : 0,
    noPosition: !!(r && r.noPosition),
    music: !!(r && isMusicSource(r)),
    sourceId: r ? r.id : '',
    sources: sources.map((c) => ({ id: c.id, label: labelOf(c), playing: c.playing })),
    npApp: npState.bundleIdentifier || '', // who macOS would send media keys to (for the e2e test's safety check)
  });
  const art = r && r.art ? r.art : '';
  if (art && art !== shownArt) {
    shownArt = art;
    send('art', art);
  }

  if (key !== song.key) {
    song = { key, duration: null, since: Date.now() };
    clearTimeout(lookupTimer);
    send('offset', { key, value: offsets.get(key) || 0 });
    if (!r) return send('lyrics', { key, status: 'idle' });
    if (isAd) return send('lyrics', { key, status: 'ad' });
    send('lyrics', { key, status: 'loading' });
  }
  if (!r || isAd) return undefined;
  // Look up once the length is known, because the length picks the right recording; stop waiting after 3s.
  // A big change in length later (an advert ended, a different upload) is worth a second look.
  const settled = r.duration >= 30 || Date.now() - song.since > 3000;
  const changed = song.duration == null || (r.duration >= 30 && Math.abs(r.duration - song.duration) > 8);
  if (settled && changed) {
    song.duration = r.duration;
    clearTimeout(lookupTimer);
    const track = { title: r.title, artist: r.artist, album: r.album, duration: r.duration, alt: r.alt, tempo: r.tempo };
    lookupTimer = setTimeout(() => {
      lyrics.lookup(track).then(
        (result) => key === song.key && send('lyrics', { ...result, key, version: 0 }),
        () => key === song.key && send('lyrics', { key, status: 'error' }),
      );
    }, 250);
  }
  return undefined;
}

function update() {
  publish(choose(Date.now()));
}

// Play/pause/next go to whoever the lyrics come from: an extension tab gets them on its next report (≤250ms),
// anything else through macOS Now Playing.
const tabCommands = new Map();
function command(name) {
  if (current && current.source === 'extension' && current.tabId != null) {
    tabCommands.set(current.tabId, [...(tabCommands.get(current.tabId) || []), name]);
    return Promise.resolve();
  }
  return np.send(name);
}

// The extension posts each tab's player state here. Only Chrome extensions can: websites cannot add the custom
// header without a CORS preflight, which this server never approves.
const BRIDGE_PORT = Number(process.env.FL_BRIDGE_PORT) || 47231; // the e2e test uses its own
function startBridge() {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const allowed = req.headers['x-floatlyrics'] === '1' && (!origin || origin.startsWith('chrome-extension://'));
    if (req.method !== 'POST' || req.url !== '/state' || !allowed) {
      res.writeHead(403);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        if (msg.closed) tabs.delete(msg.tabId);
        else {
          const prev = tabs.get(msg.tabId);
          const st = msg.state || {};
          // When this tab started playing what it plays now, to tell which of several players is the newest.
          const restarted = !st.paused && (!prev || prev.paused || prev.title !== st.title);
          const startedAt = restarted ? Date.now() : (prev && prev.startedAt) || 0;
          tabs.set(msg.tabId, { ...st, tabId: msg.tabId, startedAt, receivedAt: Date.now() });
        }
        update();
        const commands = tabCommands.get(msg.tabId);
        tabCommands.delete(msg.tabId);
        if (commands && commands.length) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ commands }));
          return;
        }
        res.writeHead(204);
      } catch (err) {
        res.writeHead(400);
      }
      res.end();
    });
  });
  server.on('error', (err) => {
    console.warn('[FloatLyrics] extension bridge unavailable:', err.message);
    // Usually a FloatLyrics that is still quitting; try again shortly.
    if (err.code === 'EADDRINUSE') setTimeout(() => server.listen(BRIDGE_PORT, '127.0.0.1'), 3000);
  });
  server.listen(BRIDGE_PORT, '127.0.0.1');
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
  placeIsland();
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
    if (TEST) return hideForTest(settingsWin) || settingsWin.showInactive();
    settingsWin.show();
    app.focus({ steal: true });
    return undefined;
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
    acceptFirstMouse: true, // it floats over the app you are using: the first click must hit the button, not just focus
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
    hideForTest(win);
    win.showInactive();
  });
  // A double-click on the title must not zoom the window to fill the screen.
  win.on('maximize', () => win.unmaximize());
  win.on('enter-full-screen', () => win.setFullScreen(false));
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
// Where the island goes: around the notch, or (setting "Window's screen") at the top of the screen the window is
// on, as a floating pill when that screen has no notch. FL_ISLAND_PILL forces the pill (tests, screenshots).
function islandPlace() {
  const n = process.env.FL_ISLAND_PILL ? null : notch();
  const internal = screen.getAllDisplays().find((d) => d.internal && (!n || Math.abs(d.bounds.width - n.screenWidth) < 2));
  if (settings.islandScreen === 'window' && win && !win.isDestroyed()) {
    const d = screen.getDisplayMatching(windowBounds || win.getBounds());
    return { display: d, notch: n && internal && d.id === internal.id ? n : null };
  }
  return n && internal ? { display: internal, notch: n } : { display: screen.getPrimaryDisplay(), notch: null };
}
let windowBounds = null; // where the window was when it last went into the island

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
    acceptFirstMouse: true,
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
    hideForTest(island);
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
  windowBounds = win.getBounds();
  placeIsland(); // the island may live on another screen than last time
  const { display, notch: n } = islandPlace();
  const b = display.bounds;
  const w = n ? Math.round(n.width) : 200;
  const h = n ? Math.round(n.height) : 40;
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
  const h = n ? Math.round(n.height) : 40;
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

// One FloatLyrics at a time: opening it again brings the window back.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => restoreFromIsland());

app.whenReady().then(() => {
  // The packaged app gets its icon from the bundle; `npm start` borrows Electron's, so set ours.
  // Test runs stay out of the Dock so they are not mistaken for the real app.
  if (!app.isPackaged && app.dock) {
    if (process.env.FL_TEST) app.dock.hide();
    else app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }
  lyrics = createLyrics(path.join(app.getPath('userData'), 'lyrics-cache.json'));
  loadSettings();
  send('settings', settings);
  ipcMain.handle('command', (_event, name) => command(name));
  ipcMain.handle('settings:set', (_event, patch) => setSettings({ ...settings, ...patch }));
  ipcMain.handle('settings:reset', () => setSettings(looks.DEFAULTS));
  ipcMain.on('settings:open', openSettings);
  ipcMain.on('close', () => app.quit());
  // Moving the window by its title (view.js reports press and release). The window follows the real cursor,
  // read from macOS ~120 times a second; positions reported by the page lag behind a moving window.
  let moving = null;
  const stopMoving = () => {
    if (moving) clearInterval(moving.timer);
    moving = null;
  };
  ipcMain.on('move:start', () => {
    if (!win) return;
    stopMoving();
    const from = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    moving = {
      timer: setInterval(() => {
        const p = screen.getCursorScreenPoint();
        if (win && !win.isDestroyed()) win.setPosition(x + p.x - from.x, y + p.y - from.y);
      }, 8),
    };
  });
  ipcMain.on('move:end', stopMoving);
  ipcMain.on('window:minimize', minimizeToIsland);
  ipcMain.on('window:restore', restoreFromIsland);
  ipcMain.on('island:hover', (_event, inside) => island && !TEST && island.setIgnoreMouseEvents(!inside, { forward: true }));
  ipcMain.on('nudge', (_event, delta) => {
    const value = Math.round(((offsets.get(song.key) || 0) + Number(delta || 0)) * 10) / 10;
    offsets.set(song.key, value);
    send('offset', { key: song.key, value });
  });
  // ⇄: follow the next source instead (when several are open or playing).
  ipcMain.on('source:next', () => {
    if (sources.length < 2) return;
    const i = sources.findIndex((c) => current && c.id === current.id);
    pinned = sources[(i + 1) % sources.length].id;
    update();
  });
  // "Try another version": the window picks; both windows show it.
  ipcMain.on('lyrics:version', (_event, index) => {
    const l = last.lyrics;
    if (!l || !l.versions || l.key !== song.key) return;
    const i = ((Number(index) % l.versions.length) + l.versions.length) % l.versions.length;
    send('lyrics', { ...l, ...l.versions[i], status: 'synced', version: i });
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
  np.on('change', (state, diff) => {
    const playing = state.playing != null ? !!state.playing : (state.playbackRate || 0) > 0;
    if (!playing) npPlayingSince = 0;
    else if (!npPlayingSince || state.title !== npState.title) npPlayingSince = Date.now();
    npState = state;
    if ('artworkData' in diff || 'artworkMimeType' in diff) {
      npArt = state.artworkData ? `data:${state.artworkMimeType || 'image/jpeg'};base64,${state.artworkData}` : '';
    }
    update();
  });
  startBridge();
  setInterval(update, 1000); // expire silent tabs, finish waiting lookups
  // Hover, from the system cursor: the window is a drag area, and on macOS a drag area hides mouse moves from the
  // page, so CSS :hover alone would flicker the controls away as you reach for them.
  let hovering = false;
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside !== hovering) {
      hovering = inside;
      win.webContents.send('hover', inside);
    }
  }, 60);
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
