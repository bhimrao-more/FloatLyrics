// Appearance settings must always come out valid, whatever the stored file or a window sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitize, DEFAULTS, THEMES, STEPS } = require('../app/renderer/looks.js');

test('defaults are the default look', () => {
  assert.deepEqual(sanitize({}), DEFAULTS);
  assert.deepEqual(sanitize(null), DEFAULTS);
  assert.equal(THEMES.length, 5);
});

test('out-of-range and unknown values fall back or clamp', () => {
  assert.equal(sanitize({ island: 'nope' }).island, true);
  assert.equal(sanitize({ islandScreen: 'moon' }).islandScreen, 'notch');
  assert.equal(sanitize({ vinyl: 'shellac' }).vinyl, 'off');
  const s = sanitize({ theme: 'neon', textSize: 99, clarity: -3, cover: '2', focus: 0, align: 'right', onTop: 'yes', extra: 1 });
  assert.equal(s.theme, 'cover');
  assert.equal(s.textSize, STEPS.textSize.length - 1);
  assert.equal(s.clarity, 0);
  assert.equal(s.cover, 2);
  assert.equal(s.focus, true);
  assert.equal(s.align, 'center');
  assert.equal(s.onTop, true);
  assert.equal('extra' in s, false);
});

test('valid choices are kept', () => {
  const s = sanitize({ theme: 'light', textSize: 3, clarity: 4, cover: 0, focus: false, align: 'left', onTop: false, island: false, islandScreen: 'window', vinyl: 'worn', vinylLevel: 4 });
  assert.deepEqual(s, { theme: 'light', textSize: 3, clarity: 4, cover: 0, focus: false, align: 'left', onTop: false, island: false, islandScreen: 'window', islandScreenName: '', vinyl: 'worn', vinylLevel: 4 });
});

test('the island can be pinned to one screen, remembered by name too', () => {
  const s = sanitize({ islandScreen: 'display:3', islandScreenName: 'BenQ GW2780' });
  assert.equal(s.islandScreen, 'display:3');
  assert.equal(s.islandScreenName, 'BenQ GW2780');
  assert.equal(sanitize({ islandScreen: 'display:x' }).islandScreen, 'notch');
  assert.equal(sanitize({ islandScreen: 'notch', islandScreenName: 'BenQ' }).islandScreenName, '');
});
