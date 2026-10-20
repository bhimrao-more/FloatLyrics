/*
 * FloatLyrics Settings window. Every change goes to the main process, which validates it, saves it and
 * sends it to the lyrics window, so the floating window updates live.
 */
(() => {
  'use strict';
  const looks = window.FloatLyricsLooks;
  const api = window.floatlyrics;
  const $ = (id) => document.getElementById(id);
  let settings = looks.DEFAULTS;

  const themeButtons = looks.THEMES.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme';
    b.setAttribute('role', 'radio');
    b.title = t.note;
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.theme = t.id;
    tile.textContent = 'Aa';
    const name = document.createElement('span');
    name.textContent = t.name;
    b.append(tile, name);
    b.addEventListener('click', () => api.setSettings({ theme: t.id }));
    $('themes').appendChild(b);
    return { id: t.id, el: b };
  });

  for (const key of ['textSize', 'clarity', 'cover']) {
    $(key).addEventListener('input', (e) => {
      $(`${key}Out`).textContent = looks.STEP_NAMES[key][e.target.value];
      api.setSettings({ [key]: Number(e.target.value) });
    });
  }
  for (const id of ['align', 'islandScreen']) {
    for (const b of $(id).querySelectorAll('button')) b.addEventListener('click', () => api.setSettings({ [id]: b.dataset.value }));
  }
  for (const key of ['focus', 'onTop', 'island']) $(key).addEventListener('change', (e) => api.setSettings({ [key]: e.target.checked }));
  $('reset').addEventListener('click', () => api.resetSettings());

  function render(next) {
    settings = next;
    for (const t of themeButtons) t.el.setAttribute('aria-checked', String(t.id === settings.theme));
    for (const key of ['textSize', 'clarity', 'cover']) {
      $(key).value = settings[key];
      $(`${key}Out`).textContent = looks.STEP_NAMES[key][settings[key]];
    }
    for (const id of ['align', 'islandScreen']) {
      for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === settings[id]));
    }
    $('focus').checked = settings.focus;
    $('onTop').checked = settings.onTop;
    $('island').checked = settings.island;
  }

  api.on('settings', render);
  render(settings);
})();
