/*
 * FloatLyrics Dynamic Island. While the lyrics window is minimised, the lyrics carry on up here:
 *  - around a MacBook notch: a black island growing out of the notch (the notch row on top, the lyrics below);
 *  - on a screen without a notch: a glass island hanging from the top edge, one row (cover · lyric · equaliser),
 *    in native macOS glass, wearing the window's theme, text size, clarity and cover colour (live).
 * The lyrics are a reel: every line is a row, each sliding on its own slightly staggered spring so the lines roll
 * up like a wave; the line being sung fills with light as it is sung. Hover expands the island into controls.
 * States: hidden (window open) · idle (tucked away) · compact (cover + equaliser) · lyric · expanded (hover).
 * Springs by Motion (motion.dev, MIT): physical, so an interrupted move keeps its speed.
 */
(() => {
  'use strict';
  const { indexAt, progressAt, singingSpan, handoverAt } = window.FloatLyricsCore;
  const looks = window.FloatLyricsLooks;
  const { animate } = window.Motion;
  const api = window.floatlyrics;
  const $ = (id) => document.getElementById(id);
  const islandEl = $('island');
  const shellEl = islandEl.querySelector('.shell');
  const reelEl = $('reel');
  const measureEl = $('measure');
  const ringEl = $('ring');
  const rootStyle = document.documentElement.style;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const EAR = 46; // notch: room each side of the notch for the cover and the equaliser
  const PAD = 22; // notch: lyric inset
  const MAX_W = 600;
  const ROW_W = MAX_W - PAD * 2; // rows keep one width, so they never reflow while the island resizes
  const SIDES = 46 + 42; // glass row: cover on the left, equaliser on the right
  const GLASS_MAX_W = 640;
  const GLASS_ROW_W = GLASS_MAX_W - SIDES - 16;
  const MORE_H = 48; // hover row
  const TOP_PAD = 6;
  const BOTTOM_PAD = 10;
  const PAUSE_IDLE_MS = 15000; // paused this long, the island tucks away
  const SOON_S = 20; // during an intro or instrumental gap, show the next line this far ahead
  const STAGGER_MS = 45; // each following line sets off this much later: the reel rolls like a wave
  const COUNTDOWN_S = 1.5; // after a break, the coming line brightens over this long before it is sung
  const EXPANDED_W = 470;

  // The island's outline: quick, with a little overshoot, like iPhone's (damping ratio ≈ 0.65).
  const SHAPE = { type: 'spring', stiffness: 380, damping: 25, mass: 1 };
  // Lyric rows: smooth, settling without a wobble (critically damped), so words stay readable while they move.
  const ROLL = { type: 'spring', stiffness: 170, damping: 26, mass: 1 };
  const move = (el, keyframes, opts) => animate(el, keyframes, reduceMotion ? { duration: 0 } : opts);
  let shapeMoves = []; // the notch island's size and corners in flight

  let geo = { active: false, hasNotch: false, notchWidth: 0, notchHeight: 0, glass: false, inset: 0, rowHeight: 38, shown: false };
  let ready = false; // told the app this page is laid out for its screen
  let np = null;
  let lyrics = { status: 'idle', key: '' };
  let offset = 0;
  let rows = []; // { el, t, end, text }, one per lyric line that has words
  let rowOfLine = []; // lyric line index → row index (-1 for empty lines)
  let focus = { row: -1, kind: '' }; // kind: 'now' (being sung) or 'soon' (next line, during gaps)
  let pausedSince = 0;
  let hover = false;
  let expanded = false;
  let hoverTimer = null;
  let shape = '';
  let asked = { w: 0, h: 0, show: false }; // last size asked of the glass window

  const glass = () => !!geo.glass;

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
        const next = lyrics.lines[i + 1];
        rows.push({ el: p, line, t: line.t, end: next ? next.t : line.t + 5, text: line.text });
        reelEl.appendChild(p);
      });
    }
  }

  // Where the focused line sits: notch, at the top of the space below the notch; glass, centred in its row.
  function focusOffset() {
    if (focus.row < 0) return 0;
    const el = rows[focus.row].el;
    if (!glass()) return -el.offsetTop;
    return -el.offsetTop + (rowHeight() - measure(rows[focus.row].text).height) / 2;
  }

  // Each row slides by the same amount, but those after the focus set off a little later, so the reel rolls.
  function applyFocus(jump) {
    const y = focusOffset();
    rows.forEach((r, k) => {
      const c = r.el.classList;
      c.toggle('is-now', k === focus.row && focus.kind === 'now');
      c.toggle('is-soon', k === focus.row && focus.kind === 'soon');
      c.toggle('is-next', focus.row >= 0 && k === focus.row + 1);
      c.toggle('is-past', focus.row >= 0 && k < focus.row);
      if (k !== focus.row) r.el.style.removeProperty('--p');
      const near = focus.row >= 0 && k >= focus.row - 2 && k <= focus.row + 3;
      if (jump || !near) move(r.el, { y }, { duration: 0 });
      else move(r.el, { y }, { ...ROLL, delay: Math.max(0, k - focus.row + 1) * (STAGGER_MS / 1000) });
    });
  }

  // The line being sung fills with light from left to right (a soft karaoke sweep), word by word when the lyrics
  // have word timing, finishing when the line has probably been sung. A line waiting to be sung brightens over
  // its last moments instead: a countdown to come in.
  function sweep(pos) {
    if (focus.row < 0 || reduceMotion) return;
    const r = rows[focus.row];
    if (focus.kind === 'now') {
      const next = lyrics.lines[lyrics.lines.indexOf(r.line) + 1];
      r.el.style.setProperty('--p', progressAt(r.line, r.line.t + singingSpan(r.line, next), pos).toFixed(3));
    } else {
      r.el.style.setProperty('--c', Math.min(1, Math.max(0, 1 - (r.t - pos) / COUNTDOWN_S)).toFixed(3));
    }
  }

  // The record's ring fills over the length of the song.
  function ring(pos) {
    const d = np && np.duration > 0 ? np.duration : 0;
    ringEl.style.setProperty('--song', d ? Math.min(1, Math.max(0, pos / d)).toFixed(4) : '0');
  }

  /* ---------- state and shape ---------- */

  function stateNow() {
    if (!geo.active) return 'hidden';
    const hasTrack = !!(np && np.title);
    if (expanded && hasTrack) return 'expanded';
    // Nothing to sing along to (a talk, a movie clip): stay tucked away rather than show an equaliser.
    const notSong = lyrics.status === 'none' && !(np && np.music);
    if (!hasTrack || notSong || (!np.playing && Date.now() - pausedSince > PAUSE_IDLE_MS)) return geo.hasNotch ? 'idle' : 'hidden';
    return focus.row >= 0 ? 'lyric' : 'compact';
  }

  // The glass island's single row grows for a line that wraps to two lines.
  function rowHeight() {
    if (focus.row < 0) return geo.rowHeight;
    return Math.max(geo.rowHeight, measure(rows[focus.row].text).height + 14);
  }

  function layout(force) {
    const state = stateNow();
    islandEl.dataset.state = state;
    publish(state);
    if (glass()) return layoutGlass(state, force);

    const nw = geo.notchWidth;
    const nh = geo.notchHeight;
    let w = nw + EAR * 2;
    let h = nh;
    let r = 12;
    if (state === 'idle' || state === 'hidden') {
      w = nw;
      r = 10;
    }
    if ((state === 'lyric' || state === 'expanded') && focus.row >= 0) {
      const now = measure(rows[focus.row].text);
      w = Math.max(w, now.width + PAD * 2);
      h = nh + TOP_PAD + now.height + BOTTOM_PAD;
      r = 22;
    }
    if (state === 'expanded') {
      w = Math.max(w, EXPANDED_W);
      h += MORE_H;
      r = 26;
    }
    w = Math.min(w, MAX_W);
    const key = `notch|${state}|${w}|${h}|${r}|${nh}`;
    if (!force && key === shape) return undefined;
    const first = !shape.startsWith('notch');
    shape = key;
    rootStyle.setProperty('--nh', `${nh}px`);
    const spring = first ? { duration: 0 } : SHAPE;
    shapeMoves = [
      move(islandEl, { width: `${w}px`, height: `${h}px` }, spring),
      move(shellEl, { borderBottomLeftRadius: `${r}px`, borderBottomRightRadius: `${r}px` }, spring),
    ];
    return undefined;
  }

  // Glass: the window itself is the island, so ask the app for the size; the glass and the window spring to it.
  function layoutGlass(state, force) {
    const rowH = rowHeight();
    let w = 200;
    let h = geo.rowHeight;
    if ((state === 'lyric' || state === 'expanded') && focus.row >= 0) {
      w = Math.max(w, measure(rows[focus.row].text).width + SIDES + 16);
      h = rowH;
    }
    if (state === 'expanded') {
      w = Math.max(w, EXPANDED_W);
      h += MORE_H;
    }
    w = Math.min(w, GLASS_MAX_W);
    rootStyle.setProperty('--nh', `${rowH}px`); // the cover and equaliser line up with the line being sung
    // A few pixels of width do not deserve a window resize; a new line that is much wider or narrower does.
    // Nothing to show (paused a while, not a song): the app fades the glass away rather than leave it empty.
    const show = state !== 'hidden';
    const changed = Math.abs(w - asked.w) > 18 || h !== asked.h || show !== asked.show;
    if (!force && !changed) return undefined;
    asked = { w, h, show };
    api.islandSize(w, h, show);
    return undefined;
  }



  function tick() {
    let row = -1;
    let kind = '';
    const pos = position();
    if (lyrics.status === 'synced' && np && rows.length) {
      // One line at a time, so timing does the reading-ahead: the next line takes over once the current one has
      // probably been sung (handoverAt), early enough to read it before it is due.
      const lines = lyrics.lines;
      const i = indexAt(lines, pos);
      let j = i + 1;
      while (j < lines.length && !lines[j].text) j++;
      const cur = i >= 0 ? lines[i] : null;
      const next = j < lines.length ? lines[j] : null;
      if (cur && cur.text) {
        if (next && pos >= handoverAt(cur, next)) {
          row = rowOfLine[j];
          kind = 'soon';
        } else {
          row = rowOfLine[i];
          kind = 'now';
        }
      } else if (next && next.t - pos < SOON_S) {
        // Intro or instrumental break: the coming line waits in place, dimmed, then counts in.
        row = rowOfLine[j];
        kind = 'soon';
      }
    }
    if (row !== focus.row || kind !== focus.kind) {
      const previous = focus.row;
      const jump = previous < 0 || row < 0 || Math.abs(row - previous) > 3; // a seek or a fresh start: land, don't scroll past many lines
      focus = { row, kind };
      applyFocus(jump);
    }
    sweep(pos);
    ring(pos);
    layout();
  }

  function loop() {
    tick();
    requestAnimationFrame(loop);
  }

  /* ---------- appearance (the glass island wears the window's look) ---------- */

  function applySettings(s) {
    islandEl.dataset.theme = s.theme;
    rootStyle.setProperty('--text-scale', looks.STEPS.textSize[s.textSize]);
    rootStyle.setProperty('--clarity', looks.STEPS.clarity[s.clarity]);
    rootStyle.setProperty('--cover', looks.STEPS.cover[s.cover]);
    if (focus.row >= 0) applyFocus(true); // row heights changed
    layout(true);
  }

  let artUrl = '';
  function showArt(url) {
    $('art').src = url;
    if (url === artUrl) return;
    artUrl = url;
    const bg = $('gbg');
    const fresh = ['a', 'b'].map((k) => {
      const img = document.createElement('img');
      img.className = `gart ${k}`;
      img.alt = '';
      return img;
    });
    fresh[0].addEventListener(
      'load',
      () => {
        if (artUrl !== url) return;
        const old = [...bg.querySelectorAll('.gart.is-shown')];
        fresh.forEach((i) => i.classList.add('is-shown'));
        setTimeout(() => old.forEach((n) => n.remove()), 1200);
      },
      { once: true },
    );
    fresh.forEach((i) => {
      i.src = url;
      bg.appendChild(i);
    });
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

  /* ---------- hover and controls ---------- */

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

  // Notch: the window is large and click-through, so watch for the pointer over the island itself.
  // Glass: the window is the island, so being inside it is the hover.
  document.addEventListener('mousemove', (e) => {
    if (glass()) return setHover(geo.active);
    const r = islandEl.getBoundingClientRect();
    const live = geo.active && islandEl.dataset.state !== 'hidden';
    return setHover(live && e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY <= r.bottom + 6);
  });
  document.addEventListener('mouseleave', () => setHover(false));

  // State mirrored onto <body data-*> for DevTools and the e2e test.
  function publish(state) {
    const r = rows[focus.row];
    Object.assign(document.body.dataset, {
      state,
      mode: glass() ? 'glass' : 'notch',
      text: r && focus.kind === 'now' ? r.text : '',
      soon: r && focus.kind === 'soon' ? r.text : '',
      active: geo.active ? '1' : '0',
      shown: geo.shown ? '1' : '0',
      theme: islandEl.dataset.theme || '',
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
    const modeChanged = !!g.glass !== glass();
    geo = g;
    document.body.classList.toggle('glass', glass());
    islandEl.classList.toggle('notched', !glass());
    islandEl.classList.toggle('glassy', glass());
    const width = glass() ? GLASS_ROW_W : ROW_W;
    measureEl.style.maxWidth = `${width}px`;
    reelEl.style.width = `${width}px`;
    reelEl.style.marginLeft = `${-width / 2}px`;
    rootStyle.setProperty('--inset', `${glass() ? g.inset : 0}px`);
    if (modeChanged) {
      // the notch island's spring-set size and corners do not apply to glass (and the other way round)
      shapeMoves.forEach((a) => a.stop());
      shapeMoves = [];
      shape = '';
      asked = { w: 0, h: 0, show: false };
      islandEl.removeAttribute('style');
      shellEl.removeAttribute('style');
    }
    if (focus.row >= 0) applyFocus(true);
    layout(true);
    // Laid out for this screen: the app may show the window now (never before, so no half-made frame shows).
    if (!ready) {
      ready = true;
      requestAnimationFrame(() => requestAnimationFrame(() => api.islandReady()));
    }
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
    showArt(url);
    return undefined;
  });
  api.on('settings', applySettings);

  $('prev').addEventListener('click', () => command('previous'));
  $('play').addEventListener('click', () => command('toggle'));
  $('next').addEventListener('click', () => command('next'));
  $('open').addEventListener('click', () => api.restore());
  $('disc').addEventListener('click', () => api.restore());
  $('earlier').addEventListener('click', () => api.nudge(0.5));
  $('later').addEventListener('click', () => api.nudge(-0.5));

  // Read-only hook for DevTools and the e2e test.
  window.__floatlyrics = { position, state: () => islandEl.dataset.state };

  layout(true);
  requestAnimationFrame(loop);
  setInterval(tick, 200); // keeps time even if the system pauses animation frames
})();
