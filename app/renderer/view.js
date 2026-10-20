/*
 * FloatLyrics window: renders what the main process reports (now playing, cover, lyrics) and keeps the
 * highlighted line on the music. Runs sandboxed; window.floatlyrics (preload.js) is its only way out.
 */
(() => {
  'use strict';
  const { indexAt } = window.FloatLyricsCore;
  const looks = window.FloatLyricsLooks;
  const api = window.floatlyrics;
  const $ = (id) => document.getElementById(id);

  const MESSAGES = {
    idle: 'Play a song anywhere on your Mac',
    loading: 'Finding lyrics…',
    none: 'No lyrics found for this track',
    notSong: "No lyrics — this doesn't look like a song",
    ad: 'Waiting for the song…',
    instrumental: '♪ Instrumental',
    error: 'Could not reach the lyrics service',
  };

  const el = {
    root: $('fl'),
    bg: $('bg'),
    lines: $('lines'),
    msg: $('msg'),
    head: $('head'),
    thumb: $('thumb'),
    title: $('title'),
    artist: $('artist'),
    foot: $('foot'),
    sync: $('sync'),
  };

  let np = null; // latest now-playing report
  let lyrics = { status: 'idle', key: '' };
  let offset = 0; // the user's nudge for this track, seconds (kept by the main process)
  let nodes = [];
  let active = -2;
  let art = '';
  let settings = looks.DEFAULTS;

  // Where the song is now: the player's last report, run forward on the wall clock.
  function position() {
    if (!np) return 0;
    const drift = np.playing ? Math.max(0, ((Date.now() - np.at) / 1000) * np.rate) : 0;
    return np.elapsed + drift + np.lead + offset;
  }

  function renderHead() {
    const src = lyrics.source && lyrics.status !== 'loading' ? lyrics.source : np || {};
    el.title.textContent = src.title || 'FloatLyrics';
    el.artist.textContent = src.artist ? `— ${src.artist}` : '';
    el.root.classList.toggle('is-playing', !!(np && np.playing));
  }

  function renderLyrics() {
    const hasLines = lyrics.status === 'synced' || lyrics.status === 'plain';
    el.root.classList.toggle('is-plain', lyrics.status === 'plain');
    el.lines.hidden = !hasLines;
    el.msg.hidden = hasLines;
    const notSong = lyrics.status === 'none' && np && !np.music;
    el.msg.textContent = MESSAGES[notSong ? 'notSong' : lyrics.status] || '';
    nodes = [];
    active = -2;
    el.lines.replaceChildren();
    if (hasLines) {
      for (const line of lyrics.lines) {
        const p = document.createElement('p');
        p.className = 'fl-line';
        p.textContent = line.text || (lyrics.status === 'synced' ? '♪' : ' ');
        nodes.push(p);
        el.lines.appendChild(p);
      }
    }
    el.lines.scrollTop = 0;
    renderSync();
    renderHead();
    publish(-1);
  }

  function renderSync() {
    el.sync.textContent = `${offset > 0 ? '+' : ''}${offset.toFixed(1)}s`;
    // Several recordings matched (live, acoustic…): let the person step through them.
    const versions = lyrics.versions || [];
    const v = $('version');
    v.hidden = versions.length < 2;
    if (versions.length > 1) {
      const n = (lyrics.version || 0) + 1;
      const src = versions[lyrics.version || 0].source;
      v.textContent = `${n}/${versions.length}`;
      v.title = `Lyrics version ${n} of ${versions.length} (${src.album || src.title}, ${Math.round(src.duration)}s). Click to try another.`;
    }
    for (const l of lenses) l.update();
  }

  // The active line glides to the middle on a spring (Motion), not the browser's stock smooth scroll.
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SCROLL = { type: 'spring', stiffness: 150, damping: 26, mass: 1 }; // critically damped: no wobble under the words
  let scrolling = null;
  function center(smooth) {
    const cur = nodes[active];
    const top = cur ? cur.offsetTop + cur.offsetHeight / 2 - el.lines.clientHeight / 2 : 0;
    if (scrolling) scrolling.stop();
    scrolling = null;
    if (!smooth || reduceMotion || !window.Motion) {
      el.lines.scrollTop = top;
      return;
    }
    scrolling = window.Motion.animate(el.lines.scrollTop, top, { ...SCROLL, onUpdate: (v) => (el.lines.scrollTop = v) });
  }

  function tick() {
    if (lyrics.status !== 'synced') return;
    const i = indexAt(lyrics.lines, position());
    if (i === active) return;
    if (nodes[active]) nodes[active].classList.remove('is-active');
    active = i;
    if (nodes[i]) nodes[i].classList.add('is-active');
    center(true);
    publish(i);
  }

  function loop() {
    tick();
    requestAnimationFrame(loop);
  }

  function showArt(url) {
    if (!url || url === art) return;
    art = url;
    const fresh = ['a', 'b'].map((k) => {
      const img = document.createElement('img');
      img.className = `fl-art ${k}`;
      img.alt = '';
      return img;
    });
    fresh[0].addEventListener(
      'load',
      () => {
        if (art !== url) return;
        const old = [...el.bg.querySelectorAll('.fl-art.is-shown')];
        for (const img of fresh) img.classList.add('is-shown');
        el.thumb.src = url;
        el.thumb.classList.add('is-shown');
        setTimeout(() => old.forEach((n) => n.remove()), 1200);
        document.body.dataset.art = 'loaded';
      },
      { once: true },
    );
    for (const img of fresh) {
      img.src = url;
      el.bg.appendChild(img);
    }
  }

  // State mirrored onto <body data-*> for DevTools and the e2e test.
  function publish(i) {
    const d = document.body.dataset;
    const line = lyrics.status === 'synced' && i >= 0 ? lyrics.lines[i] : null;
    const next = lyrics.status === 'synced' ? lyrics.lines[i + 1] : null;
    Object.assign(d, {
      status: lyrics.status,
      track: np && np.title ? `${np.title} — ${np.artist}` : '',
      app: np ? np.app : '',
      npApp: np ? np.npApp || '' : '',
      playing: np && np.playing ? '1' : '0',
      match: lyrics.source ? `${lyrics.source.title} — ${lyrics.source.artist} (${lyrics.source.duration}s)` : '',
      line: String(i),
      lineT: line ? String(line.t) : '',
      nextT: next ? String(next.t) : '',
      text: line ? line.text : '',
    });
  }

  /* ---------- appearance ---------- */

  function applySettings(next) {
    settings = next;
    const root = el.root;
    root.dataset.theme = settings.theme;
    root.dataset.align = settings.align;
    root.classList.toggle('no-focus', !settings.focus);
    root.style.setProperty('--text-scale', looks.STEPS.textSize[settings.textSize]);
    root.style.setProperty('--clarity', looks.STEPS.clarity[settings.clarity]);
    root.style.setProperty('--cover', looks.STEPS.cover[settings.cover]);
    for (const b of swatches) b.setAttribute('aria-pressed', String(b.dataset.theme === settings.theme));
    $('smaller').disabled = settings.textSize <= 0;
    $('larger').disabled = settings.textSize >= looks.STEPS.textSize.length - 1;
    document.body.dataset.theme = settings.theme;
    requestAnimationFrame(() => center(false)); // line heights change with text size
  }

  const swatches = looks.THEMES.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fl-swatch';
    b.dataset.theme = t.id;
    b.title = `${t.name} — ${t.note}`;
    b.setAttribute('aria-label', t.name);
    b.addEventListener('click', () => api.setSettings({ theme: t.id }));
    $('swatches').appendChild(b);
    return b;
  });

  function togglePop(open) {
    const pop = $('pop');
    const show = open == null ? pop.hidden : open;
    pop.hidden = !show;
    $('look').setAttribute('aria-expanded', String(show));
  }

  // The main process keeps the nudge per track and shares it with the island.
  // ⇄ appears when more than one player is open or playing; it says who is followed and steps to the next.
  function renderSources() {
    const b = $('source');
    const list = (np && np.sources) || [];
    document.body.dataset.sources = String(list.length);
    document.body.dataset.sourceNames = list.map((x) => x.label).join('|');
    b.hidden = list.length < 2;
    if (list.length < 2) return;
    const i = Math.max(0, list.findIndex((x) => x.id === np.sourceId));
    const next = list[(i + 1) % list.length];
    b.textContent = `⇄ ${list.length}`;
    b.title = `Following ${list[i].label}${list[i].playing ? '' : ' (paused)'}. Click to follow ${next.label}${next.playing ? '' : ' (paused)'}.`;
  }

  function nudge(delta) {
    api.nudge(delta);
  }

  function command(name) {
    if (name === 'toggle' && np) {
      np.playing = !np.playing; // answer the click now; the next report confirms it
      renderHead();
    }
    api.command(name).catch((err) => console.warn('[FloatLyrics] command failed', name, err));
  }

  /* ---------- wiring ---------- */

  api.on('np', (report) => {
    np = report;
    renderSources();
    $('note').hidden = !(np.noPosition && np.playing && lyrics.status === 'synced');
    renderHead();
    Object.assign(document.body.dataset, {
      playing: np.playing ? '1' : '0',
      app: np.app || '',
      npApp: np.npApp || '',
      track: np.title ? `${np.title} — ${np.artist}` : '',
    });
  });
  api.on('lyrics', (result) => {
    lyrics = result;
    renderLyrics();
  });
  api.on('offset', (o) => {
    if (np && o.key !== np.key) return;
    offset = o.value;
    renderSync();
  });
  api.on('art', showArt);
  api.on('settings', applySettings);
  // Controls show while the pointer is over the window, and linger a moment after it leaves.
  let hoverTimer = null;
  api.on('hover', (inside) => {
    clearTimeout(hoverTimer);
    if (inside) el.root.classList.add('is-hover');
    else hoverTimer = setTimeout(() => el.root.classList.remove('is-hover'), 900);
  });
  api.on('glass', (mode) => {
    el.root.classList.add(`glass-${mode}`);
    document.body.dataset.glass = mode;
  });

  $('prev').addEventListener('click', () => command('previous'));
  $('play').addEventListener('click', () => command('toggle'));
  $('next').addEventListener('click', () => command('next'));
  $('earlier').addEventListener('click', () => nudge(0.5));
  $('later').addEventListener('click', () => nudge(-0.5));
  $('close').addEventListener('click', () => api.close());
  $('min').addEventListener('click', () => api.minimize());
  $('version').addEventListener('click', () => api.chooseVersion((lyrics.version || 0) + 1));
  $('source').addEventListener('click', () => api.nextSource());
  $('look').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePop();
  });
  $('smaller').addEventListener('click', () => api.setSettings({ textSize: settings.textSize - 1 }));
  $('larger').addEventListener('click', () => api.setSettings({ textSize: settings.textSize + 1 }));
  $('advanced').addEventListener('click', () => {
    togglePop(false);
    api.openSettings();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('pop').hidden && !e.target.closest('#pop, #look')) togglePop(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') togglePop(false);
    else if (e.key === ' ') command('toggle');
    else if (e.key === 'ArrowRight') command('next');
    else if (e.key === 'ArrowLeft') command('previous');
    else return;
    e.preventDefault();
  });

  // The capsules refract what scrolls beneath them (glass.js).
  const lenses = [
    window.FloatLyricsGlass.lens(document, el.head, { bezel: 14, thickness: 22, after: 'blur(2px) saturate(1.35) brightness(1.05)' }),
    window.FloatLyricsGlass.lens(document, el.foot, { bezel: 12, thickness: 18, after: 'blur(2px) saturate(1.35) brightness(1.05)' }),
  ];
  window.addEventListener('resize', () => {
    for (const l of lenses) l.update();
    center(false);
  });

  // Moving the window by its title or cover, done here rather than with a macOS drag area (-webkit-app-region),
  // which with a real mouse made the whole window a drag handle and swallowed every click.
  let moving = false;
  for (const handle of [el.thumb, document.querySelector('.fl-meta')]) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      moving = true;
      handle.setPointerCapture(e.pointerId);
      el.root.classList.add('is-moving');
      api.moveStart();
    });
    const stop = () => {
      if (!moving) return;
      moving = false;
      el.root.classList.remove('is-moving');
      api.moveEnd();
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop); // never leave the window glued to the cursor
  }

  // Read-only hooks for DevTools and the e2e test.
  window.__floatlyrics = { position, nowPlaying: () => np };

  applySettings(settings);
  renderLyrics();
  requestAnimationFrame(loop);
  setInterval(tick, 200); // keeps time even if the system pauses animation frames
})();
