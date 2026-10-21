// Run with: npm test   (the "live" tests call the real LRCLIB API)
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanTitle, primaryArtist, videoTrack, parseLrc, indexAt, progressAt, singingSpan, handoverAt, captionLyrics, captionsUsable, findLyrics } = require('../extension/core.js');

async function fetchJson(url, retried) {
  const res = await fetch(url, { headers: { 'X-User-Agent': 'FloatLyrics tests' } });
  if (res.status === 404) return null;
  if (res.status === 429 && !retried) {
    await new Promise((r) => setTimeout(r, Math.min(5, Number(res.headers.get('retry-after')) || 1) * 1000));
    return fetchJson(url, true);
  }
  if (!res.ok) throw new Error(`LRCLIB responded ${res.status}`);
  return res.json();
}

test('cleanTitle strips packaging but keeps the name', () => {
  assert.equal(cleanTitle('Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley'), 'Never Gonna Give You Up');
  assert.equal(cleanTitle('Rick Astley - Never Gonna Give You Up (Official Music Video)', 'Rick Astley'), 'Never Gonna Give You Up');
  assert.equal(cleanTitle('Yellow - Remastered 2011', 'Coldplay'), 'Yellow');
  assert.equal(cleanTitle('Tum Hi Ho (From "Aashiqui 2")', 'Arijit Singh'), 'Tum Hi Ho');
  assert.equal(cleanTitle('Stay (feat. Justin Bieber)', 'The Kid LAROI'), 'Stay');
  assert.equal(cleanTitle('Hello (Goodbye)', 'X'), 'Hello (Goodbye)');
  assert.equal(cleanTitle('तुम ही हो', 'Arijit Singh'), 'तुम ही हो');
});

test('videoTrack turns a youtube.com video into a track', () => {
  const v = (title, channel) => videoTrack(title, channel);
  assert.deepEqual(v('Rick Astley - Never Gonna Give You Up (Official Music Video)', 'Rick Astley'), { title: 'Never Gonna Give You Up', artist: 'Rick Astley' });
  assert.deepEqual(v('The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO'), { title: 'Blinding Lights', artist: 'The Weeknd' });
  assert.deepEqual(v('Ed Sheeran - Shape of You [Official Video]', 'Some Label'), {
    title: 'Shape of You', artist: 'Ed Sheeran', alt: { title: 'Ed Sheeran', artist: 'Shape of You' },
  });
  assert.deepEqual(v('Golden Brown - The Stranglers (slowed + reverb)', 'some fan'), {
    title: 'The Stranglers', artist: 'Golden Brown', alt: { title: 'Golden Brown', artist: 'The Stranglers' }, tempo: true,
  });
  assert.deepEqual(v('Yellow', 'Coldplay - Topic'), { title: 'Yellow', artist: 'Coldplay' });
  assert.deepEqual(v('Full Video: Tum Hi Ho | Aashiqui 2 | Aditya Roy Kapur, Shraddha Kapoor | Mithoon', 'T-Series'), { title: 'Tum Hi Ho', artist: 'T-Series' });
  assert.deepEqual(v('Kesariya - Brahmāstra | Ranbir Kapoor | Alia Bhatt | Pritam | Arijit Singh', 'Sony Music India'), { title: 'Kesariya', artist: 'Sony Music India' });
});

test('videoTrack drops trailing packaging and years from "Artist - Song - Official - 1984"', () => {
  assert.deepEqual(videoTrack('Sade - Smooth Operator - Official - 1984', 'SadeVEVO'), { title: 'Smooth Operator', artist: 'Sade' });
  assert.deepEqual(videoTrack('Artist - Song - Remastered - 2009', 'Artist'), { title: 'Song', artist: 'Artist' });
});

// A music video's captions, in the shapes YouTube uses: sound descriptions, ♪ around what is sung, capitals,
// a host talking at the end. (Made-up lyrics.)
const cue = (t, d, text) => ({ t, d, text });
const videoCues = [
  cue(1, 2, '(soft guitar music)'),
  cue(4, 2, '[CROWD CHEERING]'),
  cue(12, 3, '♪ THE KETTLE SINGS AT NINE ♪'),
  cue(15, 3, "♪ AND I KNOW THE\nMORNING'S MINE ♪"),
  cue(18, 3, '♪ (OH YEAH) PAPER SKY ♪'),
  cue(30, 4, '♪ ♪'),
  cue(40, 3, '♪ The kettle sings at nine ♪'),
  cue(43, 2, '♪ (gentle humming) ♪'),
  cue(50, 2, 'HOST: THAT WAS LOVELY'),
];
const videoRef = [
  { t: 10, text: 'The kettle sings at nine' },
  { t: 13, text: "And I know the morning's mine" },
  { t: 16, text: 'Paper sky (oh yeah)' },
];

test("captionLyrics turns a music video's captions into its lyrics, timed to the video", () => {
  const c = captionLyrics(videoCues, videoRef);
  assert.deepEqual(
    c.lines.map((l) => [l.t, l.text]),
    [
      [12, 'The kettle sings at nine'],
      [15, "And I know the morning's mine"],
      [18, '(Oh yeah) paper sky'],
      [21, ''], // the music carries on alone until the next sung line
      [40, 'The kettle sings at nine'],
      [43, ''],
    ],
  );
  assert.equal(c.count, 4);
  assert.ok(c.sung > 0.5);
  assert.equal(c.match, 1);
  assert.equal(captionsUsable(c), true);
});

test('captions that are not the lyrics are not used', () => {
  // a translation: marked as sung, but none of its words are in the lyrics
  const other = [{ t: 1, text: 'La bouilloire chante à neuf heures' }, { t: 2, text: 'Et je sais que le matin est à moi' }, { t: 3, text: 'Ciel de papier' }];
  assert.equal(captionsUsable(captionLyrics(videoCues, other)), false);
  // nothing to compare with: trusted when they mark singing
  assert.equal(captionsUsable(captionLyrics(videoCues, null)), true);
  // plain captions with no ♪ are trusted only when they agree with the lyrics
  const plain = videoRef.concat(videoRef).map((l, i) => cue(i * 4, 3, l.text));
  assert.equal(captionsUsable(captionLyrics(plain, null)), false);
  assert.equal(captionsUsable(captionLyrics(plain, videoRef)), true);
  // too short to be a song's lyrics
  assert.equal(captionsUsable(captionLyrics(videoCues.slice(0, 4), videoRef)), false);
  assert.equal(captionLyrics([], null), null);
});

test('primaryArtist takes the lead artist', () => {
  assert.equal(primaryArtist('Arijit Singh, Mithoon'), 'Arijit Singh');
  assert.equal(primaryArtist('The Kid LAROI & Justin Bieber'), 'The Kid LAROI');
  assert.equal(primaryArtist('Coldplay'), 'Coldplay');
});

test('parseLrc handles fractions, repeated stamps and offset', () => {
  const lines = parseLrc('[ar:Someone]\n[00:12.50] second\n[00:05.1] first\n[01:00.000][00:30.00] chorus\n[00:20.00]\nnot a line');
  assert.deepEqual(
    lines.map((l) => [l.t, l.text]),
    [[5.1, 'first'], [12.5, 'second'], [20, ''], [30, 'chorus'], [60, 'chorus']],
  );
  assert.equal(parseLrc('[offset:500]\n[00:10.00] a')[0].t, 9.5);
});

test('parseLrc keeps per-word times from enhanced LRC', () => {
  const [line] = parseLrc('[00:12.00] <00:12.00>Look <00:12.40>at <00:12.70>the <00:13.10>stars');
  assert.equal(line.text, 'Look at the stars');
  assert.deepEqual(line.words.map((w) => [w.t, w.text.trim()]), [[12, 'Look'], [12.4, 'at'], [12.7, 'the'], [13.1, 'stars']]);
  assert.equal(parseLrc('[00:05.00] plain line')[0].words, undefined);
});

test('progressAt follows words when it has them, time otherwise', () => {
  const plain = { t: 10, text: 'abcd' };
  assert.equal(progressAt(plain, 14, 12), 0.5);
  const worded = parseLrc('[00:10.00] <00:10.00>aa <00:11.00>bbbbbb')[0];
  assert.ok(progressAt(worded, 13, 10.99) < 0.35, 'first short word nearly done');
  assert.ok(progressAt(worded, 13, 11) > 0.3 && progressAt(worded, 13, 11) < 0.35, 'second word just starting');
  assert.equal(progressAt(worded, 13, 20), 1);
});

test('handoverAt: early after a pause, just ahead when lines run on', () => {
  const short = { t: 10, text: 'Hey there' }; // ~0.9s to sing
  // A long pause before the next line: it comes in 1.2s ahead, well after the short line was sung.
  assert.equal(handoverAt(short, { t: 20, text: 'next' }), 18.8);
  // Back-to-back lines: just 0.35s ahead.
  const long = { t: 10, text: 'On a dark desert highway, cool wind in my hair' }; // ~4.6s
  assert.equal(handoverAt(long, { t: 14.2, text: 'next' }), 13.85);
  // Never in a line's first moment on screen.
  assert.ok(handoverAt({ t: 10, text: 'a' }, { t: 11, text: 'b' }) >= 10.5);
  assert.ok(singingSpan(long, { t: 30 }) > 4 && singingSpan(long, { t: 30 }) < 5);
});

test('indexAt finds the line being sung', () => {
  const lines = [{ t: 5 }, { t: 10 }, { t: 20 }];
  assert.equal(indexAt(lines, 0), -1);
  assert.equal(indexAt(lines, 5), 0);
  assert.equal(indexAt(lines, 19.99), 1);
  assert.equal(indexAt(lines, 999), 2);
  assert.equal(indexAt([], 3), -1);
});

const LIVE = [
  { title: 'Never Gonna Give You Up', artist: 'Rick Astley', duration: 213 },
  { title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', artist: 'Rick Astley', duration: 213 },
  { title: 'Yellow', artist: 'Coldplay', duration: 267 },
  { title: 'Tum Hi Ho', artist: 'Arijit Singh, Mithoon', duration: 262 },
  { title: 'Blinding Lights', artist: 'The Weeknd', duration: 0 },
  // youtube.com uploads, as videoTrack() hands them over: the channel is a label, not the singer
  { ...videoTrack('Full Video: Tum Hi Ho | Aashiqui 2 | Aditya Roy Kapur, Shraddha Kapoor | Mithoon', 'T-Series'), duration: 0 },
  { ...videoTrack('The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO'), duration: 0 },
];

test('live: a "Song - Artist" slowed edit is found and stretched to the video length', async () => {
  const res = await findLyrics({ ...videoTrack('Golden Brown - The Stranglers (slowed + reverb)', 'x'), duration: 259 }, fetchJson);
  assert.equal(res.status, 'synced', JSON.stringify(res.source || res));
  assert.equal(res.source.artist, 'The Stranglers');
  assert.ok(res.stretch > 1.1 && res.stretch < 1.4, `stretch ${res.stretch}`);
});

for (const track of LIVE) {
  test(`live: finds synced lyrics for "${track.title}"`, async () => {
    const res = await findLyrics(track, fetchJson);
    assert.equal(res.status, 'synced', JSON.stringify(res.source || res));
    assert.ok(res.lines.length > 10, `only ${res.lines.length} lines`);
    if (track.duration) assert.ok(Math.abs(res.source.duration - track.duration) <= 5, `matched a ${res.source.duration}s version`);
  });
}

test('live: an unknown track is a clean miss, not an error', async () => {
  const res = await findLyrics({ title: 'zzqx no such song 91827', artist: 'nobody at all', duration: 123 }, fetchJson);
  assert.equal(res.status, 'none');
});
