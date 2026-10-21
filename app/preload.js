// The only bridge between the window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['np', 'art', 'lyrics', 'glass', 'settings', 'offset', 'island', 'hover', 'displays'];

contextBridge.exposeInMainWorld('floatlyrics', {
  on(channel, fn) {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_event, data) => fn(data));
  },
  command: (name) => ipcRenderer.invoke('command', name),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  openSettings: () => ipcRenderer.send('settings:open'),
  nudge: (delta) => ipcRenderer.send('nudge', delta),
  islandHover: (inside) => ipcRenderer.send('island:hover', !!inside),
  islandSize: (w, h, show) => ipcRenderer.send('island:size', w, h, !!show),
  islandReady: () => ipcRenderer.send('island:ready'),
  displays: () => ipcRenderer.invoke('displays'),
  minimize: () => ipcRenderer.send('window:minimize'),
  restore: () => ipcRenderer.send('window:restore'),
  chooseVersion: (index) => ipcRenderer.send('lyrics:version', index),
  nextSource: () => ipcRenderer.send('source:next'),
  loadSound: (name) => ipcRenderer.invoke('sound:get', name),
  close: () => ipcRenderer.send('close'),
  moveStart: () => ipcRenderer.send('move:start'),
  moveEnd: () => ipcRenderer.send('move:end'),
});
