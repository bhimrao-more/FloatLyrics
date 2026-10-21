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
const { normalize, videoTrack, captionLyrics, captionsUsable } = require('../extension/core.js');
const looks = require('./renderer/looks.js');

// For the e2e test: a DevTools port to drive the window, and a throwaway settings folder. Test copies are
// invisible and click-through (FL_TEST), so nobody mistakes them for the real app or clicks them by accident.
const TEST = !!process.env.FL_TEST;
// FL_NO_NOWPLAYING: follow only the extension's test tab; never read or control macOS Now Playing, so a test run
// can never touch the music you are listening to.
const NO_NOWPLAYING = !!process.env.FL_NO_NOWPLAYING;
const hideForTest = (w) => {
  if (!TEST) return;
  w.setOpacity(0);
  w.setIgnoreMouseEvents(true);
  w.webContents.setAudioMuted(true); // no test crackle in your speakers
};
if (process.env.FL_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.FL_DEBUG_PORT);
if (process.env.FL_USER_DATA) app.setPath('userData', process.env.FL_USER_DATA);
// The record crackle (vinyl.js) starts with the music, not with a click in the window.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Browsers report web players as they are: YouTube video titles, channel names as artists.
const BROWSER = /^(com\.google\.chrome|com\.apple\.safari|company\.thebrowser|com\.microsoft\.edgemac|com\.brave\.browser|org\.mozilla\.firefox|com\.operasoftware|com\.vivaldi)/i;
// Chrome hands Now Playing a position ~0.2s behind the page's own clock (measured), so lead it by that much.
const leadFor = (bundle) => (/^com\.google\.chrome/i.test(bundle) ? 0.2 : 0);

const np = new NowPlaying();
let lyrics;
let win = null; // the floating lyrics window: the app itself
let settingsWin = null;
let settings = looks.DEFAULTS;
const last = {}; // latest message per channel, replayed when a window (re)loads
const offsets = new Map(); // the user's timing nudge per song, shared by the window and the island, kept on disk
const offsetsFile = () => path.join(app.getPath('userData'), 'offsets.json');
let offsetsTimer = null;
function saveOffsets() {
  clearTimeout(offsetsTimer);
  offsetsTimer = setTimeout(() => {
    const entries = [...offsets].filter(([, v]) => v !== 0).slice(-500);
    fs.writeFile(offsetsFile(), JSON.stringify(Object.fromEntries(entries)), () => {});
  }, 800);
}

// A small local log of what the app followed and showed (userData/diagnostics.log, under 512KB, one older file
// kept), so an odd moment can be looked into afterwards. Nothing leaves the Mac.
function diag(event, data) {
  try {
    const file = path.join(app.getPath('userData'), 'diagnostics.log');
    try {
      if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.1`);
    } catch (err) {}
    fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`, () => {});
  } catch (err) {}
}

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
// Chrome runs a hidden, silent tab's timers about once a minute, so a paused tab in the background reports
// rarely. It is still the player you paused: keep following it rather than fall back to Now Playing.
const TAB_PAUSED_FRESH_MS = 120000;
let lastSong = null; // the last real song (≥ 30s), to see through YouTube's short pause ads
let current = null; // the report on screen
let emptySince = 0;
let npPlayingSince = 0; // when Now Playing started playing its current item

// Chrome sometimes reports a playing web player with no length and no clock at all (position stuck at 0).
const npHasPosition = () => !!(npState.timestampEpochMicros || npState.durationMicros);
const positionOf = (r, now) => r.elapsed + (r.playing ? Math.max(0, ((now - r.at) / 1000) * r.rate) : 0);
const sameTitle = (a, b) => !!a && !!b && normalize(a.title) === normalize(b.title);
// Now Playing shows a youtube.com tab by its video title; the tab's report has the song's (rawTitle is the video's).
const sameTab = (t, n) => sameTitle(t, n) || (!!t.rawTitle && normalize(t.rawTitle) === normalize(n.title));

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
    if (now - t.receivedAt > (t.paused ? TAB_PAUSED_FRESH_MS : TAB_FRESH_MS)) {
      tabs.delete(id);
      continue;
    }
    if (!t.title && !t.ad) continue;
    out.push({
      id: `tab:${id}`,
      tabId: id,
      site: t.site || 'web',
      title: t.title || '',
      rawTitle: t.rawTitle || '',
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
      captions: t.site === 'youtube' && t.captions && t.captions.videoId === t.videoId ? t.captions : null,
    });
  }
  return out;
}

// Everything that could be followed right now. Now Playing joins unless it is just one of the tabs again.
// YouTube plays a muted preview when the pointer rests on a thumbnail, and Chrome lists it in Now Playing: a clip
// of a few seconds, or of no length at all. Not something to follow away from your song. (A short clip under the
// song's own title is a pause advert; choose() handles that. With no extension, Chrome sometimes reports a real
// song with no length, so a clip without one counts as a preview only while the extension reports the tabs.)
const isPreview = (n) =>
  BROWSER.test(n.app) && !(lastSong && sameTitle(lastSong, n)) && ((n.duration > 0 && n.duration < 30) || (!(n.duration > 0) && tabs.size > 0));

function candidates(now) {
  const list = tabReports(now);
  let n = nowPlayingReport();
  if (n && isPreview(n)) n = null;
  if (n && !(BROWSER.test(n.app) && list.some((t) => sameTab(t, n)))) list.push({ ...n, id: 'np', startedAt: npPlayingSince });
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

let song = { key: '', duration: null, since: 0, found: null, captions: '' }; // the song the lyrics are for
let lookupTimer = null;

// Look the song up; if LRCLIB could not be reached (rate limit, network), try again on its own while the song plays
// (after 3, 6, 15, 30 and 60s) rather than leave the song without lyrics until it is played again.
const RETRY_S = [3, 6, 15, 30, 60];
function lookupSong(track, key, attempt) {
  const retry = () => {
    if (key !== song.key || attempt >= RETRY_S.length) return;
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(() => key === song.key && lookupSong(track, key, attempt + 1), RETRY_S[attempt] * 1000);
  };
  lyrics.lookup(track).then(
    (result) => {
      if (key !== song.key) return;
      song.found = result;
      showLyrics();
      if (result.status === 'error') retry();
    },
    () => {
      if (key !== song.key) return;
      song.found = { status: 'error' };
      showLyrics();
      retry();
    },
  );
}
let shownArt = null;

// The lyrics for the song, once the lookup is back. On youtube.com the video's own captions lead when they are
// the lyrics (timed to this very video: its intro, scenes and edit); the recordings found online follow as other
// versions, and are what is shown when the captions are something else.
function showLyrics() {
  const found = song.found;
  if (!found) return;
  const caps = current && current.captions;
  song.captions = caps ? `${caps.videoId}|${caps.lang}` : '';
  let out = found;
  if (caps) {
    const ref = (found.status === 'synced' || found.status === 'plain') && found.lines ? found.lines : null;
    const c = captionLyrics(caps.cues, ref);
    if (captionsUsable(c)) {
      const own = {
        lines: c.lines,
        approx: false,
        source: { provider: 'YouTube', title: current.title, artist: current.artist, album: "This video's captions", duration: current.duration },
      };
      const others = found.status === 'synced' ? found.versions || [{ lines: found.lines, approx: found.approx, source: found.source }] : [];
      out = { ...found, ...own, status: 'synced', versions: [own, ...others].slice(0, 5) };
    }
  }
  const sung = (out.lines || []).filter((l) => l.text && l.t >= 0);
  diag('lyrics', { key: song.key, status: out.status, provider: out.source && out.source.provider, id: out.source && out.source.id, duration: out.source && out.source.duration, first: sung.length ? sung[0].t : null, last: sung.length ? sung[sung.length - 1].t : null, versions: (out.versions || []).length });
  send('lyrics', { ...out, key: song.key, version: 0 });
}

let followed = '';
let followedLogAt = 0;
function publish(r) {
  current = r;
  // What is followed, in the diagnostics: on every change of source, song or play state, and every 10s.
  const now = Date.now();
  const follow = r ? `${r.id}|${r.title}|${r.playing}|${r.ad}` : '';
  if (follow !== followed || now - followedLogAt > 10000) {
    followed = follow;
    followedLogAt = now;
    diag('follow', r ? {
      source: r.id, label: labelOf(r), title: r.title, artist: r.artist, playing: !!r.playing, ad: !!r.ad,
      position: Math.round(positionOf(r, now) * 10) / 10, duration: Math.round(r.duration || 0), clockAge: Math.round((now - r.at) / 100) / 10,
      noPosition: !!r.noPosition, sources: sources.map((c) => `${c.id}:${c.playing ? 'playing' : 'paused'}`).join(' '),
    } : { source: null, sources: sources.map((c) => c.id).join(' ') });
  }
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
    if (art.startsWith('data:')) send('art', art);
    else artAsData(art).then((data) => shownArt === art && send('art', data || art));
  }

  if (key !== song.key) {
    song = { key, duration: null, since: Date.now(), found: null, captions: '' };
    clearTimeout(lookupTimer);
    send('offset', { key, value: offsets.get(key) || 0 });
    if (!r) return send('lyrics', { key, status: 'idle' });
    if (isAd) return send('lyrics', { key, status: 'ad' });
    send('lyrics', { key, status: 'loading' });
  }
  if (!r || isAd) return undefined;
  // The video's captions arrived (or changed) after the lyrics were shown: show them again with the captions.
  const caps = r.captions ? `${r.captions.videoId}|${r.captions.lang}` : '';
  if (song.found && caps !== song.captions) showLyrics();
  // Look up once the length is known, because the length picks the right recording; stop waiting after 3s.
  // A big change in length later (an advert ended, a different upload) is worth a second look.
  const settled = r.duration >= 30 || Date.now() - song.since > 3000;
  const changed = song.duration == null || (r.duration >= 30 && Math.abs(r.duration - song.duration) > 8);
  if (settled && changed) {
    song.duration = r.duration;
    clearTimeout(lookupTimer);
    const track = { title: r.title, artist: r.artist, album: r.album, duration: r.duration, alt: r.alt, tempo: r.tempo };
    lookupTimer = setTimeout(() => lookupSong(track, key, 0), 250);
  }
  return undefined;
}

function update() {
  publish(choose(Date.now()));
}

// Covers from web players live on other sites (YouTube, Spotify), and a page cannot read the colours of an
// image from another site. Fetched here and handed over as data, the island can tint its ring, equaliser and
// karaoke fill from the cover.
const artCache = new Map();
async function artAsData(url) {
  if (artCache.has(url)) return artCache.get(url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return null;
    const data = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    artCache.set(url, data);
    if (artCache.size > 20) artCache.delete(artCache.keys().next().value);
    return data;
  } catch (err) {
    return null;
  }
}

// Play/pause/next go to whoever the lyrics come from: an extension tab gets them on its next report (≤250ms),
// anything else through macOS Now Playing.
const tabCommands = new Map();
function command(name) {
  if (current && current.source === 'extension' && current.tabId != null) {
    tabCommands.set(current.tabId, [...(tabCommands.get(current.tabId) || []), name]);
    return Promise.resolve();
  }
  return NO_NOWPLAYING ? Promise.resolve() : np.send(name);
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
      if (body.length > 256 * 1024) req.destroy();
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
          // A YouTube video's own captions come once (and now and then again); keep them while it plays.
          const captions = st.captions || (prev && prev.captions && st.videoId && prev.captions.videoId === st.videoId ? prev.captions : null);
          tabs.set(msg.tabId, { ...st, captions, tabId: msg.tabId, startedAt, receivedAt: Date.now() });
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
  applyIslandGlass(); // the glass tint follows the theme
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
    height: 820,
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
  // With "Same screen as the window", have the island ready on whichever screen the window moved to.
  let placeTimer = null;
  win.on('moved', () => {
    if (settings.islandScreen !== 'window' || islandActive) return;
    clearTimeout(placeTimer);
    placeTimer = setTimeout(placeIsland, 500);
  });
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

// Every screen as AppKit sees it: its name and, on MacBooks, the notch (Electron knows neither). Matched to
// Electron's displays by position and size. Asked once, and again when screens change.
let screensCache = null;
function screenInfo() {
  if (screensCache) return screensCache;
  screensCache = [];
  try {
    const out = execFileSync(
      'osascript',
      ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); const r = []; const s = $.NSScreen.screens; const H = s.objectAtIndex(0).frame.size.height; for (let i = 0; i < s.count; i++) { const c = s.objectAtIndex(i); const f = c.frame; r.push({ name: c.localizedName.js, x: f.origin.x, y: H - f.origin.y - f.size.height, w: f.size.width, h: f.size.height, top: c.safeAreaInsets.top, left: c.auxiliaryTopLeftArea.size.width, right: c.auxiliaryTopRightArea.size.width }); } JSON.stringify(r)'],
      { encoding: 'utf8', timeout: 5000 },
    );
    screensCache = JSON.parse(out);
  } catch (err) {}
  return screensCache;
}
const appKitScreen = (d) => screenInfo().find((s) => Math.abs(s.x - d.bounds.x) < 2 && Math.abs(s.y - d.bounds.y) < 2 && Math.abs(s.w - d.bounds.width) < 2);
// The notch on this display as { width, height }, or null. FL_ISLAND_PILL pretends there is none (tests).
function notchOf(d) {
  if (process.env.FL_ISLAND_PILL) return null;
  const s = appKitScreen(d);
  return s && s.top > 0 && s.left > 0 && s.right > 0 ? { width: s.w - s.left - s.right, height: s.top } : null;
}
const nameOf = (d) => (appKitScreen(d) || {}).name || d.label || (d.internal ? 'Built-in Display' : `Display ${d.id}`);

let windowBounds = null; // where the window was when it last went into the island

// Where the island goes (Settings → Island appears on): around the notch, on the window's screen, or on one
// chosen screen. Any screen without a notch gets the glass island.
function islandPlace(pick = settings.islandScreen, name = settings.islandScreenName) {
  const all = screen.getAllDisplays();
  let d = null;
  if (pick === 'window' && win && !win.isDestroyed()) d = screen.getDisplayMatching(win.isVisible() && !animating ? win.getBounds() : windowBounds || win.getBounds());
  else if (pick.startsWith('display:')) d = all.find((x) => `display:${x.id}` === pick) || all.find((x) => nameOf(x) === name) || null;
  if (!d) d = all.find(notchOf) || screen.getPrimaryDisplay();
  return { display: d, notch: notchOf(d) };
}

// The choices for Settings, each with the screen it means right now.
function islandScreens() {
  const all = screen.getAllDisplays();
  const at = (id) => {
    const { display, notch: n } = islandPlace(id, '');
    return { bounds: display.bounds, notch: !!n, screen: nameOf(display) };
  };
  const notched = all.find(notchOf);
  return [
    { id: 'notch', label: notched ? 'MacBook notch' : 'Main screen', ...at('notch') },
    { id: 'window', label: 'Same screen as the window', ...at('window') },
    ...all.map((d) => ({ id: `display:${d.id}`, label: nameOf(d), name: nameOf(d), bounds: d.bounds, notch: !!notchOf(d), screen: nameOf(d) })),
  ];
}

const ISLAND_W = 640; // the notch island lives in a large, click-through window
const ISLAND_H = 240;
// Screens without a notch get a glass island instead: the window takes the island's own size, wears native macOS
// glass, and sits GLASS_R above the top edge so its top corners are hidden and it hangs from the top. (A version
// with notch-like curves into the top edge was tried on 2026-10-20; the user preferred this one.)
const GLASS_R = 16;
const GLASS_ROW_H = 38;

let island = null; // the island window; one kind (notch or glass) for its whole life
let islandKind = '';
let islandAt = null; // { display, notch } it is placed on
let islandLoaded = false;
let islandReady = false; // its page has laid itself out for this kind and screen
let islandWanted = false; // glass: the page has something to show
let islandShown = false;
let islandActive = false;
let islandSize = { w: 200, h: GLASS_ROW_H };

function islandGeo() {
  const n = islandAt && islandAt.notch;
  const glass = islandKind === 'glass';
  return {
    active: islandActive,
    hasNotch: !!n,
    notchWidth: n ? n.width : 0,
    notchHeight: n ? n.height : 0,
    glass,
    inset: glass ? GLASS_R : 0,
    rowHeight: GLASS_ROW_H,
    shown: islandShown,
  };
}

// Straight to the island, never broadcast or replayed: a new island must only ever hear about its own screen.
function sendIsland() {
  if (island && !island.isDestroyed() && islandLoaded) island.webContents.send('island', islandGeo());
}

function glassBounds() {
  const b = islandAt.display.bounds;
  const width = Math.round(islandSize.w);
  return { x: Math.round(b.x + b.width / 2 - width / 2), y: b.y - GLASS_R, width, height: Math.round(islandSize.h) + GLASS_R };
}

// The glass island resizes on a spring (stiffness 380, damping 27: a touch of overshoot, like iPhone's island),
// stepped here; the glass follows the window.
let spring = null;
function stopSpring() {
  if (spring) clearInterval(spring.timer);
  spring = null;
}
function setGlass(rect) {
  island.setBounds(rect);
}
function springTo(to) {
  if (!spring) {
    const from = island.getBounds();
    spring = { w: from.width, h: from.height, vw: 0, vh: 0, timer: null };
  }
  spring.to = to;
  if (spring.timer) return;
  let then = Date.now();
  spring.timer = setInterval(() => {
    if (!island || island.isDestroyed()) return stopSpring();
    const now = Date.now();
    const dt = Math.min(0.05, (now - then) / 1000);
    then = now;
    const steps = Math.max(1, Math.ceil(dt / 0.004));
    for (let i = 0; i < steps; i++) {
      const h = dt / steps;
      for (const [p, v, k] of [['w', 'vw', 'width'], ['h', 'vh', 'height']]) {
        spring[v] += (-380 * (spring[p] - spring.to[k]) - 27 * spring[v]) * h;
        spring[p] += spring[v] * h;
      }
    }
    const t = spring.to;
    const done = Math.abs(spring.w - t.width) < 0.5 && Math.abs(spring.h - t.height) < 0.5 && Math.abs(spring.vw) < 8 && Math.abs(spring.vh) < 8;
    const w = done ? t.width : Math.round(spring.w);
    setGlass({ x: Math.round(t.x + t.width / 2 - w / 2), y: t.y, width: w, height: done ? t.height : Math.round(spring.h) });
    if (done) stopSpring();
    return undefined;
  }, 16);
}

function setIslandBounds(animate) {
  if (!island || island.isDestroyed()) return;
  if (islandKind === 'notch') {
    const b = islandAt.display.bounds;
    island.setBounds({ x: Math.round(b.x + b.width / 2 - ISLAND_W / 2), y: b.y, width: ISLAND_W, height: ISLAND_H });
    return;
  }
  const to = glassBounds();
  if (animate && island.isVisible() && island.getBounds().y === to.y) springTo(to);
  else {
    stopSpring();
    setGlass(to);
  }
}

// Native glass for the glass island, tinted to suit the theme (light glass for the Light theme).
function applyIslandGlass() {
  if (!island || islandKind !== 'glass') return;
  try {
    const mod = require('electron-liquid-glass');
    (mod.default || mod).addView(island.getNativeWindowHandle(), {
      cornerRadius: GLASS_R,
      tintColor: settings.theme === 'light' ? '#ffffff40' : '#0c0c1020',
    });
  } catch (err) {
    try {
      island.setVibrancy('hud');
    } catch (e) {}
  }
}

// Glass fades in and out; the notch island is always there, black inside the black notch.
let fadeTimer = null;
function fadeIsland(show) {
  clearInterval(fadeTimer);
  const w = island;
  if (TEST || islandKind !== 'glass') {
    if (show) w.showInactive();
    else w.hide();
    return;
  }
  if (show) {
    w.setOpacity(0);
    w.showInactive();
  }
  const from = w.getOpacity();
  const t0 = Date.now();
  fadeTimer = setInterval(() => {
    if (w.isDestroyed()) return clearInterval(fadeTimer);
    const k = Math.min(1, (Date.now() - t0) / (show ? 180 : 140));
    w.setOpacity(from + ((show ? 1 : 0) - from) * k);
    if (k === 1) {
      clearInterval(fadeTimer);
      if (!show) w.hide();
    }
    return undefined;
  }, 16);
}

function syncIsland() {
  if (!island || island.isDestroyed()) return;
  const show = islandReady && (islandKind === 'notch' || (islandActive && islandWanted));
  if (show === islandShown) return;
  islandShown = show;
  fadeIsland(show);
  sendIsland();
}

// A fresh island window of the right kind for this screen. The old one goes at once; the new one shows only
// when its page has laid itself out, so a half-made island is never on screen.
function createIsland(place) {
  if (island && !island.isDestroyed()) island.destroy();
  stopSpring();
  clearInterval(fadeTimer);
  islandAt = place;
  islandKind = place.notch ? 'notch' : 'glass';
  islandLoaded = false;
  islandReady = false;
  islandWanted = false;
  islandShown = false;
  const glass = islandKind === 'glass';
  const w = new BrowserWindow({
    width: glass ? islandSize.w : ISLAND_W,
    height: glass ? islandSize.h : ISLAND_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: glass,
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
  island = w;
  // Above the menu bar, on every Space, over full-screen apps.
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // The notch island lives in a large transparent window: clicks pass through except on the island itself.
  if (!glass) w.setIgnoreMouseEvents(true, { forward: true });
  w.webContents.on('did-finish-load', () => {
    if (island !== w) return;
    islandLoaded = true;
    replay(w);
    applyIslandGlass();
    setIslandBounds(false);
    hideForTest(w);
    sendIsland(); // the page lays itself out for this screen, then says island:ready
  });
  w.on('closed', () => {
    if (island === w) island = null;
  });
  w.loadFile(path.join(__dirname, 'renderer', 'island.html'));
}

function placeIsland() {
  if (!app.isReady()) return;
  const place = islandPlace();
  const kind = place.notch ? 'notch' : 'glass';
  if (!island || island.isDestroyed() || kind !== islandKind) {
    createIsland(place);
    return;
  }
  islandAt = place;
  setIslandBounds(false);
  sendIsland();
}

function setIslandActive(on) {
  islandActive = on;
  if (on) placeIsland();
  sendIsland();
  syncIsland();
}

let animating = false; // window bounds are mid-animation; do not save them

// Where the window shrinks to and grows from: the notch, or the top centre of the island's screen.
function islandSlot() {
  const { display, notch: n } = islandAt || islandPlace();
  const b = display.bounds;
  const w = n ? Math.round(n.width) : 200;
  const h = n ? Math.round(n.height) : 40;
  return { x: Math.round(b.x + b.width / 2 - w / 2), y: b.y, width: w, height: h };
}

// The window shrinks into the island and hides; the island takes over the lyrics.
function minimizeToIsland() {
  if (!win || !win.isVisible() || animating) return;
  if (!settings.island) return win.minimize();
  windowBounds = win.getBounds();
  setIslandActive(true); // places the island first: it may live on another screen than last time
  const saved = win.getBounds();
  animating = true;
  win.setMinimumSize(1, 1);
  win.setBounds(islandSlot(), true);
  setTimeout(() => {
    if (win) {
      win.hide();
      win.setBounds(saved);
      win.setMinimumSize(220, 90);
    }
    animating = false;
  }, 340);
}

// The window grows back out of the island; the island tucks away.
function restoreFromIsland() {
  if (!win) return createWindow();
  setIslandActive(false);
  if (win.isMinimized()) return win.restore();
  if (win.isVisible() || animating) return undefined;
  const target = win.getBounds();
  animating = true;
  win.setMinimumSize(1, 1);
  win.setBounds(islandSlot());
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
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(offsetsFile(), 'utf8')))) offsets.set(k, Number(v) || 0);
  } catch (err) {}
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
  // The vinyl sounds (app/assets/sounds), handed to the window as bytes.
  ipcMain.handle('sound:get', (_event, name) => {
    if (!/^[a-z-]+$/.test(String(name))) throw new Error('bad sound name');
    return fs.readFileSync(path.join(__dirname, 'assets', 'sounds', `${name}.mp3`));
  });
  ipcMain.on('window:minimize', minimizeToIsland);
  ipcMain.on('window:restore', restoreFromIsland);
  const fromIsland = (event) => !!island && !island.isDestroyed() && event.sender === island.webContents;
  ipcMain.on('island:hover', (event, inside) => fromIsland(event) && !TEST && islandKind === 'notch' && island.setIgnoreMouseEvents(!inside, { forward: true }));
  // The island's page has laid itself out for its screen: it may be shown.
  // What the island shows, when it changes (island.js), for the diagnostics.
  ipcMain.on('island:diag', (event, data) => fromIsland(event) && diag('island', data && typeof data === 'object' ? data : {}));
  ipcMain.on('island:ready', (event) => {
    if (!fromIsland(event)) return;
    islandReady = true;
    syncIsland();
  });
  // The glass island asks for its size, and says whether it has anything to show; the window springs to it.
  ipcMain.on('island:size', (event, w, h, show) => {
    if (!fromIsland(event) || islandKind !== 'glass') return;
    islandSize = { w: Math.max(80, Math.min(720, Number(w) || 200)), h: Math.max(GLASS_ROW_H, Math.min(220, Number(h) || GLASS_ROW_H)) };
    islandWanted = !!show;
    setIslandBounds(islandShown);
    syncIsland();
  });
  ipcMain.handle('displays', () => islandScreens());
  ipcMain.on('nudge', (_event, delta) => {
    const value = Math.round(((offsets.get(song.key) || 0) + Number(delta || 0)) * 10) / 10;
    offsets.delete(song.key); // re-insert so the most recently fixed songs are the ones kept
    offsets.set(song.key, value);
    saveOffsets();
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
    const keys = Object.keys(diff).filter((k) => !/^artwork/.test(k));
    if (keys.length) {
      diag('nowplaying', {
        changed: keys.join(','), app: state.bundleIdentifier, title: state.title, playing: state.playing, rate: state.playbackRate,
        elapsed: state.elapsedTimeMicros != null ? Math.round(state.elapsedTimeMicros / 1e5) / 10 : null,
        clockAge: state.timestampEpochMicros ? Math.round((Date.now() - state.timestampEpochMicros / 1000) / 100) / 10 : null,
        duration: state.durationMicros ? Math.round(state.durationMicros / 1e6) : null,
      });
    }
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
  if (!NO_NOWPLAYING) np.start();
  createWindow();
  placeIsland();
  // Screens come and go (a monitor plugged in, the lid closed): find the island's place again, and tell Settings.
  let displayTimer = null;
  for (const evt of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(evt, () => {
      clearTimeout(displayTimer);
      displayTimer = setTimeout(() => {
        screensCache = null;
        placeIsland();
        if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('displays', islandScreens());
      }, 300);
    });
  }
});

// Clicking the Dock icon brings the window back from the notch.
app.on('activate', () => restoreFromIsland());
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => np.stop());
