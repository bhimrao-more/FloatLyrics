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
    /\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|version|edit|mix|live|feat\.?|ft\.?|featuring|from|hd|hq|4k|explicit|clean|mono|stereo|deluxe|bonus|acoustic|soundtrack|ost|prod\.?|demo|instrumental|slowed|reverb(ed)?|sped|nightcore|daycore|lo-?fi|8d|bass\s*boost(ed)?)\b/i;
  // Edits played at another speed than the record: the lyric timeline has to be stretched to fit.
  const TEMPO = /\b(slowed|sped\s*up|speed\s*up|nightcore|daycore)\b/i;

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

  /*
   * A youtube.com video is not a track: the title carries the artist and packaging ("Artist - Song (Official
   * Video)", "Song | Movie | Singer") and the uploader is often a label or "Artist - Topic"/"ArtistVEVO".
   * Returns the { title, artist } to look up.
   */
  function videoTrack(title, channel) {
    let artist = String(channel || '')
      .replace(/\s*-\s*topic$/i, '')
      .replace(/\s*vevo$/i, '')
      .replace(/\s+official$/i, '')
      .trim();
    const segments = String(title || '')
      .replace(/^\s*(?:full\s+)?(?:video|audio|lyrical|lyrics?|song)\s*(?:video|song)?\s*:\s*/i, '')
      .replace(/\s*[([{][^)\]}]*[)\]}]/g, (seg) => (NOISE.test(seg) ? '' : seg))
      .split(/\s+[|｜]\s+/);
    let t = segments[0]
      .replace(/\s+(?:full\s+)?(?:official\s+)?(?:music\s+|lyrics?\s+|lyrical\s+)?(?:video|audio)(?:\s+song)?\s*$/i, '')
      .trim();
    const tempo = TEMPO.test(String(title || ''));
    let alt = null;
    const parts = t.split(/\s+[-–—]\s+/);
    if (parts.length === 2) {
      const a = normalize(artist).replace(/ /g, '');
      const same = (x) => normalize(x).replace(/ /g, '') === a;
      if (same(parts[0])) [artist, t] = parts;
      else if (same(parts[1])) t = parts[0];
      // "Song - Movie | Cast | Composer" (film-label uploads) puts the song first
      else if (segments.length > 1) t = parts[0];
      else if (!NOISE.test(parts[1])) {
        // "Artist - Song" is the usual order, but plenty of uploads say "Song - Artist"; keep both to try
        alt = { title: parts[0].trim(), artist: parts[1].trim() };
        [artist, t] = parts;
      }
    }
    const out = { title: t.trim() || String(title || '').trim(), artist };
    if (alt) out.alt = alt;
    if (tempo) out.tempo = true;
    return out;
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
    const tempo = !!(track && track.tempo);
    // A slowed/sped-up edit is longer/shorter than the record, so its length cannot pick the version.
    const base = tempo ? { ...track, duration: 0 } : track;
    let res = await findOne(base, fetchJson);
    if (track && track.alt && track.alt.title) {
      // Which half is the artist is a guess, so ask both ways and keep the closer match.
      const other = await findOne({ ...base, ...track.alt }, fetchJson);
      // Ties go to the reading more LRCLIB entries agree on: a real song has many uploads, a mislabel one.
      const rate = (r) => (r.score || 0) + Math.min(r.votes || 0, 10);
      if (rate(other) > rate(res)) res = other;
    }
    if (tempo && res.status === 'synced' && track.duration > 0 && res.source && res.source.duration > 0) {
      const k = track.duration / res.source.duration;
      if (k > 0.5 && k < 2) {
        res = { ...res, approx: false, stretch: k, lines: res.lines.map((l) => ({ t: l.t * k, text: l.text })) };
        delete res.versions; // other recordings would need their own stretch; the stretched match is the answer
      }
    }
    return res;
  }

  async function findOne(track, fetchJson) {
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

    // Exact signature and a title + artist search together: the first is precise, the second finds the other
    // recordings (live, acoustic…) to offer. Then progressively looser searches if neither is convincing.
    if (want.duration && artist) {
      await Promise.all([
        run('/get', { track_name: title, artist_name: artist, duration: Math.round(want.duration) }),
        want.artist ? run('/search', { track_name: want.title, artist_name: want.artist }) : null,
      ]);
    } else if (want.artist) {
      await run('/search', { track_name: want.title, artist_name: want.artist });
    }
    if (!confident()) await run('/search', { q: `${want.title} ${want.artist}`.trim() });
    const sofar = best();
    if ((!sofar || sofar.score < ACCEPT) && want.artist) await run('/search', { track_name: want.title });

    const b = best();
    if (!b || b.score < ACCEPT) return { status: attempts > 0 && failures === attempts ? 'error' : 'none' };

    const c = b.c;
    const score = b.score;
    let votes = 0;
    for (const x of pool.values()) if (scoreCandidate(x, want) >= ACCEPT) votes++;
    const sourceOf = (x) => ({ provider: 'LRCLIB', id: x.id, title: x.trackName, artist: x.artistName, album: x.albumName, duration: x.duration });
    const approxOf = (x) => !!(want.duration && x.duration && Math.abs(x.duration - want.duration) > 5);
    const source = sourceOf(c);
    const lines = hasSynced(c) ? parseLrc(c.syncedLyrics) : [];
    if (lines.length) {
      // Songs with several recordings (live, acoustic, remaster) can match more than one file. Keep the next best
      // few, one per recording, so a person can switch when the timing is clearly another version.
      const versions = [];
      const ranked = [...pool.values()].filter(hasSynced).map((x) => ({ x, s: scoreCandidate(x, want) }));
      for (const { x } of ranked.filter((v) => v.s >= ACCEPT).sort((p, q) => q.s - p.s)) {
        if (versions.length >= 4) break;
        if (versions.some((v) => Math.abs((v.source.duration || 0) - (x.duration || 0)) < 3)) continue;
        versions.push({ source: sourceOf(x), lines: parseLrc(x.syncedLyrics), approx: approxOf(x) });
      }
      const out = { status: 'synced', lines, approx: approxOf(c), source, score, votes };
      if (versions.length > 1) out.versions = versions;
      return out;
    }
    if (hasPlain(c)) {
      const plain = c.plainLyrics.split(/\r?\n/).map((text) => ({ t: -1, text: text.trim() }));
      return { status: 'plain', lines: plain, source, score, votes };
    }
    if (c.instrumental) return { status: 'instrumental', source, score, votes };
    return { status: 'none' };
  }

  const api = { normalize, primaryArtist, cleanTitle, videoTrack, parseLrc, indexAt, scoreCandidate, findLyrics };
  root.FloatLyricsCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
