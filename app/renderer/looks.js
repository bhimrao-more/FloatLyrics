/*
 * FloatLyrics appearance settings: the few knobs people get, their allowed steps, and the defaults.
 * Deliberately small, like Apple's own: every combination still looks like FloatLyrics.
 * Shared by the main process (validation, storage) and the windows (rendering).
 */
(function (root) {
  'use strict';

  const THEMES = [
    { id: 'cover', name: 'Cover', note: 'Colours from the album art' },
    { id: 'clear', name: 'Clear', note: 'Most see-through' },
    { id: 'tinted', name: 'Tinted', note: 'Darker glass, easiest to read' },
    { id: 'graphite', name: 'Graphite', note: 'Neutral glass, no cover colour' },
    { id: 'light', name: 'Light', note: 'Light glass, dark text' },
  ];

  // Each setting is an index into its list of steps.
  const STEPS = {
    textSize: [0.85, 1, 1.15, 1.3], // lyric size
    clarity: [0.4, 0.7, 1, 1.4, 1.8], // veil over the glass: clear → frosted
    cover: [0, 0.5, 1, 1.3, 1.6], // how much colour the cover lends
  };
  const STEP_NAMES = {
    textSize: ['Small', 'Default', 'Large', 'Extra large'],
    clarity: ['Clearest', 'Clear', 'Default', 'Frosted', 'Most frosted'],
    cover: ['None', 'Subtle', 'Default', 'Rich', 'Richest'],
  };

  // island: minimising the window hands the lyrics to a Dynamic Island around the MacBook notch.
  const DEFAULTS = { theme: 'cover', textSize: 1, clarity: 2, cover: 2, focus: true, align: 'center', onTop: true, island: true };

  // Whatever comes in, what goes out is a valid, complete settings object.
  function sanitize(input) {
    const s = { ...DEFAULTS, ...(input && typeof input === 'object' ? input : {}) };
    const out = {};
    out.theme = THEMES.some((t) => t.id === s.theme) ? s.theme : DEFAULTS.theme;
    for (const k of Object.keys(STEPS)) {
      const n = Math.round(Number(s[k]));
      out[k] = Number.isFinite(n) ? Math.min(STEPS[k].length - 1, Math.max(0, n)) : DEFAULTS[k];
    }
    out.focus = s.focus !== false;
    out.align = s.align === 'left' ? 'left' : 'center';
    out.onTop = s.onTop !== false;
    out.island = s.island !== false;
    return out;
  }

  const api = { THEMES, STEPS, STEP_NAMES, DEFAULTS, sanitize };
  root.FloatLyricsLooks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
