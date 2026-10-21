/*
 * FloatLyrics Dynamic Island. While the lyrics window is minimised, the lyrics carry on up here:
 *  - around a MacBook notch: a black island growing out of the notch (the notch row on top, the lyrics below);
 *  - on a screen without a notch: a glass island hanging from the top edge, one row (cover · lyric · equaliser),
 *    in native macOS glass, wearing the window's theme, text size, clarity and cover colour (live).
 * The lyrics scroll: each line has a slot the height of the island, so a new line carries the old one up and out
 * of the top while it rises in from below, all on one spring (Motion, the engine behind Framer Motion). The intro
 * shows the song's name; in an instrumental break the island draws in to just the cover and the equaliser; the
 * line being sung fills with light as it is sung. Paused, the island stays, with the song's name and a ▶.
 * States: hidden (window open) · idle (nothing playing) · compact · lyric · paused · expanded (hover).
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
  const pmetaEl = $('pmeta');
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
  const PMETA_H = 32; // paused: the song's name and artist, two small lines
  const SOON_S = 3; // after an intro or a break, the coming line rises in this long before it is sung
  const COUNTDOWN_S = 1.5; // ...and brightens over its last 1.5s: a count-in
  const BREAK_S = 6; // music alone for this long: the island draws in to the cover and the equaliser
  const LINGER_S = 1; // a sung line stays this long before the island draws in for a break
  const INTRO_S = 4; // an intro this long shows the song's name until the first line
  const EXPANDED_W = 470;
  const COMPACT_W = 92; // glass, nothing to read: the cover and the equaliser side by side, no gap between

  // The island's outline: quick, with a little overshoot, like iPhone's (damping ratio ≈ 0.65).
  const SHAPE = { type: 'spring', stiffness: 380, damping: 25, mass: 1 };
  // Lines scroll on one gently underdamped spring (damping ratio ≈ 0.8): the physical glide of a Framer Motion
  // layout animation. Fades ride along: in with Apple's long ease-out, out a little quicker.
  const SCROLL = { type: 'spring', stiffness: 140, damping: 19, mass: 1 };
  const FADE_IN = { duration: 0.42, ease: [0.22, 1, 0.36, 1] };
  const FADE_OUT = { duration: 0.32, ease: [0.4, 0, 1, 1] };
  const move = (el, keyframes, opts) => animate(el, keyframes, reduceMotion ? { duration: 0 } : opts);
  let shapeMoves = []; // the notch island's size and corners in flight

  let geo = { active: false, hasNotch: false, notchWidth: 0, notchHeight: 0, glass: false, inset: 0, rowHeight: 38, shown: false };
  let ready = false; // told the app this page is laid out for its screen
  let np = null;
  let lyrics = { status: 'idle', key: '' };
  let offset = 0;
  let rows = []; // { el, kind: 'line' | 'title', text, t, end, line, h }, in time order
  let rowOfLine = []; // lyric line index → row (-1 for empty lines)
  let breakAfter = []; // lyric line index → { t, end } of the instrumental break after it
  let introRow = -1; // the song's name before the first line (or instead of lyrics that are not timed)
  let outroRow = -1; // ...and after the last
  let focus = { row: -1, kind: '' }; // kind: 'now' (being sung), 'soon' (coming in), 'title', 'break' (row -1)
  let pausedView = false; // the song's name and ▶ are showing instead of the lyric
  let hover = false;
  let expanded = false;
  let holdExpand = false; // just pressed ▶: stay a one-line island until the pointer leaves
  let hoverTimer = null;
  let shape = '';
  let asked = { w: 0, h: 0, show: false }; // last size asked of the glass window
  let lineHeight = 0; // one line of lyric text, for the rows that are not lyrics

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

  const pen = document.createElement('canvas').getContext('2d');
  function textWidth(text, font) {
    pen.font = `${font} ${getComputedStyle(document.body).fontFamily}`;
    return Math.ceil(pen.measureText(text || '').width);
  }

  const songTitle = () => $('title').textContent || '';
  const songArtist = () => $('artist').textContent || '';

  /* ---------- the reel ---------- */

  function addRow(kind, text, t, end, line) {
    const el = document.createElement('p');
    el.className = `row ${kind}`;
    if (kind === 'title') {
      const tt = document.createElement('span');
      tt.className = 'tt';
      const ta = document.createElement('span');
      ta.className = 'ta';
      el.append(tt, ta);
    } else {
      el.textContent = text;
    }
    rows.push({ el, kind, text, t, end, line, h: 0 });
    reelEl.appendChild(el);
    return rows.length - 1;
  }

  // The song's name, in the title rows and the paused view.
  function fillTitles() {
    const title = songTitle();
    const artist = songArtist();
    for (const r of rows) {
      if (r.kind !== 'title') continue;
      r.el.querySelector('.tt').textContent = title;
      r.el.querySelector('.ta').textContent = artist ? ` · ${artist}` : '';
      r.text = artist ? `${title} · ${artist}` : title;
    }
    $('ptitle').textContent = title;
    $('partist').textContent = artist;
  }

  function buildReel() {
    reelEl.replaceChildren();
    rows = [];
    rowOfLine = [];
    breakAfter = [];
    introRow = -1;
    outroRow = -1;
    focus = { row: -1, kind: '' };
    const lines = lyrics.status === 'synced' ? lyrics.lines : [];
    const sungAfter = (i) => {
      let j = i + 1;
      while (j < lines.length && !lines[j].text) j++;
      return j < lines.length ? j : -1;
    };
    const first = sungAfter(-1);
    if (first < 0) {
      // Lyrics without timing, still loading, or none (for a song): the song's name, not an empty island.
      introRow = addRow('title', '', 0, Infinity);
      fillTitles();
      return;
    }
    if (lines[first].t >= INTRO_S) introRow = addRow('title', '', 0, lines[first].t);
    let last = first;
    lines.forEach((line, i) => {
      if (!line.text) {
        rowOfLine[i] = -1;
        return;
      }
      last = i;
      const j = sungAfter(i);
      const next = j >= 0 ? lines[j] : null;
      rowOfLine[i] = addRow('line', line.text, line.t, next ? next.t : line.t + 5, line);
      // The music carrying on alone after this line, from when it has been sung to the next sung line, whether or
      // not the lyrics mark it with empty lines: long enough, and the island draws in until the next line.
      const sung = line.t + singingSpan(line, lines[i + 1]);
      if (next && next.t - sung >= BREAK_S) {
        const pause = { t: sung, end: next.t };
        for (let k = i; k < j; k++) breakAfter[k] = pause;
      }
    });
    outroRow = addRow('title', '', lines[last].t + singingSpan(lines[last], null), Infinity);
    fillTitles();
  }

  function heightOf(r) {
    if (!lineHeight) lineHeight = measure('Ag').height;
    if (!r.h) r.h = r.kind === 'line' ? measure(r.text).height : lineHeight;
    return r.h;
  }
  function forgetHeights() {
    lineHeight = 0;
    for (const r of rows) r.h = 0;
  }
  const widthOf = (r) => (r.kind === 'title' ? Math.min(measure(r.text).width, glass() ? GLASS_ROW_W : ROW_W) : measure(r.text).width);

  // Each line's slot is as tall as the lyric space, so one step of the reel takes the old line all the way out.
  function slot() {
    const r = rows[focus.row];
    const h = r ? heightOf(r) : lineHeight || measure('Ag').height;
    return glass() ? Math.max(geo.rowHeight, h + 14) : TOP_PAD + h + BOTTOM_PAD;
  }
  const rowY = (k, f, S) => (k - f) * S + (S - heightOf(rows[k])) / 2;

  // Every row goes to its place relative to the line in focus, on the same spring: the old line is carried up
  // and out as the new one rises from below. rise: the focused line comes up from below (after a pause).
  function applyFocus(jump, from = -1, rise = false) {
    const S = slot();
    const f = focus.row >= 0 ? focus.row : from + 1; // nothing in focus: the last line moves on up and out
    rows.forEach((r, k) => {
      const c = r.el.classList;
      const on = k === focus.row && !pausedView;
      c.toggle('is-now', k === focus.row && focus.kind === 'now');
      c.toggle('is-soon', k === focus.row && focus.kind === 'soon');
      c.toggle('is-on', on);
      if (k !== focus.row) r.el.style.removeProperty('--p');
      const y = rowY(k, f, S);
      const to = { y, opacity: on ? 1 : 0, filter: on ? 'blur(0px)' : 'blur(4px)' };
      const near = Math.abs(k - f) <= 2 || k === from;
      if (jump || !near) move(r.el, to, { duration: 0 });
      else if (rise && on) move(r.el, { y: [y + S, y], opacity: [0, 1], filter: ['blur(4px)', 'blur(0px)'] }, { ...SCROLL, opacity: FADE_IN, filter: FADE_IN });
      else move(r.el, to, { ...SCROLL, delay: on ? 0.04 : 0, opacity: on ? { ...FADE_IN, delay: 0.04 } : FADE_OUT, filter: on ? FADE_IN : FADE_OUT });
    });
  }

  // Paused: the lyric goes up and out and the song's name rises with ▶; playing again, the other way round.
  function setPausedView(on) {
    if (on === pausedView) return;
    pausedView = on;
    const S = slot();
    const r = rows[focus.row];
    if (on) {
      if (r) move(r.el, { y: rowY(focus.row, focus.row, S) - S, opacity: 0, filter: 'blur(4px)' }, { ...SCROLL, opacity: FADE_OUT, filter: FADE_OUT });
      for (const x of rows) x.el.classList.remove('is-on');
      move(pmetaEl, { y: [S * 0.7, 0], opacity: [0, 1] }, { ...SCROLL, opacity: FADE_IN });
    } else {
      move(pmetaEl, { y: -S * 0.7, opacity: 0 }, { ...SCROLL, opacity: FADE_OUT });
      applyFocus(false, -1, true);
    }
  }

  // The line being sung fills with light from left to right (a soft karaoke sweep), word by word when the lyrics
  // have word timing, finishing when the line has probably been sung. A line waiting to be sung brightens over
  // its last moments instead: a count-in.
  function sweep(pos) {
    if (focus.row < 0 || reduceMotion) return;
    const r = rows[focus.row];
    if (focus.kind === 'now') {
      const next = lyrics.lines[lyrics.lines.indexOf(r.line) + 1];
      r.el.style.setProperty('--p', progressAt(r.line, r.line.t + singingSpan(r.line, next), pos).toFixed(3));
    } else if (focus.kind === 'soon') {
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
    // Nothing to sing along to (a talk, a movie clip): stay tucked away.
    const notSong = lyrics.status === 'none' && !(np && np.music);
    if (!hasTrack || notSong) return geo.hasNotch ? 'idle' : 'hidden';
    if (!np.playing) return 'paused'; // however long: the song's name and ▶ wait there
    if (expanded && !holdExpand) return 'expanded';
    return focus.row >= 0 ? 'lyric' : 'compact';
  }

  // The glass island's single row grows for a line that wraps to two lines.
  function rowHeight() {
    if (focus.row < 0 || pausedView) return geo.rowHeight;
    return Math.max(geo.rowHeight, heightOf(rows[focus.row]) + 14);
  }

  // The paused view's width: the longer of the song's name and the artist.
  const pausedWidth = () => Math.max(textWidth(songTitle(), '650 13px'), textWidth(songArtist(), '500 11.5px'));

  function layout(force) {
    const state = stateNow();
    islandEl.dataset.state = state;
    setPausedView(state === 'paused');
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
    if (state === 'paused') {
      w = Math.max(w, Math.min(pausedWidth(), 360) + PAD * 2);
      h = nh + TOP_PAD + PMETA_H + BOTTOM_PAD;
      r = 22;
    } else if ((state === 'lyric' || state === 'expanded') && focus.row >= 0) {
      w = Math.max(w, widthOf(rows[focus.row]) + PAD * 2);
      h = nh + slot();
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
    let w = state === 'compact' ? COMPACT_W : 200;
    let h = geo.rowHeight;
    if (state === 'paused') {
      w = Math.min(420, Math.max(220, pausedWidth() + SIDES + 24));
    } else if ((state === 'lyric' || state === 'expanded') && focus.row >= 0) {
      w = Math.max(w, widthOf(rows[focus.row]) + SIDES + 16);
      h = rowH;
    }
    if (state === 'expanded') {
      w = Math.max(w, EXPANDED_W);
      h += MORE_H;
    }
    w = Math.min(w, GLASS_MAX_W);
    rootStyle.setProperty('--nh', `${state === 'expanded' ? h - MORE_H : h}px`); // cover and equaliser line up with the row
    // A few pixels of width do not deserve a window resize; a new line that is much wider or narrower does.
    // Nothing to show (not a song, nothing playing): the app fades the glass away rather than leave it empty.
    const show = state !== 'hidden';
    const changed = Math.abs(w - asked.w) > 18 || h !== asked.h || show !== asked.show;
    if (!force && !changed) return undefined;
    asked = { w, h, show };
    api.islandSize(w, h, show);
    return undefined;
  }

  // What the island shows now: one line at a time, so timing does the reading-ahead.
  function pick(pos) {
    if (!rows.length) return { row: -1, kind: '' };
    if (lyrics.status !== 'synced' || !rowOfLine.length) return { row: introRow, kind: 'title' };
    const lines = lyrics.lines;
    const i = indexAt(lines, pos);
    let j = i + 1;
    while (j < lines.length && !lines[j].text) j++;
    const cur = i >= 0 ? lines[i] : null;
    const next = j < lines.length ? lines[j] : null;
    const brk = i >= 0 ? breakAfter[i] : undefined;
    const comingIn = !!next && next.t - pos < SOON_S;
    // An instrumental break: nothing to read, so the island draws in to the cover and the equaliser.
    const BREAK = { row: -1, kind: 'break' };
    if (cur && cur.text) {
      // the next line takes over once this one has probably been sung (handoverAt), early enough to read
      if (next && (pos >= handoverAt(cur, next) || (brk && comingIn))) return { row: rowOfLine[j], kind: 'soon' };
      if (brk && pos >= brk.t + LINGER_S) return BREAK;
      if (!next && pos >= rows[outroRow].t + LINGER_S) return { row: outroRow, kind: 'title' };
      return { row: rowOfLine[i], kind: 'now' };
    }
    if (next && (comingIn || (!brk && (cur || introRow < 0)))) return { row: rowOfLine[j], kind: 'soon' };
    if (brk) return BREAK;
    if (!cur && introRow >= 0) return { row: introRow, kind: 'title' };
    if (!next && outroRow >= 0) return { row: outroRow, kind: 'title' };
    return { row: -1, kind: '' };
  }

  function tick() {
    const pos = position();
    const { row, kind } = np ? pick(pos) : { row: -1, kind: '' };
    if (row !== focus.row || kind !== focus.kind) {
      const previous = focus.row;
      const jump = previous >= 0 && row >= 0 && Math.abs(row - previous) > 3; // a seek: land, don't scroll past many lines
      const rise = previous < 0 && row >= 0; // something to show after nothing: it comes up from below
      focus = { row, kind };
      applyFocus(jump, previous, rise);
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
    forgetHeights(); // the text size may have changed
    if (rows.length) applyFocus(true);
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
    if (!inside) holdExpand = false;
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

  // State mirrored onto <body data-*> for DevTools and the e2e test, and changes to the app's diagnostics.
  let told = '';
  function publish(state) {
    const r = rows[focus.row];
    const now = `${state}|${focus.kind}|${focus.row}`;
    if (now !== told && geo.active) {
      told = now;
      api.islandDiag({ state, item: focus.kind, row: focus.row, rows: rows.length, lyrics: lyrics.status, key: lyrics.key, position: Math.round(position() * 10) / 10, playing: !!(np && np.playing), text: r ? r.text.slice(0, 60) : '' });
    }
    Object.assign(document.body.dataset, {
      state,
      mode: glass() ? 'glass' : 'notch',
      text: r && focus.kind === 'now' ? r.text : '',
      soon: r && focus.kind === 'soon' ? r.text : '',
      item: focus.kind, // now · soon · title · break
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
    forgetHeights(); // the glass row has its own font size
    if (rows.length) applyFocus(true);
    layout(true);
    // Laid out for this screen: the app may show the window now (never before, so no half-made frame shows).
    if (!ready) {
      ready = true;
      requestAnimationFrame(() => requestAnimationFrame(() => api.islandReady()));
    }
  });
  api.on('np', (report) => {
    np = report;
    islandEl.classList.toggle('playing', np.playing);
    islandEl.classList.toggle('paused', !np.playing);
    if (lyrics.status !== 'synced' || !lyrics.source) {
      $('title').textContent = np.title || '';
      $('artist').textContent = np.artist || '';
    }
    fillTitles();
  });
  api.on('lyrics', (result) => {
    lyrics = result;
    if (result.source && result.status === 'synced') {
      $('title').textContent = result.source.title || $('title').textContent;
      $('artist').textContent = result.source.artist || $('artist').textContent;
    }
    if (np && !(result.source && result.status === 'synced')) {
      $('title').textContent = np.title || '';
      $('artist').textContent = np.artist || '';
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
  // ▶ on the paused island: play, and stay a one-line island (the lyric rises) rather than open the controls.
  $('resume').addEventListener('click', () => {
    holdExpand = true;
    command('toggle');
    tick();
  });
  $('next').addEventListener('click', () => command('next'));
  $('open').addEventListener('click', () => api.restore());
  $('disc').addEventListener('click', () => api.restore());
  $('earlier').addEventListener('click', () => api.nudge(0.5));
  $('later').addEventListener('click', () => api.nudge(-0.5));

  // Read-only hook for DevTools and the e2e test.
  window.__floatlyrics = {
    position,
    state: () => islandEl.dataset.state,
    rows: () => rows.map((r) => ({ kind: r.kind, t: r.t, end: r.end })),
    breaks: () => [...new Set(breakAfter.filter(Boolean))],
  };

  layout(true);
  requestAnimationFrame(loop);
  setInterval(tick, 200); // keeps time even if the system pauses animation frames
})();
