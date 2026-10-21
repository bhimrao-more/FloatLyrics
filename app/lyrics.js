/*
 * Lyrics lookups for the desktop app: LRCLIB through the shared matcher in extension/core.js,
 * cached in a JSON file so a song played again opens instantly.
 */
const fs = require('node:fs');
const { findLyrics, normalize } = require('../extension/core.js');
const { version } = require('../package.json');

const FOUND_TTL = 30 * 24 * 3600 * 1000;
const MISS_TTL = 6 * 3600 * 1000; // LRCLIB is crowd-sourced; a miss today may be filled in tomorrow
const MAX_ENTRIES = 600;
const HEADERS = { 'User-Agent': `FloatLyrics/${version} (https://github.com/bhimrao-more/FloatLyrics)` };

async function fetchJson(url, retried) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (res.status === 404) return null;
  // LRCLIB rate-limits bursts and says when to come back; wait that long (at most 5s) and try once more.
  if (res.status === 429 && !retried) {
    const wait = Math.min(5, Number(res.headers.get('retry-after')) || 1);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return fetchJson(url, true);
  }
  if (!res.ok) throw new Error(`LRCLIB responded ${res.status}`);
  return res.json();
}

function createLyrics(cacheFile) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch (err) {}
  const inflight = new Map();
  let saveTimer = null;
  let failing = Number(process.env.FL_FAIL_LOOKUPS) || 0; // tests: the first lookups fail as if LRCLIB were down

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const keys = Object.keys(cache);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => cache[a].at - cache[b].at);
        for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[k];
      }
      fs.writeFile(cacheFile, JSON.stringify(cache), () => {});
    }, 1000);
  }

  // track: { title, artist, duration, alt?, tempo? } as videoTrack()/the player gives it
  function lookup(track) {
    const key = `${track.tempo ? '~' : ''}${normalize(track.title)}|${normalize(track.artist)}|${Math.round((track.duration || 0) / 5)}`;
    if (failing > 0) {
      failing--;
      return Promise.resolve({ status: 'error' });
    }
    const hit = cache[key];
    if (hit && Date.now() - hit.at < (hit.result.status === 'none' ? MISS_TTL : FOUND_TTL)) return Promise.resolve(hit.result);
    if (!inflight.has(key)) {
      inflight.set(
        key,
        findLyrics(track, fetchJson)
          .then((result) => {
            if (result.status !== 'error') {
              cache[key] = { at: Date.now(), result };
              save();
            }
            return result;
          })
          .finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  }

  return { lookup };
}

module.exports = { createLyrics };
