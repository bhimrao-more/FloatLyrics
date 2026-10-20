// Run with: npm test   (the "live" tests call the real LRCLIB API)
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanTitle, primaryArtist, videoTrack, parseLrc, indexAt, findLyrics } = require('../extension/core.js');

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
