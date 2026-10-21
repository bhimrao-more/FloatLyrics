/*
 * FloatLyrics vinyl: the sound of a record turning under whatever is playing. A real recording of a record's
 * surface (CC0, see app/assets/sounds/CREDITS.md) fades in while music plays and fades away when it pauses or
 * ends. It plays from the app, so it works with any player the app follows, and never touches the music's own
 * audio (protected streams such as Spotify's would go silent if rerouted).
 */
(function (root) {
  'use strict';

  // How much record surface to hear, and how much real crackle to mix into it.
  const WEAR = {
    light: { surface: 0.7, crackle: 0 },
    worn: { surface: 1, crackle: 0.05 },
    scratched: { surface: 1.15, crackle: 0.12 },
  };
  const SETTLE_MS = 700; // pauses and track flickers shorter than this (buffering, an advert starting) are ignored
  const XFADE = 0.6; // seconds of crossfade where a surface loop meets itself

  function createVinyl(loadSound) {
    let ctx = null;
    let master = null;
    let surfaceGain = null;
    let crackleGain = null;
    const buffers = {};
    let loading = null;
    let wear = 'off';
    let level = 0;
    let wantPlaying = false; // what the player says
    let on = false; // what we are sounding
    let track = '';
    let settleTimer = null;
    let loops = [];

    function ensure() {
      if (ctx) return;
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      surfaceGain = ctx.createGain();
      crackleGain = ctx.createGain();
      surfaceGain.connect(master);
      crackleGain.connect(master);
      loading = Promise.all(
        ['surface', 'surface-crackle'].map(async (name) => {
          const bytes = await loadSound(name);
          buffers[name] = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        }),
      ).catch((err) => console.warn('[FloatLyrics] vinyl sounds unavailable', err));
    }

    // A loop that crossfades into itself, so the seam of a recording is never heard.
    function startLoop(buffer, into) {
      const seg = buffer.duration;
      let next = ctx.currentTime + 0.05;
      let alive = true;
      const schedule = () => {
        while (alive && next < ctx.currentTime + 4) {
          const src = ctx.createBufferSource();
          const g = ctx.createGain();
          src.buffer = buffer;
          src.connect(g).connect(into);
          g.gain.setValueAtTime(0, next);
          g.gain.linearRampToValueAtTime(1, next + XFADE);
          g.gain.setValueAtTime(1, next + seg - XFADE);
          g.gain.linearRampToValueAtTime(0, next + seg);
          src.start(next);
          src.stop(next + seg + 0.05);
          next += seg - XFADE;
        }
      };
      schedule();
      const timer = setInterval(schedule, 1000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }

    function surfaceTo(up) {
      if (!ctx) return;
      const spec = WEAR[wear] || { surface: 0, crackle: 0 };
      const now = ctx.currentTime;
      // a gentle swell in with the music, a quicker fade when it stops
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(up ? level : 0, now, up ? 0.5 : 0.15);
      surfaceGain.gain.value = spec.surface;
      crackleGain.gain.value = spec.crackle;
    }

    async function sound(up) {
      if (up === on) return;
      on = up;
      if (wear === 'off') return;
      ensure();
      if (ctx.state === 'suspended') await ctx.resume();
      await loading;
      if (on !== up) return;
      if (up && !loops.length && buffers.surface) {
        loops = [startLoop(buffers.surface, surfaceGain)];
        if (buffers['surface-crackle']) loops.push(startLoop(buffers['surface-crackle'], crackleGain));
      }
      surfaceTo(up);
    }

    // Settle before acting: a song really started, really stopped, or really changed.
    function settle() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => sound(wantPlaying && !!track), SETTLE_MS);
    }

    return {
      set(nextWear, nextLevel) {
        const was = wear;
        wear = nextWear;
        level = nextLevel;
        if (wear === 'off') {
          if (ctx) surfaceTo(false);
          loops.forEach((stop) => stop());
          loops = [];
          on = false;
          return;
        }
        if (was === 'off') {
          on = false;
          settle(); // switched on mid-song
        } else if (on) surfaceTo(true);
      },
      playing(next) {
        if (next === wantPlaying) return;
        wantPlaying = next;
        settle();
      },
      track(key) {
        if (key === track) return;
        track = key;
        if (wear !== 'off') settle();
      },
      // For the e2e test.
      state: () => ({
        wear,
        level,
        playing: wantPlaying,
        on,
        sounding: loops.length > 0,
        context: ctx ? ctx.state : 'none',
        gain: master ? master.gain.value : 0,
      }),
    };
  }

  root.FloatLyricsVinyl = { createVinyl, WEAR };
})(typeof self !== 'undefined' ? self : globalThis);
