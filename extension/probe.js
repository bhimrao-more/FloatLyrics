/*
 * FloatLyrics probe — runs in the page's own JS world rather than the extension's isolated one, so it can
 * see media elements a player never attaches to the DOM and the Media Session metadata the site publishes.
 * It only observes and reports; UI lives in content.js and network in background.js.
 */
(() => {
  'use strict';
  if (window.__floatLyricsProbe) return;
  window.__floatLyricsProbe = true;

  const hostname = location.hostname;
  const site = hostname.includes('spotify')
    ? 'spotify'
    : hostname === 'music.youtube.com'
      ? 'ytmusic'
      : hostname.includes('youtube')
        ? 'youtube'
        : hostname.includes('apple')
          ? 'applemusic'
          : 'other';

  const media = new Set();
  const lastPlay = new WeakMap();
  let posState = null; // last navigator.mediaSession.setPositionState() the site made
  let domClock = null; // { shown, at }: when the on-screen clock last ticked over

  function watch(el) {
    if (media.has(el)) return;
    media.add(el);
    for (const type of ['playing', 'pause', 'seeked', 'ratechange', 'durationchange', 'loadedmetadata', 'emptied', 'ended']) {
      el.addEventListener(type, () => {
        if (type === 'playing') lastPlay.set(el, performance.now());
        report();
      });
    }
  }

  // Players such as Spotify's create their <video>/<audio> in JS and never insert it, so querySelector
  // cannot find it. Every element still has to go through play().
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play() {
    try {
      watch(this);
      lastPlay.set(this, performance.now());
    } catch (err) {}
    return nativePlay.apply(this, arguments);
  };

  const session = navigator.mediaSession;
  // The handlers the site registers for media keys (play, pause, next…), so the desktop app can use them too.
  const handlers = new Map();
  if (session && typeof session.setActionHandler === 'function') {
    const nativeHandler = session.setActionHandler.bind(session);
    session.setActionHandler = (action, fn) => {
      try {
        if (fn) handlers.set(action, fn);
        else handlers.delete(action);
      } catch (err) {}
      return nativeHandler(action, fn);
    };
  }
  if (session && typeof session.setPositionState === 'function') {
    const nativeSet = session.setPositionState.bind(session);
    session.setPositionState = (state) => {
      try {
        posState = state
          ? { duration: state.duration, position: state.position || 0, rate: state.playbackRate || 1, at: performance.now() }
          : null;
      } catch (err) {}
      return nativeSet(state);
    };
  }

  function activeMedia() {
    // youtube.com also plays muted hover previews of other videos; only the main player counts there.
    if (site === 'youtube') {
      const main = document.querySelector('#movie_player video');
      if (main) watch(main);
      return main;
    }
    for (const el of document.querySelectorAll('audio, video')) watch(el);
    let best = null;
    let bestScore = -1;
    for (const el of media) {
      const playing = !el.paused && !el.ended && el.readyState >= 2;
      const score = (playing ? 1e12 : 0) + (lastPlay.get(el) || 0) + (el.currentTime > 0 ? 1 : 0);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  // "1:23", "1:02:03", "-0:45" (time remaining) -> seconds
  function parseClock(text) {
    const m = String(text || '').trim().match(/^([-−])?(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const v = Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
    return m[1] ? -v : v;
  }

  const text = (sel, scope) => {
    const node = (scope || document).querySelector(sel);
    return node ? node.textContent.trim() : '';
  };

  // What the player's own UI shows. Used as a fallback, and on Spotify as a cross-check.
  function readDom() {
    if (site === 'spotify') {
      const pos = parseClock(text('[data-testid="playback-position"]'));
      let dur = parseClock(text('[data-testid="playback-duration"]'));
      if (dur != null && dur < 0 && pos != null) dur = pos - dur;
      const artists = [...document.querySelectorAll('[data-testid="context-item-info-artist"]')].map((a) => a.textContent.trim());
      const ad = !!document.querySelector('[data-testid="context-item-info-ad-subtitle"]');
      return { pos, dur, ad, title: text('[data-testid="context-item-info-title"]'), artist: artists.join(', '), album: '' };
    }
    if (site === 'ytmusic') {
      const bar = document.querySelector('ytmusic-player-bar');
      if (!bar) return {};
      const [pos, dur] = text('.time-info', bar).split('/').map(parseClock);
      const byline = text('.byline', bar).split('•').map((s) => s.trim());
      const ad = !!document.querySelector('.html5-video-player.ad-showing');
      return { pos, dur, ad, title: text('.title', bar), artist: byline[0] || '', album: byline.length >= 3 ? byline[1] : '' };
    }
    if (site === 'youtube') {
      if (!location.pathname.startsWith('/watch')) return { off: true };
      const ad = !!document.querySelector('#movie_player.ad-showing');
      return { ad, title: text('ytd-watch-metadata h1'), artist: text('ytd-watch-metadata ytd-channel-name a'), album: '' };
    }
    return {};
  }

  function snapshot() {
    const now = performance.now();
    const md = session && session.metadata;
    const sessionState = session ? session.playbackState : 'none';
    const dom = readDom();
    const el = activeMedia();

    if (dom.pos != null) {
      if (!domClock || domClock.shown !== dom.pos) domClock = { shown: dom.pos, at: now };
    } else {
      domClock = null;
    }

    let position = null;
    let duration = 0;
    let paused = true;
    let rate = 1;
    let src = 'none';

    const elReady = !!el && Number.isFinite(el.currentTime) && (el.readyState > 0 || !!el.currentSrc);
    // Spotify's media element does not always share the track's timeline, so there it is only trusted
    // while it agrees with the clock the player shows.
    const agrees = dom.pos == null || (elReady && Math.abs(el.currentTime - dom.pos) <= 2.5);
    if (elReady && (site !== 'spotify' || agrees)) {
      position = el.currentTime;
      paused = el.paused || el.ended;
      rate = el.playbackRate || 1;
      src = 'media';
      if (Number.isFinite(el.duration) && el.duration > 0) duration = el.duration;
    } else if (dom.pos != null) {
      const sinceTick = now - domClock.at;
      paused = sessionState === 'paused' || (sessionState !== 'playing' && sinceTick > 1600);
      position = dom.pos + (paused ? 0 : Math.min(sinceTick / 1000, 0.99));
      src = 'dom';
    } else if (posState) {
      paused = sessionState === 'paused';
      rate = posState.rate;
      position = posState.position + (paused ? 0 : ((now - posState.at) / 1000) * rate);
      src = 'session';
    }

    if (site === 'spotify' && dom.dur > 0) duration = dom.dur;
    if (!duration && dom.dur > 0) duration = dom.dur;
    if (!duration && posState && Number.isFinite(posState.duration) && posState.duration > 0) duration = posState.duration;

    // Off a watch page youtube.com keeps the last video's Media Session around; there is no song then.
    if (dom.off) return { site, title: '', artist: '', album: '', artwork: '', ad: false, duration: 0, position: 0, hasPosition: false, paused: true, rate: 1, src: 'none', at: now };

    const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    return {
      site,
      title: (md && md.title) || dom.title || '',
      artist: (md && md.artist) || dom.artist || '',
      album: (md && md.album) || dom.album || '',
      artwork: art || '',
      ad: !!dom.ad,
      duration,
      position: position == null ? 0 : position,
      hasPosition: position != null,
      paused,
      rate,
      src,
      at: now,
    };
  }

  function report() {
    try {
      document.dispatchEvent(new CustomEvent('floatlyrics:state', { detail: JSON.stringify(snapshot()) }));
    } catch (err) {}
  }

  // Commands from the FloatLyrics desktop app (via content.js). The site's own media-key handlers do it best.
  document.addEventListener('floatlyrics:command', (e) => {
    try {
      const name = String(e.detail);
      const el = activeMedia();
      const handler = (action) => handlers.get(action);
      if (name === 'toggle') {
        const paused = el ? el.paused : session && session.playbackState === 'paused';
        const action = paused ? 'play' : 'pause';
        if (handler(action)) handler(action)({ action });
        else if (el) paused ? el.play() : el.pause();
      } else if (name === 'next' || name === 'previous') {
        const action = name === 'next' ? 'nexttrack' : 'previoustrack';
        if (handler(action)) handler(action)({ action });
      }
      setTimeout(report, 150);
    } catch (err) {}
  });

  setInterval(report, 250);
})();
