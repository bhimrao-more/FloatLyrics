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
  const YEAR = /^\s*[([]?(19|20)\d\d[)\]]?\s*$/;

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
    // "Sade - Smooth Operator - Official - 1984": trailing packaging and years are not part of the name
    const parts = t.split(/\s+[-–—]\s+/);
    while (parts.length > 2 && (NOISE.test(parts[parts.length - 1]) || YEAR.test(parts[parts.length - 1]))) parts.pop();
    t = parts.join(' - ');
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
  // Enhanced LRC ("[00:12.00] <00:12.00>Look <00:12.40>at <00:12.70>the stars") also yields per-word times:
  // words: [{ t, text }], so a karaoke fill can follow the singing word by word.
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
      const tag = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
      const words = [];
      const parts = rest.split(tag); // [before, mm, ss, frac, word, mm, ss, frac, word, ...]
      for (let k = 1; k + 3 < parts.length + 1; k += 4) {
        const frac = parts[k + 2] ? parseInt(parts[k + 2], 10) / Math.pow(10, parts[k + 2].length) : 0;
        const word = parts[k + 3] || '';
        if (word.trim()) words.push({ t: Math.max(0, parseInt(parts[k], 10) * 60 + parseInt(parts[k + 1], 10) + frac - offset), text: word });
      }
      const text = rest.replace(tag, '').replace(/\s+/g, ' ').trim();
      for (const t of times) {
        const line = { t: Math.max(0, t - offset), text };
        if (words.length > 1) line.words = words;
        out.push(line);
      }
    }
    return out.sort((x, y) => x.t - y.t);
  }

  // How much of a line has been sung at `pos` (0..1), for a karaoke fill. With per-word times it follows the words
  // (by characters, so long words take longer); without, it runs evenly from the line's start to the next line's.
  function progressAt(line, end, pos) {
    const span = Math.max(0.6, end - line.t);
    if (!line.words || !line.words.length) return Math.min(1, Math.max(0, (pos - line.t) / span));
    const total = line.words.reduce((n, w) => n + w.text.length, 0) || 1;
    let done = 0;
    for (let k = 0; k < line.words.length; k++) {
      const w = line.words[k];
      if (pos < w.t) break;
      const wEnd = k + 1 < line.words.length ? line.words[k + 1].t : Math.max(w.t + 0.3, end);
      done += w.text.length * Math.min(1, (pos - w.t) / Math.max(0.05, wEnd - w.t));
    }
    return Math.min(1, done / total);
  }

  // Timing for singing along. LRC only says when each line starts, not when it has been sung, so estimate that
  // from its length (lyrics are sung at ~10 characters a second) or from its word times, never past the next line.
  const SING_CPS = 10;
  function singingSpan(line, next) {
    const gap = next ? next.t - line.t : 5;
    if (line.words && line.words.length) {
      const last = line.words[line.words.length - 1];
      return Math.min(gap, Math.max(0.6, last.t - line.t + Math.max(0.3, last.text.trim().length / SING_CPS)));
    }
    return Math.min(gap, Math.max(0.8, line.text.length / SING_CPS));
  }

  // A one-line view (the island) brings the next line in early enough to read it before it is sung: once the
  // current line has probably been sung, at most 1.2s ahead, at least 0.35s ahead, and never in a line's first
  // moment on screen (subtitle practice: ~0.8–1s minimum).
  function handoverAt(line, next) {
    const gap = next.t - line.t;
    let h = Math.max(line.t + singingSpan(line, next), next.t - 1.2);
    h = Math.min(h, next.t - 0.35);
    return Math.max(h, line.t + Math.min(0.8, gap * 0.5));
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
  /*
   * A YouTube video's own captions as synced lyrics. Official music videos often carry uploaded captions: the
   * lyrics timed to that very video, with its intro, spoken scenes and edit, which no lyrics database knows.
   * cues: [{ t, d, text }] (seconds) from the caption track. ref: lyric lines from elsewhere, if any, to check the
   * captions against and to borrow capitalisation from.
   * Returns { lines, sung, match } or null. sung: share of cues marked as singing (♪); match: share of the
   * captions' words found in ref (null without ref). Whether to trust them is the caller's call (captionsUsable).
   */
  const NOTE = /[♪♫♬]/g;
  const SOUND = /\b(music|plays?|playing|applause|laugh\w*|instrumental|sing(s|ing)?|vocali[sz]\w*|cheer\w*|radio|dj|background|upbeat|song|humm\w*|whistl\w*|sound\w*|noise|silence|crowd|clap\w*|chatter\w*|speak\w*|narrat\w*)\b/i;
  function captionLyrics(cues, ref) {
    const list = (Array.isArray(cues) ? cues : []).filter((c) => c && Number.isFinite(c.t) && String(c.text || '').trim());
    if (!list.length) return null;
    const marked = list.filter((c) => /[♪♫♬]/.test(c.text)).length;
    const sung = marked / list.length;
    const onlySung = sung >= 0.3; // the track marks singing, so unmarked cues are speech (dialogue, a DJ)

    // Capitalisation from the reference lyrics, for captions written in capitals. A word's form mid-line wins
    // (a line's first word is capitalised anyway).
    const cased = new Map();
    for (const l of ref || []) {
      String(l.text || '')
        .split(/\s+/)
        .forEach((w, k) => {
          if (!w) return;
          const low = w.toLowerCase();
          if (k > 0) cased.set(low, w);
          else if (!cased.has(low)) cased.set(low, /^I\b/.test(w) ? w : low);
        });
    }
    const recase = (text) => {
      const letters = text.replace(/[^\p{L}]/gu, '');
      if (letters.length < 3 || letters !== letters.toUpperCase()) return text;
      const out = text
        .toLowerCase()
        .split(/\s+/)
        .map((w) => cased.get(w) || w.replace(/^i('|$)/, 'I$1'))
        .join(' ');
      return out.replace(/\p{L}/u, (ch) => ch.toUpperCase());
    };
    const clean = (c) => {
      const singing = /[♪♫♬]/.test(c.text);
      if (onlySung && !singing) return '';
      let text = String(c.text)
        .replace(NOTE, ' ')
        .replace(/\[[^\]]*\]/g, ' ') // [MUSIC], [RADIO PLAYS IN THE BACKGROUND]
        .replace(/\(([^)]*)\)/g, (m, inner) => (!singing || SOUND.test(inner) ? ' ' : m)) // (gentle upbeat music)
        .replace(/\s*\n\s*/g, ' ')
        .replace(/^[\s"“”'.…-]+|[\s"“”]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/[\p{L}\p{N}]/u.test(text)) return '';
      return recase(text);
    };

    const lines = [];
    list.forEach((c, i) => {
      const text = clean(c);
      const prev = lines[lines.length - 1];
      if (!text) {
        if (prev && prev.text) lines.push({ t: c.t, text: '' });
        return;
      }
      if (prev && prev.text === text && Math.abs(prev.t - c.t) < 0.05) return;
      lines.push({ t: c.t, text });
      // a break after this cue (the music carries on alone): nothing to sing until the next one
      const next = list[i + 1];
      const end = c.t + (Number(c.d) > 0 ? Number(c.d) : 0);
      if (Number(c.d) > 0 && (!next || next.t - end > 2)) lines.push({ t: end, text: '' });
    });
    while (lines.length && !lines[lines.length - 1].text && lines.length > 1 && !lines[lines.length - 2].text) lines.pop();
    const sungLines = lines.filter((l) => l.text);
    if (!sungLines.length) return null;

    let match = null;
    if (ref && ref.length) {
      const known = new Set();
      for (const l of ref) for (const w of normalize(l.text).split(' ')) if (w.length > 1) known.add(w);
      let total = 0;
      let hit = 0;
      for (const l of sungLines) {
        for (const w of normalize(l.text).split(' ')) {
          if (w.length < 2) continue;
          total++;
          if (known.has(w)) hit++;
        }
      }
      match = total ? hit / total : 0;
    }
    return { lines, sung, match, count: sungLines.length };
  }

  // Captions are the lyrics if they mark singing or agree with the lyrics found elsewhere; captions that disagree
  // with known lyrics (a translation, a description of the video) are not.
  function captionsUsable(c) {
    if (!c || c.count < MIN_LINES) return false;
    if (c.match != null) return c.match >= 0.5 || (c.sung >= 0.3 && c.match >= 0.3);
    return c.sung >= 0.3;
  }

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

  const api = { normalize, primaryArtist, cleanTitle, videoTrack, parseLrc, indexAt, progressAt, singingSpan, handoverAt, scoreCandidate, captionLyrics, captionsUsable, findLyrics };
  root.FloatLyricsCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
