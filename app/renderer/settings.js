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

  for (const key of ['textSize', 'clarity', 'cover', 'vinylLevel']) {
    $(key).addEventListener('input', (e) => {
      $(`${key}Out`).textContent = looks.STEP_NAMES[key][e.target.value];
      api.setSettings({ [key]: Number(e.target.value) });
    });
  }
  for (const id of ['align', 'vinyl']) {
    for (const b of $(id).querySelectorAll('button')) b.addEventListener('click', () => api.setSettings({ [id]: b.dataset.value }));
  }

  // Where the island appears: automatic, the window's screen, or any connected screen by name.
  let screens = [];
  const pick = $('islandScreen');
  function fillScreens() {
    const option = (value, label, name) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      if (name) o.dataset.name = name;
      return o;
    };
    const fixed = screens.filter((s) => !s.id.startsWith('display:'));
    const each = screens.filter((s) => s.id.startsWith('display:'));
    const group = document.createElement('optgroup');
    group.label = 'Screens';
    for (const s of each) group.appendChild(option(s.id, s.notch ? `${s.label} (notch)` : s.label, s.name));
    pick.replaceChildren(...fixed.map((s) => option(s.id, s.id === 'notch' ? `Automatic: ${s.label}` : s.label)), group);
    // A chosen screen that is unplugged stays chosen, so the island goes back there when it returns.
    if (settings.islandScreen.startsWith('display:') && !each.some((s) => s.id === settings.islandScreen)) {
      const gone = option(settings.islandScreen, `${settings.islandScreenName || 'Screen'} (not connected)`, settings.islandScreenName);
      gone.disabled = true;
      group.appendChild(gone);
    }
    pick.value = settings.islandScreen;
  }
  pick.addEventListener('change', () => {
    const o = pick.selectedOptions[0];
    api.setSettings({ islandScreen: pick.value, islandScreenName: (o && o.dataset.name) || '' });
  });
  api.on('displays', (list) => {
    screens = list;
    fillScreens();
  });
  api.displays().then((list) => {
    screens = list;
    fillScreens();
  });
  for (const key of ['focus', 'onTop', 'island']) $(key).addEventListener('change', (e) => api.setSettings({ [key]: e.target.checked }));
  $('reset').addEventListener('click', () => api.resetSettings());

  function render(next) {
    settings = next;
    for (const t of themeButtons) t.el.setAttribute('aria-checked', String(t.id === settings.theme));
    for (const key of ['textSize', 'clarity', 'cover', 'vinylLevel']) {
      $(key).value = settings[key];
      $(`${key}Out`).textContent = looks.STEP_NAMES[key][settings[key]];
    }
    for (const id of ['align', 'vinyl']) {
      for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === settings[id]));
    }
    if (screens.length) fillScreens();
    $('vinylLevel').disabled = settings.vinyl === 'off';
    $('focus').checked = settings.focus;
    $('onTop').checked = settings.onTop;
    $('island').checked = settings.island;
  }

  api.on('settings', render);
  render(settings);
})();
