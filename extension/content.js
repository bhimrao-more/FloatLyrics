/*
 * FloatLyrics content script (isolated world) — takes the player state probe.js reports, asks the service
 * worker for lyrics when the track changes, and renders them in an always-on-top Document Picture-in-Picture
 * window (falling back to an in-page panel where that API is missing).
 */
(() => {
  'use strict';
  if (window.__floatLyricsContent) return;
  window.__floatLyricsContent = true;

  const { indexAt, normalize, videoTrack } = globalThis.FloatLyricsCore;

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

  // Liquid-glass look; the reasoning behind each layer is in docs/liquid-glass.md.
  const UI_CSS = `
    html, body { height: 100%; margin: 0; background: #15151b; }
    .fl { --fg: #fff; --dim: rgba(255,255,255,.36); position: relative; box-sizing: border-box; display: flex;
      width: 100%; height: 100%; overflow: hidden; isolation: isolate; container-type: size; background: #15151b;
      color: var(--fg); font: 500 14px/1.35 ${FONT}; -webkit-font-smoothing: antialiased; }
    .fl * { box-sizing: border-box; }

    /* Colour field: the cover, blown up and blurred until only its colours are left. */
    .fl-bg { position: absolute; inset: 0; z-index: -2; overflow: hidden;
      background: radial-gradient(90% 120% at 15% 0%, #3b3f8c, transparent 65%),
        radial-gradient(90% 120% at 100% 100%, #6f2c66, transparent 65%), #17171f; }
    .fl-art { position: absolute; left: 50%; top: 50%; width: max(170cqw, 170cqh); height: max(170cqw, 170cqh);
      translate: -50% -50%; object-fit: cover; opacity: 0; filter: blur(44px) saturate(1.8);
      transition: opacity 1.1s ease; animation: fl-drift-a 32s ease-in-out infinite alternate; }
    .fl-art.b { left: 80%; top: 85%; width: max(120cqw, 120cqh); height: max(120cqw, 120cqh); mix-blend-mode: screen;
      filter: blur(56px) saturate(2.1); animation: fl-drift-b 41s ease-in-out infinite alternate; }
    .fl-art.is-shown { opacity: 1; }
    .fl-art.b.is-shown { opacity: .5; }
    @keyframes fl-drift-a { from { transform: rotate(0deg) scale(1); } to { transform: rotate(28deg) scale(1.18) translate(4%, -3%); } }
    @keyframes fl-drift-b { from { transform: rotate(180deg) scale(1.05); } to { transform: rotate(140deg) scale(.92) translate(-6%, 4%); } }
    /* Dimming layer so white text holds up over bright covers (Apple suggests ~35% over bright media). */
    .fl-dim { position: absolute; inset: 0; z-index: -1; background: linear-gradient(rgba(0,0,0,.2), rgba(0,0,0,.36)); }
    /* The window itself as a pane: hairline rim and a top highlight. */
    .fl::after { content: ''; position: absolute; inset: 0; z-index: 3; pointer-events: none; border-radius: inherit;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.09), inset 0 1px 0 rgba(255,255,255,.2); }

    /* Lyrics are content, not glass: sharp current line, softer neighbours. */
    .fl-body { position: absolute; inset: 0; container-type: size; }
    .fl-lines { position: absolute; inset: 0; overflow-y: auto; scrollbar-width: none; padding: 50cqh 18px; text-align: center;
      -webkit-mask-image: linear-gradient(rgba(0,0,0,.3), #000 28%, #000 72%, transparent);
      mask-image: linear-gradient(rgba(0,0,0,.3), #000 28%, #000 72%, transparent); }
    .fl-lines::-webkit-scrollbar { display: none; }
    .fl-line { margin: 0; padding: .3em 0; font-size: clamp(14px, 5.6cqw, 36px); font-weight: 750; letter-spacing: -.01em;
      line-height: 1.22; color: var(--dim); filter: blur(.6px); transform: scale(.95); text-wrap: balance;
      overflow-wrap: anywhere; transition: color .35s ease, filter .35s ease, transform .35s cubic-bezier(.2,.8,.2,1); }
    .fl-line.is-active { color: var(--fg); filter: none; transform: none; text-shadow: 0 1px 14px rgba(0,0,0,.28); }
    .fl.is-plain .fl-lines { padding-block: 52px 16px; }
    .fl.is-plain .fl-line { color: rgba(255,255,255,.86); filter: none; font-size: clamp(12px, 4cqw, 20px); font-weight: 550; transform: none; }
    .fl-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 48px 16px 16px;
      text-align: center; color: rgba(255,255,255,.78); font-size: clamp(12px, 4.4cqw, 20px); font-weight: 600;
      text-shadow: 0 1px 10px rgba(0,0,0,.3); }
    .fl-lines[hidden], .fl-msg[hidden] { display: none; }

    /* Glass: the functional layer floating over the lyrics. With a lens (glass.js) it also refracts. */
    .fl-glass { position: absolute; z-index: 2; background: rgba(255,255,255,.1);
      backdrop-filter: blur(12px) saturate(1.4); -webkit-backdrop-filter: blur(12px) saturate(1.4);
      box-shadow: 0 8px 22px -8px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.22), inset 0 -1px 0 rgba(255,255,255,.05); }
    .fl-glass::before { content: ''; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;
      background: linear-gradient(135deg, rgba(255,255,255,.7), rgba(255,255,255,.12) 28%, rgba(255,255,255,0) 50%,
        rgba(255,255,255,.1) 72%, rgba(255,255,255,.42));
      mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
    .fl-glass::after { content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
      background: radial-gradient(120% 160% at 12% -30%, rgba(255,255,255,.2), transparent 55%); }

    .fl-head { top: 8px; left: 8px; right: 8px; height: 38px; display: flex; align-items: center; gap: 9px;
      padding: 0 14px 0 5px; border-radius: 19px; white-space: nowrap; }
    .fl-thumb { flex: none; width: 28px; height: 28px; border-radius: 14px; object-fit: cover; opacity: 0;
      background: rgba(255,255,255,.12); transition: opacity .6s ease; }
    .fl-thumb.is-shown { opacity: 1; }
    .fl-meta { min-width: 0; display: flex; align-items: baseline; gap: 6px; overflow: hidden; font-size: 12px; }
    .fl-title { font-weight: 650; color: rgba(255,255,255,.96); overflow: hidden; text-overflow: ellipsis; }
    .fl-artist { flex-shrink: 3; color: rgba(255,255,255,.66); overflow: hidden; text-overflow: ellipsis; }

    .fl-foot { left: 50%; bottom: 8px; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 17px;
      white-space: nowrap; opacity: 0; translate: -50% 4px; transition: opacity .2s ease, translate .2s ease; }
    .fl:hover .fl-foot, .fl-foot:focus-within { opacity: 1; translate: -50% 0; }
    .fl-btn { height: 28px; padding: 0 12px; border: 0; border-radius: 14px; background: transparent; color: rgba(255,255,255,.94);
      font: 600 11.5px/1 ${FONT}; cursor: pointer; transition: background .15s ease, transform .15s ease; }
    .fl-btn:hover { background: rgba(255,255,255,.16); }
    .fl-btn:active { transform: scale(.95); }
    .fl-sync { padding: 0 4px; font-size: 11px; color: rgba(255,255,255,.72); font-variant-numeric: tabular-nums; }
    .fl-source { margin-left: 2px; padding: 0 10px 0 9px; border-left: 1px solid rgba(255,255,255,.18); font-size: 10.5px;
      color: rgba(255,255,255,.6); }
    .fl-source:empty { display: none; }

    @media (max-height: 120px) { .fl-head, .fl-foot { display: none; } .fl-msg { padding-top: 16px; } }
    @media (prefers-reduced-motion: reduce) { .fl-art { animation: none; } .fl-line { transition: none; } }
    @media (prefers-reduced-transparency: reduce) {
      .fl-glass { background: rgba(30,30,36,.94); backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
      .fl-dim { background: rgba(0,0,0,.6); }
      .fl-line { filter: none; }
    }
  `;

  const HOST_CSS = `
    :host { all: initial; }
    .fl-launch { position: fixed; right: 18px; bottom: 112px; z-index: 2147483647; padding: 9px 14px; border: 0;
      border-radius: 999px; background: rgba(28,28,34,.42); color: #fff; font: 600 12px/1 ${FONT}; cursor: pointer;
      backdrop-filter: blur(14px) saturate(1.8); -webkit-backdrop-filter: blur(14px) saturate(1.8);
      box-shadow: 0 6px 20px rgba(0,0,0,.25), inset 0 0 0 .5px rgba(255,255,255,.28), inset 0 1px 0 rgba(255,255,255,.3);
      opacity: .82; transition: opacity .15s ease, transform .15s ease; }
    .fl-launch:hover, .fl-launch:focus-visible { opacity: 1; }
    .fl-launch:active { transform: scale(.96); }
    /* The in-page panel floats over the player page, so here the glass is genuinely see-through. */
    .fl-panel { position: fixed; right: 18px; bottom: 160px; z-index: 2147483647; width: 360px; height: 220px;
      min-width: 200px; min-height: 80px; border-radius: 22px; overflow: hidden; resize: both;
      backdrop-filter: blur(30px) saturate(1.6); box-shadow: 0 18px 50px rgba(0,0,0,.45); }
    .fl-panel .fl-bg { opacity: .72; }
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

  // A YouTube video's own captions (probe.js), sent on to the app with the state: once when they arrive, then
  // every few seconds in case the app was restarted. Very long ones (a whole concert) are not sent.
  let captions = null;
  let captionsSent = { id: '', at: 0 };
  document.addEventListener('floatlyrics:captions', (e) => {
    try {
      const c = JSON.parse(e.detail);
      if (JSON.stringify(c).length < 120000) captions = c;
    } catch (err) {}
  });

  // The FloatLyrics desktop app, when it is running, takes this tab's exact state (sent on by background.js).
  function forwardToApp(state) {
    if (!state.hasPosition && !state.ad) return;
    let caps;
    if (captions && state.videoId && captions.videoId === state.videoId && (captionsSent.id !== state.videoId || Date.now() - captionsSent.at > 5000)) {
      caps = captions;
      captionsSent = { id: state.videoId, at: Date.now() };
    }
    const msg = {
      type: 'fl:state',
      state: {
        site: state.site,
        title: state.title,
        rawTitle: state.rawTitle || '',
        artist: state.artist,
        album: state.album,
        alt: state.alt,
        tempo: state.tempo,
        duration: state.duration,
        position: state.position,
        at: Date.now() - (performance.now() - state.at), // the probe's clock is performance.now()
        paused: state.paused,
        rate: state.rate,
        ad: !!state.ad,
        artwork: state.artwork,
        videoId: state.videoId || '',
        captions: caps,
      },
    };
    try {
      chrome.runtime
        .sendMessage(msg)
        .then((res) => setAppConnected(!!(res && res.app)))
        .catch(() => {});
    } catch (err) {} // extension reloaded: this tab's script is orphaned until the page reloads
  }

  // While the FloatLyrics app is running it shows the lyrics, so the page's own button steps aside.
  let appConnected = false;
  function setAppConnected(on) {
    if (on === appConnected) return;
    appConnected = on;
    // The page's probe reads this: it fetches a video's captions only for the app.
    document.documentElement.dataset.floatlyricsApp = on ? '1' : '0';
    if (on) captionsSent = { id: '', at: 0 };
    placeLauncher();
  }

  function onState(state) {
    // youtube.com: the video's own title becomes a track; the raw one still identifies the tab to the app.
    if (state.site === 'youtube' && state.title) Object.assign(state, { rawTitle: state.title }, videoTrack(state.title, state.artist));
    forwardToApp(state);
    player = state;
    showArt(); // the cover can land after the lyrics do
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
        track: { title: state.title, artist: state.artist, album: state.album, duration: state.duration, alt: state.alt, tempo: state.tempo },
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
    const bg = node(doc, 'div', 'fl-bg');
    const dim = node(doc, 'div', 'fl-dim');

    const body = node(doc, 'div', 'fl-body');
    const lines = node(doc, 'div', 'fl-lines');
    const msg = node(doc, 'div', 'fl-msg');
    body.append(lines, msg);

    const head = node(doc, 'div', 'fl-head fl-glass');
    const thumb = node(doc, 'img', 'fl-thumb');
    thumb.alt = '';
    const meta = node(doc, 'div', 'fl-meta');
    const title = node(doc, 'span', 'fl-title');
    const artist = node(doc, 'span', 'fl-artist');
    meta.append(title, artist);
    head.append(thumb, meta);

    const foot = node(doc, 'div', 'fl-foot fl-glass');
    const earlier = node(doc, 'button', 'fl-btn', 'Earlier');
    const sync = node(doc, 'span', 'fl-sync');
    const later = node(doc, 'button', 'fl-btn', 'Later');
    const source = node(doc, 'span', 'fl-source');
    earlier.title = 'Show lyrics 0.5s earlier';
    later.title = 'Show lyrics 0.5s later';
    earlier.addEventListener('click', () => nudge(0.5));
    later.addEventListener('click', () => nudge(-0.5));
    foot.append(earlier, sync, later, source);

    root.append(bg, dim, body, head, foot);
    container.appendChild(root);

    ui = { win, doc, mode, root, bg, thumb, title, artist, lines, msg, sync, source, nodes: [], active: -2, shown: null };
    ui.art = '';
    ui.artShown = false;
    // Refraction needs the SVG filter in the same document as the glass, which the shadow-DOM panel can't give.
    const glass = globalThis.FloatLyricsGlass;
    ui.lenses =
      mode === 'pip' && glass
        ? [
            glass.lens(doc, head, { bezel: 14, thickness: 22, after: 'blur(2px) saturate(1.35) brightness(1.05)' }),
            glass.lens(doc, foot, { bezel: 12, thickness: 18, after: 'blur(2px) saturate(1.35) brightness(1.05)' }),
          ]
        : [];
    win.addEventListener('resize', () => {
      if (!ui || ui.win !== win) return;
      for (const l of ui.lenses) l.update();
      center(false);
    });
    showArt();

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
      // Once matched, the lyric file names the song better than a video title does.
      const p = lyrics.source || player || {};
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
      for (const l of ui.lenses) l.update(); // the timing capsule's width follows its text
      showArt();
    }
    lastIndex = -2;
    tick();
  }

  // Players hand Media Session small thumbnails. Ask their image CDNs for a bigger size where the URL allows it,
  // keeping the original as the fallback. YouTube's 4:3 thumbnails are letterboxed, so prefer the 16:9 one.
  function artCandidates(url) {
    const u = String(url || '');
    if (!u) return [];
    const yt = u.match(/^(https:\/\/i\d?\.ytimg\.com\/vi(?:_webp)?\/[^/]+\/)[a-z0-9_]+\.(?:jpg|webp)/i);
    const big = yt
      ? `${yt[1]}hq720.jpg`
      : u.replace(/=w\d+-h\d+/, '=w544-h544').replace(/\/\d+x\d+([a-z]{0,3})(?:-\d+)?\.(jpe?g|png|webp)$/i, '/600x600$1.$2');
    return big === u ? [u] : [big, u];
  }

  // Cross-fades the colour field to the current cover once it has loaded.
  function showArt() {
    const original = player && player.artwork;
    if (!ui || !original || original === ui.art) return;
    ui.art = original;
    const target = ui;
    const attempt = (urls) => {
      if (!urls.length || ui !== target || target.art !== original) return;
      const url = urls[0];
      const fresh = ['a', 'b'].map((k) => {
        const img = node(target.doc, 'img', `fl-art ${k}`);
        img.alt = '';
        img.decoding = 'async';
        return img;
      });
      fresh[0].addEventListener(
        'load',
        () => {
          if (ui !== target || target.art !== original) return;
          const old = [...target.bg.querySelectorAll('.fl-art.is-shown')];
          for (const img of fresh) img.classList.add('is-shown');
          target.thumb.src = url;
          target.thumb.classList.add('is-shown');
          target.artShown = true;
          target.win.setTimeout(() => old.forEach((n) => n.remove()), 1200);
          publish();
        },
        { once: true },
      );
      fresh[0].addEventListener(
        'error',
        () => {
          fresh.forEach((n) => n.remove());
          attempt(urls.slice(1));
        },
        { once: true },
      );
      for (const img of fresh) {
        img.src = url;
        target.bg.appendChild(img);
      }
    };
    attempt(artCandidates(original));
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
      set('flArt', ui.artShown ? 'loaded' : '');
      set('flLens', ui.lenses.filter((l) => l.el.style.backdropFilter.includes(`#${l.id}`)).length);
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

  // youtube.com is mostly not music: only offer the button while a video is open.
  function placeLauncher() {
    if (!launcher) return;
    const hide = !ui && (appConnected || (location.hostname === 'www.youtube.com' && !(player && player.title)));
    launcher.style.display = hide ? 'none' : '';
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'fl:command') document.dispatchEvent(new CustomEvent('floatlyrics:command', { detail: String(msg.name) }));
  });

  document.addEventListener('floatlyrics:state', (e) => {
    try {
      onState(JSON.parse(e.detail));
    } catch (err) {}
  });

  ensureHost();
  setInterval(() => {
    ensureHost();
    placeLauncher();
    tick();
  }, 200);
})();
