/*
 * FloatLyrics content script (isolated world) — takes the player state probe.js reports, asks the service
 * worker for lyrics when the track changes, and renders them in an always-on-top Document Picture-in-Picture
 * window (falling back to an in-page panel where that API is missing).
 */
(() => {
  'use strict';
  if (window.__floatLyricsContent) return;
  window.__floatLyricsContent = true;

  const { indexAt, normalize } = globalThis.FloatLyricsCore;

  const MESSAGES = {
    idle: 'Play a song to see lyrics',
    loading: 'Finding lyrics…',
    none: 'No lyrics found for this track',
    ad: 'Ad break — lyrics return with the music',
    instrumental: '♪ Instrumental',
    error: 'Could not reach the lyrics service',
    stale: 'FloatLyrics was updated — reload this tab',
  };

  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", sans-serif';

  const UI_CSS = `
    html, body { height: 100%; margin: 0; background: #0c0c10; }
    .fl { --fg: #fff; --dim: rgba(255,255,255,.38); box-sizing: border-box; display: flex; flex-direction: column;
      width: 100%; height: 100%; overflow: hidden; background: #0c0c10; color: var(--fg); font: 500 14px/1.35 ${FONT}; }
    .fl * { box-sizing: border-box; }
    .fl-head { flex: none; display: flex; gap: 6px; align-items: baseline; padding: 8px 12px 0; font-size: 11px;
      color: var(--dim); white-space: nowrap; }
    .fl-title { color: rgba(255,255,255,.82); overflow: hidden; text-overflow: ellipsis; }
    .fl-artist { flex-shrink: 3; overflow: hidden; text-overflow: ellipsis; }
    .fl-body { flex: 1; min-height: 0; position: relative; container-type: size; }
    .fl-lines { position: absolute; inset: 0; overflow-y: auto; scrollbar-width: none; padding: 50cqh 14px; text-align: center;
      -webkit-mask-image: linear-gradient(transparent, #000 24%, #000 76%, transparent);
      mask-image: linear-gradient(transparent, #000 24%, #000 76%, transparent); }
    .fl-lines::-webkit-scrollbar { display: none; }
    .fl-line { margin: 0; padding: .28em 0; font-size: clamp(13px, 5.4cqw, 34px); font-weight: 700; line-height: 1.25;
      color: var(--dim); transform: scale(.94); transition: color .25s ease, transform .25s ease; overflow-wrap: anywhere; }
    .fl-line.is-active { color: var(--fg); transform: scale(1); }
    .fl.is-plain .fl-lines { padding-block: 12px; -webkit-mask-image: none; mask-image: none; }
    .fl.is-plain .fl-line { color: rgba(255,255,255,.82); font-size: clamp(12px, 4cqw, 20px); font-weight: 500; transform: none; }
    .fl-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 12px;
      text-align: center; color: var(--dim); font-size: clamp(12px, 4.4cqw, 20px); }
    .fl-lines[hidden], .fl-msg[hidden] { display: none; }
    .fl-foot { flex: none; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 2px 8px 6px;
      font-size: 11px; color: var(--dim); opacity: 0; transition: opacity .15s ease; }
    .fl:hover .fl-foot, .fl-foot:focus-within { opacity: 1; }
    .fl-btn { padding: 3px 8px; border: 1px solid rgba(255,255,255,.2); border-radius: 999px; background: transparent;
      color: rgba(255,255,255,.8); font: inherit; cursor: pointer; }
    .fl-btn:hover { background: rgba(255,255,255,.12); }
    .fl-source { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (max-height: 120px) { .fl-head, .fl-foot { display: none; } }
  `;

  const HOST_CSS = `
    :host { all: initial; }
    .fl-launch { position: fixed; right: 18px; bottom: 112px; z-index: 2147483647; padding: 8px 12px;
      border: 1px solid rgba(255,255,255,.18); border-radius: 999px; background: rgba(18,18,22,.88); color: #fff;
      font: 600 12px/1 ${FONT}; cursor: pointer; opacity: .72; transition: opacity .15s ease; }
    .fl-launch:hover, .fl-launch:focus-visible { opacity: 1; }
    .fl-panel { position: fixed; right: 18px; bottom: 160px; z-index: 2147483647; width: 360px; height: 200px;
      min-width: 200px; min-height: 80px; border-radius: 12px; overflow: hidden; resize: both;
      box-shadow: 0 12px 40px rgba(0,0,0,.5); }
  `;

  const AD = '~ad'; // stands in for a track key while the player is showing an advert

  let player = null; // latest snapshot from probe.js
  let seenKey = '';
  let seenAt = 0;
  let trackKey = ''; // the track the current lyrics belong to
  let lyrics = { status: 'idle' };
  let offset = 0; // user's sync nudge for this track, seconds
  const offsets = new Map();
  let lastIndex = -2;

  let host = null;
  let shadow = null;
  let launcher = null;
  let ui = null; // { win, doc, mode, root, ... } while the lyrics view is open

  const node = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // A page's CSP can refuse an injected <style>; a constructed sheet is not covered by it.
  function addCss(doc, owner, css) {
    const style = doc.createElement('style');
    style.textContent = css;
    (owner === doc ? doc.head : owner).appendChild(style);
    if (style.sheet) return;
    style.remove();
    const sheet = new doc.defaultView.CSSStyleSheet();
    sheet.replaceSync(css);
    owner.adoptedStyleSheets = [...owner.adoptedStyleSheets, sheet];
  }

  function nowPos() {
    if (!player) return 0;
    const drift = player.paused ? 0 : ((performance.now() - player.at) / 1000) * (player.rate || 1);
    return player.position + Math.min(drift, 5) + offset;
  }

  /* ---------- track changes ---------- */

  function onState(state) {
    player = state;
    const now = performance.now();
    const key = state.ad ? AD : state.title ? `${normalize(state.title)}|${normalize(state.artist)}` : '';
    if (key !== seenKey) {
      seenKey = key;
      seenAt = now;
    }
    // Title and artist can land a beat before the duration; wait briefly so the lookup can match on length.
    const settled = now - seenAt;
    if (key !== trackKey && settled >= 300 && (!key || state.duration > 0 || settled >= 2000)) {
      trackKey = key;
      offset = offsets.get(key) || 0;
      if (key === AD) setLyrics({ status: 'ad' });
      else if (key) loadLyrics(key, state);
      else setLyrics({ status: 'idle' });
    }
  }

  function setLyrics(next) {
    lyrics = next;
    lastIndex = -2;
    render();
  }

  async function loadLyrics(key, state) {
    setLyrics({ status: 'loading' });
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: 'fl:lyrics',
        track: { title: state.title, artist: state.artist, album: state.album, duration: state.duration },
      });
    } catch (err) {
      result = { status: /context invalidated/i.test(String(err)) ? 'stale' : 'error' };
    }
    if (key !== trackKey) return; // skipped to another track while this was in flight
    setLyrics(result && result.status ? result : { status: 'error' });
  }

  /* ---------- lyrics view ---------- */

  function mount(win, doc, container, mode) {
    const root = node(doc, 'div', 'fl');
    const head = node(doc, 'div', 'fl-head');
    const title = node(doc, 'span', 'fl-title');
    const artist = node(doc, 'span', 'fl-artist');
    head.append(title, artist);

    const body = node(doc, 'div', 'fl-body');
    const lines = node(doc, 'div', 'fl-lines');
    const msg = node(doc, 'div', 'fl-msg');
    body.append(lines, msg);

    const foot = node(doc, 'div', 'fl-foot');
    const earlier = node(doc, 'button', 'fl-btn', 'Earlier');
    const sync = node(doc, 'span', 'fl-sync');
    const later = node(doc, 'button', 'fl-btn', 'Later');
    const source = node(doc, 'span', 'fl-source');
    earlier.title = 'Show lyrics 0.5s earlier';
    later.title = 'Show lyrics 0.5s later';
    earlier.addEventListener('click', () => nudge(0.5));
    later.addEventListener('click', () => nudge(-0.5));
    foot.append(earlier, sync, later, source);

    root.append(head, body, foot);
    container.appendChild(root);

    ui = { win, doc, mode, root, title, artist, lines, msg, sync, source, nodes: [], active: -2, shown: null };
    win.addEventListener('resize', () => ui && ui.win === win && center(false));

    const loop = () => {
      if (!ui || ui.win !== win) return;
      tick();
      win.requestAnimationFrame(loop);
    };
    render();
    win.requestAnimationFrame(loop);
  }

  function unmount() {
    if (!ui) return;
    const closing = ui;
    ui = null;
    if (closing.mode === 'panel') closing.root.parentNode.remove();
    else if (!closing.win.closed) closing.win.close();
    launcher.textContent = '♪ Lyrics';
    publish();
  }

  function nudge(delta) {
    offset = Math.round((offset + delta) * 10) / 10;
    if (trackKey) offsets.set(trackKey, offset);
    render();
  }

  function render() {
    if (ui) {
      const p = player || {};
      ui.title.textContent = p.title || 'FloatLyrics';
      ui.artist.textContent = p.artist ? `— ${p.artist}` : '';

      const hasLines = lyrics.status === 'synced' || lyrics.status === 'plain';
      ui.root.classList.toggle('is-plain', lyrics.status === 'plain');
      ui.lines.hidden = !hasLines;
      ui.msg.hidden = hasLines;
      ui.msg.textContent = MESSAGES[lyrics.status] || '';

      if (ui.shown !== lyrics) {
        ui.shown = lyrics;
        ui.nodes = [];
        ui.active = -2;
        ui.lines.replaceChildren();
        if (hasLines) {
          for (const line of lyrics.lines) {
            const p = node(ui.doc, 'p', 'fl-line', line.text || (lyrics.status === 'synced' ? '♪' : ' '));
            ui.nodes.push(p);
            ui.lines.appendChild(p);
          }
        }
        ui.lines.scrollTop = 0;
      }

      ui.sync.textContent = `Sync ${offset > 0 ? '+' : ''}${offset.toFixed(1)}s`;
      const notes = [];
      if (lyrics.status === 'plain') notes.push('not time-synced');
      if (lyrics.approx) notes.push('timing may be off');
      if (lyrics.source) notes.push(lyrics.source.provider);
      ui.source.textContent = notes.join(' · ');
    }
    lastIndex = -2;
    tick();
  }

  function center(smooth) {
    const cur = ui.nodes[ui.active];
    const top = cur ? cur.offsetTop + cur.offsetHeight / 2 - ui.lines.clientHeight / 2 : 0;
    ui.lines.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  function tick() {
    const synced = lyrics.status === 'synced';
    const i = synced ? indexAt(lyrics.lines, nowPos()) : -1;
    if (ui && synced && i !== ui.active) {
      const prev = ui.nodes[ui.active];
      if (prev) prev.classList.remove('is-active');
      ui.active = i;
      if (ui.nodes[i]) ui.nodes[i].classList.add('is-active');
      center(true);
    }
    if (i !== lastIndex) {
      lastIndex = i;
      publish(i);
    }
  }

  // Mirrors the current state onto the host element's data-* attributes: readable from DevTools and by the e2e test.
  function publish(i = lastIndex) {
    if (!host) return;
    const set = (k, v) => {
      const s = String(v == null ? '' : v);
      if (host.dataset[k] !== s) host.dataset[k] = s;
    };
    const line = lyrics.status === 'synced' && i >= 0 ? lyrics.lines[i] : null;
    const next = lyrics.status === 'synced' ? lyrics.lines[i + 1] : null;
    set('flStatus', lyrics.status);
    set('flTrack', player && player.title ? `${player.title} — ${player.artist}` : '');
    set('flSrc', player ? player.src : '');
    set('flDuration', player ? Math.round(player.duration) : '');
    set('flMatch', lyrics.source ? `${lyrics.source.title} — ${lyrics.source.artist} (${lyrics.source.duration}s)` : '');
    set('flLine', i);
    set('flLineT', line ? line.t : '');
    set('flNextT', next ? next.t : '');
    set('flText', line ? line.text : '');
    set('flMode', ui ? ui.mode : 'closed');
    if (ui) {
      const active = ui.root.querySelector('.fl-line.is-active');
      set('flRendered', ui.nodes.length);
      set('flActiveText', active ? active.textContent : '');
      set('flCss', ui.doc.defaultView.getComputedStyle(ui.root).display === 'flex' ? 'ok' : 'missing');
    }
  }

  /* ---------- opening the window ---------- */

  async function toggle() {
    if (ui) return unmount();
    const pip = window.documentPictureInPicture;
    if (pip && pip.requestWindow) {
      try {
        const win = await pip.requestWindow({ width: 380, height: 190 });
        win.document.title = 'FloatLyrics';
        addCss(win.document, win.document, UI_CSS);
        mount(win, win.document, win.document.body, 'pip');
        win.addEventListener('pagehide', () => ui && ui.win === win && unmount(), { once: true });
        launcher.textContent = '✕ Lyrics';
        return undefined;
      } catch (err) {
        console.warn('[FloatLyrics] Picture-in-Picture unavailable, using the in-page panel:', err);
      }
    }
    const panel = node(document, 'div', 'fl-panel');
    shadow.appendChild(panel);
    mount(window, document, panel, 'panel');
    launcher.textContent = '✕ Lyrics';
    return undefined;
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    if (!host) {
      host = document.createElement('div');
      host.id = 'floatlyrics-host';
      shadow = host.attachShadow({ mode: 'open' });
      addCss(document, shadow, HOST_CSS + UI_CSS);
      launcher = node(document, 'button', 'fl-launch', '♪ Lyrics');
      launcher.type = 'button';
      launcher.title = 'Open lyrics in a floating window';
      launcher.addEventListener('click', toggle);
      shadow.appendChild(launcher);
    }
    (document.body || document.documentElement).appendChild(host);
    publish();
  }

  document.addEventListener('floatlyrics:state', (e) => {
    try {
      onState(JSON.parse(e.detail));
    } catch (err) {}
  });

  ensureHost();
  setInterval(() => {
    ensureHost();
    tick();
  }, 200);
})();
