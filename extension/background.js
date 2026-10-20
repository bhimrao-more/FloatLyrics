/*
 * FloatLyrics service worker — the only place that talks to the network.
 * Content scripts ask for lyrics by message; results are cached in chrome.storage.local.
 */
importScripts('core.js');

const { findLyrics, normalize } = self.FloatLyricsCore;

const FOUND_TTL = 30 * 24 * 3600 * 1000;
const MISS_TTL = 6 * 3600 * 1000; // LRCLIB is crowd-sourced; a miss today may be filled in tomorrow
const MAX_ENTRIES = 400;
const HEADERS = { 'X-User-Agent': `FloatLyrics/${chrome.runtime.getManifest().version} (https://github.com/bhimrao-more/FloatLyrics)` };

const inflight = new Map();

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`LRCLIB responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const cacheKey = (t) => `lyr:v2:${t.tempo ? '~' : ''}${normalize(t.title)}|${normalize(t.artist)}|${Math.round((t.duration || 0) / 5)}`;

async function prune() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith('lyr:'));
  if (entries.length <= MAX_ENTRIES) return;
  entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  await chrome.storage.local.remove(entries.slice(0, entries.length - MAX_ENTRIES).map(([k]) => k));
}

async function lookup(track) {
  const key = cacheKey(track);
  const hit = (await chrome.storage.local.get(key))[key];
  if (hit && Date.now() - hit.at < (hit.result.status === 'none' ? MISS_TTL : FOUND_TTL)) return hit.result;

  if (!inflight.has(key)) {
    inflight.set(
      key,
      findLyrics(track, fetchJson)
        .then(async (result) => {
          if (result.status !== 'error') {
            await chrome.storage.local.set({ [key]: { at: Date.now(), result } });
            if (Math.random() < 0.05) prune().catch(() => {});
          }
          return result;
        })
        .finally(() => inflight.delete(key)),
    );
  }
  return inflight.get(key);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'fl:lyrics') return undefined;
  lookup(msg.track).then(sendResponse, (err) => sendResponse({ status: 'error', error: String(err) }));
  return true; // keep the channel open for the async reply
});
