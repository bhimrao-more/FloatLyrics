/*
 * FloatLyrics Dynamic Island. While the lyrics window is minimised, the notch grows into a black island that
 * shows the current lyric line, resizing on a spring with every line. Hover to expand it into controls.
 * States: hidden (window open) · idle (notch-sized) · compact (cover + equaliser) · lyric · expanded (hover).
 */
(() => {
  'use strict';
  const { indexAt } = window.FloatLyricsCore;
  const looks = window.FloatLyricsLooks;
  const api = window.floatlyrics;
  const $ = (id) => document.getElementById(id);
  const islandEl = $('island');
  const lyricEl = $('lyric');
  const measureEl = $('measure');
  const rootStyle = document.documentElement.style;

  const EAR = 46; // room each side of the notch for the cover and the equaliser
  const PAD = 22; // lyric inset
  const MAX_W = 600;
  const MORE_H = 48; // hover row
  const PAUSE_IDLE_MS = 15000; // paused this long, the island folds back into the notch

  let geo = { active: false, hasNotch: false, notchWidth: 0, notchHeight: 0 };
  let np = null;
  let lyrics = { status: 'idle', key: '' };
  let offset = 0;
  let settings = looks.DEFAULTS;
  let lineIndex = -2;
  let lineText = '';
  let pausedSince = 0;
  let hover = false;
  let expanded = false;
  let hoverTimer = null;
  let layoutKey = '';

  // An underdamped spring sampled into a CSS linear() easing that settles within `duration` seconds.
  function spring(zeta, duration, samples = 60) {
    const omega = 4.6 / (zeta * duration);
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const pts = [];
    for (let i = 0; i <= samples; i++) {
      const t = (i / samples) * duration;
      const x = 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
      pts.push(x.toFixed(4));
    }
    pts[samples] = '1';
    return `linear(${pts.join(', ')})`;
  }
  rootStyle.setProperty('--spring', spring(0.62, 0.6)); // the island's size: a little bounce, like iPhone's
  rootStyle.setProperty('--spring-soft', spring(0.85, 0.55)); // lyric text: settles without overshoot

  function position() {
    if (!np) return 0;
    const drift = np.playing ? Math.max(0, ((Date.now() - np.at) / 1000) * np.rate) : 0;
    return np.elapsed + drift + np.lead + offset;
  }

  function measure(text) {
    measureEl.style.maxWidth = `${MAX_W - PAD * 2}px`;
    measureEl.textContent = text;
    const r = measureEl.getBoundingClientRect();
    return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
  }

  function stateNow() {
    if (!geo.active) return 'hidden';
    const hasTrack = !!(np && np.title);
    if (expanded && hasTrack) return 'expanded';
    if (!hasTrack || (!np.playing && Date.now() - pausedSince > PAUSE_IDLE_MS)) return geo.hasNotch ? 'idle' : 'hidden';
    return lineText ? 'lyric' : 'compact';
  }

  function layout(force) {
    const state = stateNow();
    const key = `${state}|${lineIndex}|${lineText}|${geo.notchWidth}|${settings.textSize}`;
    if (!force && key === layoutKey) return;
    layoutKey = key;
    islandEl.dataset.state = state;
    islandEl.classList.toggle('notched', geo.hasNotch);
    islandEl.classList.toggle('floating', !geo.hasNotch);

    const nw = geo.hasNotch ? geo.notchWidth : 0;
    const nh = geo.hasNotch ? geo.notchHeight : 34;
    const compactW = geo.hasNotch ? nw + EAR * 2 : 124;
    let w = compactW;
    let h = nh;
    let r = geo.hasNotch ? 12 : nh / 2;
    let lyricH = 0;
    if (state === 'idle' || state === 'hidden') {
      w = geo.hasNotch ? nw : compactW;
      r = geo.hasNotch ? 10 : nh / 2;
    }
    if ((state === 'lyric' || state === 'expanded') && lineText) {
      const t = measure(lineText);
      w = Math.max(w, t.width + PAD * 2);
      lyricH = t.height + 14;
      h = nh + lyricH;
      r = 22;
    }
    if (state === 'expanded') {
      w = Math.max(w, 400);
      h += MORE_H;
      r = 26;
    }
    rootStyle.setProperty('--w', `${Math.min(w, MAX_W)}px`);
    rootStyle.setProperty('--h', `${h}px`);
    rootStyle.setProperty('--r', `${r}px`);
    rootStyle.setProperty('--nh', `${nh}px`);
    rootStyle.setProperty('--lyric-h', `${lyricH}px`);
    publish(state);
  }

  function showLine(text) {
    for (const old of lyricEl.querySelectorAll('.line:not(.out)')) {
      old.classList.add('out');
      setTimeout(() => old.remove(), 450);
    }
    if (!text) return;
    const span = document.createElement('span');
    span.className = 'line in';
    span.textContent = text;
    lyricEl.appendChild(span);
    requestAnimationFrame(() => requestAnimationFrame(() => span.classList.remove('in')));
  }

  function tick() {
    let i = -1;
    if (lyrics.status === 'synced' && np) i = indexAt(lyrics.lines, position());
    if (i !== lineIndex) {
      lineIndex = i;
      lineText = i >= 0 ? lyrics.lines[i].text : '';
      showLine(lineText);
    }
    layout();
  }

  function loop() {
    tick();
    requestAnimationFrame(loop);
  }

  // A colour from the cover for the equaliser, kept bright enough to read on black.
  function accentFrom(img) {
    try {
      const c = document.createElement('canvas');
      c.width = 12;
      c.height = 12;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 12, 12);
      const d = g.getImageData(0, 0, 12, 12).data;
      let r = 0;
      let gr = 0;
      let b = 0;
      let wsum = 0;
      for (let k = 0; k < d.length; k += 4) {
        const max = Math.max(d[k], d[k + 1], d[k + 2]);
        const min = Math.min(d[k], d[k + 1], d[k + 2]);
        const wgt = (max - min) / 255 + 0.04; // favour colourful pixels over greys
        r += d[k] * wgt;
        gr += d[k + 1] * wgt;
        b += d[k + 2] * wgt;
        wsum += wgt;
      }
      const [hh, ss, ll] = rgbToHsl(r / wsum, gr / wsum, b / wsum);
      return `hsl(${Math.round(hh)} ${Math.round(Math.min(1, ss * 1.25) * 100)}% ${Math.round(Math.max(ll, 0.64) * 100)}%)`;
    } catch (err) {
      return '#fff';
    }
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }

  function setHover(inside) {
    if (inside === hover) return;
    hover = inside;
    api.islandHover(inside);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(
      () => {
        expanded = hover;
        layout(true);
      },
      inside ? 140 : 380,
    );
  }

  // The window is click-through; mouse moves still arrive, so we watch for the pointer over the island.
  document.addEventListener('mousemove', (e) => {
    const r = islandEl.getBoundingClientRect();
    const live = geo.active && islandEl.dataset.state !== 'hidden';
    setHover(live && e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY <= r.bottom + 6);
  });
  document.addEventListener('mouseleave', () => setHover(false));

  // State mirrored onto <body data-*> for DevTools and the e2e test.
  function publish(state) {
    Object.assign(document.body.dataset, { state, text: lineText, line: String(lineIndex), active: geo.active ? '1' : '0' });
  }

  function command(name) {
    if (name === 'toggle' && np) {
      np.playing = !np.playing;
      islandEl.classList.toggle('playing', np.playing);
      islandEl.classList.toggle('paused', !np.playing);
    }
    api.command(name).catch(() => {});
  }

  api.on('island', (g) => {
    geo = g;
    layout(true);
  });
  api.on('np', (report) => {
    const wasPlaying = np && np.playing;
    np = report;
    if (!np.playing && (wasPlaying || !pausedSince)) pausedSince = Date.now();
    if (np.playing) pausedSince = 0;
    islandEl.classList.toggle('playing', np.playing);
    islandEl.classList.toggle('paused', !np.playing);
    $('title').textContent = np.title || '';
    $('artist').textContent = np.artist || '';
  });
  api.on('lyrics', (result) => {
    lyrics = result;
    if (result.source && result.status === 'synced') {
      $('title').textContent = result.source.title || $('title').textContent;
      $('artist').textContent = result.source.artist || $('artist').textContent;
    }
  });
  api.on('offset', (o) => {
    if (!np || o.key === np.key) offset = o.value;
  });
  api.on('art', (url) => {
    const img = $('art');
    if (!url) return img.removeAttribute('src');
    img.onload = () => rootStyle.setProperty('--accent', accentFrom(img));
    img.src = url;
    return undefined;
  });
  api.on('settings', (s) => {
    settings = s;
    rootStyle.setProperty('--text-scale', looks.STEPS.textSize[s.textSize]);
    layout(true);
  });

  $('prev').addEventListener('click', () => command('previous'));
  $('play').addEventListener('click', () => command('toggle'));
  $('next').addEventListener('click', () => command('next'));
  $('open').addEventListener('click', () => api.restore());
  $('art').addEventListener('click', () => api.restore());

  // Read-only hook for DevTools and the e2e test.
  window.__floatlyrics = { position, state: () => islandEl.dataset.state };

  layout(true);
  requestAnimationFrame(loop);
  setInterval(tick, 200); // keeps time even if the system pauses animation frames
})();
