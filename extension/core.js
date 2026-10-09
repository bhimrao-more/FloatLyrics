/*
 * FloatLyrics core — LRC parsing, track-name cleanup and the LRCLIB lookup.
 * No DOM and no chrome.* in here, so the same file runs in the service worker,
 * in the content script and under Node for tests.
 */
(function (root) {
  'use strict';

  const LRCLIB = 'https://lrclib.net/api';
  const ACCEPT = 60; // below this a candidate is more likely a different song than a match
  const MIN_LINES = 4; // LRCLIB is crowd-sourced and holds stub entries such as a lone "[00:00.00]probe"

  function normalize(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
      .trim();
  }

  function primaryArtist(artist) {
    const full = String(artist || '').trim();
    const first = full.split(/\s*(?:,|;|•|\s&\s|\sx\s|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s|\swith\s)\s*/i)[0];
    return (first || full).trim();
  }

  // Words that mark a bracket or a " - suffix" as packaging rather than part of the song's name.
  const NOISE =
    /\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|version|edit|mix|live|feat\.?|ft\.?|featuring|from|hd|hq|4k|explicit|clean|mono|stereo|deluxe|bonus|acoustic|soundtrack|ost|prod\.?|demo|instrumental)\b/i;

  function cleanTitle(title, artist) {
    const original = String(title || '').trim();
    let t = original.replace(/\s*[([{][^)\]}]*[)\]}]/g, (seg) => (NOISE.test(seg) ? '' : seg));

    // "Artist - Title" uploads
    const a = normalize(primaryArtist(artist));
    const parts = t.split(/\s+[-–—]\s+/);
    if (a && parts.length === 2) {
      if (normalize(parts[0]) === a) t = parts[1];
      else if (normalize(parts[1]) === a) t = parts[0];
    }

    // "Title - Remastered 2011", "Title - Radio Edit"
    const tail = t.match(/^(.*\S)\s+[-–—]\s+([^-–—]{1,40})$/);
    if (tail && NOISE.test(tail[2])) t = tail[1];

    t = t.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '');
    return t.replace(/\s+/g, ' ').trim() || original;
  }

  // "[01:02.34] text" lines, several stamps per line, optional [offset:ms] tag. Returns [{ t, text }] sorted by time.
  function parseLrc(lrc) {
    const out = [];
    let offset = 0;
    const stamp = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
    for (const raw of String(lrc || '').split(/\r?\n/)) {
      const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
      if (off) {
        offset = parseInt(off[1], 10) / 1000;
        continue;
      }
      const times = [];
      let rest = raw;
      let m;
      while ((m = rest.match(stamp))) {
        const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
        times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
        rest = rest.slice(m[0].length);
      }
      if (!times.length) continue;
      const text = rest.replace(/<\d{1,3}:\d{1,2}(?:\.\d{1,3})?>/g, '').trim();
      for (const t of times) out.push({ t: Math.max(0, t - offset), text });
    }
    return out.sort((x, y) => x.t - y.t);
  }

  // Index of the line being sung at `pos` seconds, or -1 before the first line.
  function indexAt(lines, pos) {
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= pos) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  const hasSynced = (c) => (String(c.syncedLyrics || '').match(/^\s*\[\d/gm) || []).length >= MIN_LINES;
  const hasPlain = (c) => String(c.plainLyrics || '').split('\n').filter((l) => l.trim()).length >= MIN_LINES;

  function scoreCandidate(c, want) {
    let s;
    if (hasSynced(c)) s = 100;
    else if (hasPlain(c)) s = 10;
    else if (c.instrumental) s = 5;
    else return -Infinity;

    const wt = normalize(want.title);
    const ct = normalize(cleanTitle(c.trackName || c.name, c.artistName));
    if (ct && ct === wt) s += 40;
    else if (ct && wt && (ct.includes(wt) || wt.includes(ct))) s += 20;
    else s -= 60;

    const wa = normalize(want.artist);
    const ca = normalize(c.artistName);
    if (wa) {
      if (ca === wa) s += 30;
      else if (ca && (ca.includes(wa) || wa.includes(ca))) s += 20;
      else if (normalize(c.trackName).includes(wa)) s += 10;
      else s -= 40;
    }

    if (want.duration && c.duration) {
      const d = Math.abs(c.duration - want.duration);
      s += d <= 2 ? 40 - d : d <= 5 ? 25 : d <= 10 ? 5 : d <= 20 ? -30 : -80;
    }
    return s;
  }

  /*
   * track: { title, artist, duration (seconds, 0 if unknown) }
   * fetchJson(url): resolves parsed JSON, null on 404, rejects on network/server failure.
   * Resolves { status: 'synced' | 'plain' | 'instrumental' | 'none' | 'error', lines?, approx?, source? }.
   */
  async function findLyrics(track, fetchJson) {
    const title = String((track && track.title) || '').trim();
    const artist = String((track && track.artist) || '').trim();
    if (!title) return { status: 'none' };

    const want = {
      title: cleanTitle(title, artist),
      artist: primaryArtist(artist),
      duration: track.duration > 0 ? Number(track.duration) : 0,
    };
    const confidentAt = want.duration ? 190 : 160;

    const pool = new Map();
    let attempts = 0;
    let failures = 0;
    const run = async (path, params) => {
      attempts++;
      try {
        const res = await fetchJson(`${LRCLIB}${path}?${new URLSearchParams(params)}`);
        for (const c of Array.isArray(res) ? res : [res]) if (c && c.id != null) pool.set(c.id, c);
      } catch (err) {
        failures++;
      }
    };
    const best = () => {
      let top = null;
      for (const c of pool.values()) {
        const score = scoreCandidate(c, want);
        if (!top || score > top.score) top = { c, score };
      }
      return top;
    };
    const confident = () => {
      const b = best();
      return !!b && hasSynced(b.c) && b.score >= confidentAt;
    };

    // Exact signature first (cheap, precise), then progressively looser searches.
    if (want.duration && artist) {
      await run('/get', { track_name: title, artist_name: artist, duration: Math.round(want.duration) });
    }
    if (!confident() && want.artist) await run('/search', { track_name: want.title, artist_name: want.artist });
    if (!confident()) await run('/search', { q: `${want.title} ${want.artist}`.trim() });
    const sofar = best();
    if ((!sofar || sofar.score < ACCEPT) && want.artist) await run('/search', { track_name: want.title });

    const b = best();
    if (!b || b.score < ACCEPT) return { status: attempts > 0 && failures === attempts ? 'error' : 'none' };

    const c = b.c;
    const source = {
      provider: 'LRCLIB',
      id: c.id,
      title: c.trackName,
      artist: c.artistName,
      album: c.albumName,
      duration: c.duration,
    };
    const lines = hasSynced(c) ? parseLrc(c.syncedLyrics) : [];
    if (lines.length) {
      const approx = !!(want.duration && c.duration && Math.abs(c.duration - want.duration) > 5);
      return { status: 'synced', lines, approx, source };
    }
    if (hasPlain(c)) {
      const plain = c.plainLyrics.split(/\r?\n/).map((text) => ({ t: -1, text: text.trim() }));
      return { status: 'plain', lines: plain, source };
    }
    if (c.instrumental) return { status: 'instrumental', source };
    return { status: 'none' };
  }

  const api = { normalize, primaryArtist, cleanTitle, parseLrc, indexAt, scoreCandidate, findLyrics };
  root.FloatLyricsCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
