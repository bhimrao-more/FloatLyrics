/*
 * FloatLyrics Dynamic Island. While the lyrics window is minimised, the notch grows into a black island that
 * carries the lyrics as a small scrolling reel: the line being sung in focus, the next one waiting below. Each
 * new line springs the reel upward. Hover to expand it into controls.
 * States: hidden (window open) · idle (notch-sized) · compact (cover + equaliser) · lyric · expanded (hover).
 * On a screen without a notch it is a floating pill instead, everything in one row: cover · lyric · equaliser.
 * Motion (motion.dev, MIT) drives the springs; they are physical, so an interrupted move keeps its speed.
 */
(() => {
  'use strict';
  const { indexAt } = window.FloatLyricsCore;
  const looks = window.FloatLyricsLooks;
  const { animate } = window.Motion;
  const api = window.floatlyrics;
  const $ = (id) => document.getElementById(id);
  const islandEl = $('island');
  const shellEl = islandEl.querySelector('.shell');
  const reelEl = $('reel');
  const measureEl = $('measure');
  const rootStyle = document.documentElement.style;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const EAR = 46; // room each side of the notch for the cover and the equaliser
  const PAD = 22; // lyric inset
  const MAX_W = 600;
  const ROW_W = MAX_W - PAD * 2; // rows keep one width, so they never reflow while the island resizes
  const PILL_H = 40; // the pill's single row
  const PILL_SIDES = 46 + 42; // cover on the left, equaliser on the right
  const PILL_ROW_W = MAX_W - PILL_SIDES;
  const MORE_H = 48; // hover row
  const TOP_PAD = 6;
  const BOTTOM_PAD = 10;
  const NEXT_SCALE = 0.84; // the waiting line is drawn smaller (see .row.is-next)
  const PAUSE_IDLE_MS = 15000; // paused this long, the island folds back into the notch
  const SOON_S = 20; // during an intro or instrumental gap, show the next line this far ahead

  // The island's outline: quick, with a little overshoot, like iPhone's (damping ratio ≈ 0.65).
  const SHAPE = { type: 'spring', stiffness: 380, damping: 25, mass: 1 };
  // The lyric reel: smooth and settling without a wobble (critically damped), so words stay readable as they move.
  const REEL = { type: 'spring', stiffness: 170, damping: 26, mass: 1 };
  const move = (el, keyframes, spring) => animate(el, keyframes, reduceMotion ? { duration: 0 } : spring);

  let geo = { active: false, hasNotch: false, notchWidth: 0, notchHeight: 0 };
  let np = null;
  let lyrics = { status: 'idle', key: '' };
  let offset = 0;
  let rows = []; // { el, t, text }, one per lyric line that has words
  let rowOfLine = []; // lyric line index → row index (-1 for empty lines)
  let focus = { row: -1, kind: '' }; // kind: 'now' (being sung) or 'soon' (next line, during gaps)
  let pausedSince = 0;
  let hover = false;
  let expanded = false;
  let hoverTimer = null;
  let shape = '';

  function position() {
    if (!np) return 0;
    const drift = np.playing ? Math.max(0, ((Date.now() - np.at) / 1000) * np.rate) : 0;
    return np.elapsed + drift + np.lead + offset;
  }

  function measure(text) {
    measureEl.textContent = text;
    const r = measureEl.getBoundingClientRect();
    return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
  }

  /* ---------- the reel ---------- */

  function buildReel() {
    reelEl.replaceChildren();
    rows = [];
    rowOfLine = [];
    focus = { row: -1, kind: '' };
    if (lyrics.status === 'synced') {
      lyrics.lines.forEach((line, i) => {
        if (!line.text) {
          rowOfLine[i] = -1;
          return;
        }
        const p = document.createElement('p');
        p.className = 'row';
        p.textContent = line.text;
        rowOfLine[i] = rows.length;
        rows.push({ el: p, t: line.t, text: line.text });
        reelEl.appendChild(p);
      });
    }
    move(reelEl, { y: 0 }, { duration: 0 });
  }

  const pill = () => !geo.hasNotch;

  function applyFocus(jump) {
    rows.forEach((r, k) => {
      const c = r.el.classList;
      c.toggle('is-now', k === focus.row && focus.kind === 'now');
      c.toggle('is-soon', k === focus.row && focus.kind === 'soon');
      c.toggle('is-next', focus.row >= 0 && k === focus.row + 1);
      c.toggle('is-past', focus.row >= 0 && k < focus.row);
    });
    if (focus.row < 0) return;
    const el = rows[focus.row].el;
    // Notch: the line sits at the top of the space below the notch. Pill: centred in the single row.
    const y = pill() ? -el.offsetTop + (rowHeight() - measure(rows[focus.row].text).height) / 2 : -el.offsetTop;
    move(reelEl, { y }, jump ? { duration: 0 } : REEL);
  }

  // The pill's row grows for a line that wraps to two lines.
  function rowHeight() {
    if (!pill() || focus.row < 0) return PILL_H;
    return Math.max(PILL_H, measure(rows[focus.row].text).height + 14);
  }

  function setMode() {
    const width = pill() ? PILL_ROW_W : ROW_W;
    document.body.classList.toggle('pill', pill());
    measureEl.style.maxWidth = `${width}px`;
    reelEl.style.width = `${width}px`;
    reelEl.style.marginLeft = `${-width / 2}px`;
  }

  /* ---------- state and shape ---------- */

  function stateNow() {
    if (!geo.active) return 'hidden';
    const hasTrack = !!(np && np.title);
    if (expanded && hasTrack) return 'expanded';
    // Nothing to sing along to (a talk, a movie clip): stay tucked away rather than show an equaliser.
    const notSong = lyrics.status === 'none' && !np.music;
    if (!hasTrack || notSong || (!np.playing && Date.now() - pausedSince > PAUSE_IDLE_MS)) return geo.hasNotch ? 'idle' : 'hidden';
    return focus.row >= 0 ? 'lyric' : 'compact';
  }

  function layout(force) {
    const state = stateNow();
    const nw = geo.hasNotch ? geo.notchWidth : 0;
    const nh = geo.hasNotch ? geo.notchHeight : 34;
    const compactW = geo.hasNotch ? nw + EAR * 2 : 124;
    let w = compactW;
    let h = nh;
    let r = geo.hasNotch ? 12 : nh / 2;
    if (state === 'idle' || state === 'hidden') {
      w = geo.hasNotch ? nw : compactW;
      r = geo.hasNotch ? 10 : nh / 2;
    }
    let rowH = nh;
    if ((state === 'lyric' || state === 'expanded') && focus.row >= 0) {
      const now = measure(rows[focus.row].text);
      if (pill()) {
        rowH = rowHeight();
        w = Math.max(w, now.width + PILL_SIDES + 12);
        h = rowH;
        r = rowH / 2;
      } else {
        const next = rows[focus.row + 1];
        w = Math.max(w, now.width + PAD * 2);
        h = nh + TOP_PAD + now.height + BOTTOM_PAD;
        if (next) h += Math.round(measure(next.text).height * NEXT_SCALE);
        r = 22;
      }
    }
    if (state === 'expanded') {
      w = Math.max(w, 400);
      h += MORE_H;
      r = 26;
    }
    w = Math.min(w, MAX_W);
    islandEl.dataset.state = state;
    publish(state);
    const key = `${state}|${w}|${h}|${r}|${rowH}`;
    if (!force && key === shape) return;
    const first = !shape;
    shape = key;
    islandEl.classList.toggle('notched', geo.hasNotch);
    islandEl.classList.toggle('floating', !geo.hasNotch);
    rootStyle.setProperty('--nh', `${rowH}px`); // the top row: the notch, or the pill's single row
    const spring = first ? { duration: 0 } : SHAPE;
    move(islandEl, { width: `${w}px`, height: `${h}px` }, spring);
    const corners = geo.hasNotch
      ? { borderBottomLeftRadius: `${r}px`, borderBottomRightRadius: `${r}px`, borderTopLeftRadius: '0px', borderTopRightRadius: '0px' }
      : { borderRadius: `${r}px` };
    move(shellEl, corners, spring);
  }

  function tick() {
    let row = -1;
    let kind = '';
    if (lyrics.status === 'synced' && np && rows.length) {
      const pos = position();
      const i = indexAt(lyrics.lines, pos);
      if (i >= 0 && rowOfLine[i] >= 0) {
        row = rowOfLine[i];
        kind = 'now';
      } else {
        // Intro or instrumental gap: the next line waits in the focus spot, dimmed, so the island always has words.
        const next = rows.findIndex((r) => r.t > pos);
        if (next >= 0 && rows[next].t - pos < SOON_S) {
          row = next;
          kind = 'soon';
        }
      }
    }
    if (row !== focus.row || kind !== focus.kind) {
      const jump = focus.row < 0 || row < 0 || Math.abs(row - focus.row) > 3; // a seek or a fresh start: land, don't scroll past many lines
      focus = { row, kind };
      applyFocus(jump);
    }
    layout();
  }

  function loop() {
    tick();
    requestAnimationFrame(loop);
  }

  /* ---------- cover colour, hover, controls ---------- */

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
      return '#fff'; // a cover from another site cannot be read back; keep the bars white
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
      inside ? 140 : 450,
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
    const r = rows[focus.row];
    Object.assign(document.body.dataset, {
      state,
      text: r && focus.kind === 'now' ? r.text : '',
      soon: r && focus.kind === 'soon' ? r.text : '',
      active: geo.active ? '1' : '0',
    });
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
    setMode();
    if (focus.row >= 0) applyFocus(true);
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
    buildReel();
    tick();
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
    rootStyle.setProperty('--text-scale', looks.STEPS.textSize[s.textSize]);
    if (focus.row >= 0) applyFocus(true); // row heights changed
    layout(true);
  });

  $('prev').addEventListener('click', () => command('previous'));
  $('play').addEventListener('click', () => command('toggle'));
  $('next').addEventListener('click', () => command('next'));
  $('open').addEventListener('click', () => api.restore());
  $('art').addEventListener('click', () => api.restore());

  // Read-only hook for DevTools and the e2e test.
  window.__floatlyrics = { position, state: () => islandEl.dataset.state };

  setMode();
  layout(true);
  requestAnimationFrame(loop);
  setInterval(tick, 200); // keeps time even if the system pauses animation frames
})();
