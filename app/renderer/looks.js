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
    vinylLevel: [0.35, 0.6, 1, 1.5, 2.2], // record crackle loudness
  };
  const VINYL = ['off', 'light', 'worn', 'scratched'];
  const STEP_NAMES = {
    textSize: ['Small', 'Default', 'Large', 'Extra large'],
    clarity: ['Clearest', 'Clear', 'Default', 'Frosted', 'Most frosted'],
    cover: ['None', 'Subtle', 'Default', 'Rich', 'Richest'],
    vinylLevel: ['Faint', 'Soft', 'Default', 'Loud', 'Loudest'],
  };

  // island: minimising the window hands the lyrics to a Dynamic Island.
  // islandScreen: where it appears. 'notch': around the MacBook notch (the main screen when there is none);
  // 'window': whichever screen the window is on; 'display:<id>': one particular screen, found again by its name
  // (islandScreenName) if it comes back with another id. Screens without a notch get the glass island.
  const DEFAULTS = { theme: 'cover', textSize: 1, clarity: 2, cover: 2, focus: true, align: 'center', onTop: true, island: true, islandScreen: 'notch', islandScreenName: '', vinyl: 'off', vinylLevel: 2 };

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
    out.islandScreen = s.islandScreen === 'window' || /^display:\d+$/.test(String(s.islandScreen)) ? String(s.islandScreen) : 'notch';
    out.islandScreenName = out.islandScreen.startsWith('display:') ? String(s.islandScreenName || '').slice(0, 120) : '';
    out.vinyl = VINYL.includes(s.vinyl) ? s.vinyl : 'off';
    return out;
  }

  const api = { THEMES, STEPS, STEP_NAMES, VINYL, DEFAULTS, sanitize };
  root.FloatLyricsLooks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
