# FloatLyrics

Time-synced lyrics in a small, see-through, always-on-top glass window for whatever is playing on your Mac:
YouTube, YouTube Music, Spotify or Apple Music, in the browser or in their own apps. It includes play, pause and
next controls. Minimise it and the lyrics carry on in a Dynamic Island around the MacBook notch.
Free and open source (MIT). No account, no API key, no tracking.

## Run it (macOS)

```sh
git clone https://github.com/bhimrao-more/FloatLyrics.git
cd FloatLyrics
npm install
npm start
```

To install it as a normal Mac app with its CD icon (Dock, Launchpad, Spotlight), quit it and run:

```sh
npm run package -- --install   # builds FloatLyrics.app and copies it to /Applications
```

Then open it from Applications and choose *Options → Keep in Dock*. Re-run the command after pulling changes;
the installed app is a snapshot of the code. `npm run icon` re-renders the icon from `app/assets/icon.html`.

Play a song anywhere. The window sits bottom-right, above every other window, on every Space and over
full-screen apps.

- **Chrome: add the extension too.** For music in Chrome tabs, load `extension/` as below. It hands the app the
  tab's exact position, length and adverts, which macOS cannot always give for web players. Play/pause/next then
  go straight to that tab.
- **Move it:** drag anywhere. **Resize it:** drag an edge; the lyrics scale with the window.
- **Controls:** hover for ⏮ ⏯ ⏭ and **Earlier / Later** (nudge the timing in 0.5s steps). Songs with several
  recordings (live, acoustic, remaster) show a **1/4** button; click it to try the next version's timing. With the window focused,
  Space plays or pauses and ← / → skip.
- **Look:** the sliders icon at the top opens five themes (Cover, Clear, Tinted, Graphite, Light) and text size.
  **Advanced…** (or ⌘,) opens Settings for glass clarity, cover colour, alignment, line softening and
  keep-on-top. Every option stays within the design; **Restore Defaults** brings back the original look.
- **Minimise into the notch:** the – at the top, or ⌘M. The window shrinks into the notch and a Dynamic Island
  takes over: a small lyric reel, the line being sung in focus and the next one waiting below, scrolling up on a
  spring with every line. Hover it for the title, ⏮ ⏯ ⏭ and Open. Click the cover, Open or the Dock icon to bring
  the window back. On a screen without a notch (an external monitor, or Settings → *Island appears on → Window's
  screen*), the island is a floating pill at the top with everything in one row: cover · lyric · equaliser.
- **Several players at once:** FloatLyrics follows the one you started last, prefers a music player over a plain
  video when both play, and keeps a song you just paused. A **⇄** button appears when more than one is open;
  click it to follow another. Videos that are not songs say so, and the island stays tucked away for them.
- **Close:** the × at the top, or ⌘Q.

Native Liquid Glass needs macOS 26 or later. Older versions get a frosted window instead.

## Status

| Source | Status |
| --- | --- |
| YouTube Music and YouTube in Chrome | Tested end to end (`npm run test:app`): lyrics in sync, play/pause/next, themes, settings, minimise to the island and back |
| Spotify, Apple Music (web or app), Music.app, other browsers | Read the same way (macOS Now Playing); not yet tested |

## How it works

```
any player ──▶ macOS Now Playing ──▶ app/nowplaying.js ──▶ app/main.js ──▶ lrclib.net
                (what Control         title, artist,         track changed?
                 Center shows)        position, cover        look up + cache
                                            │
                                            ▼
                                   app/renderer (the window): lyrics in time, glass UI, controls
```

- **The extension bridge.** When the extension is installed, each Chrome tab posts its exact player state to the
  app on `127.0.0.1:47231` (the app accepts only the extension's requests). The app prefers that for Chrome tabs
  and uses macOS Now Playing for everything else. Now Playing follows whichever media element is active, which on
  YouTube includes pause ads and previews. A paused song stays on screen unless another player starts afterwards.
- **`app/nowplaying.js`** reads macOS Now Playing and sends play/pause/next/previous to whichever app owns it.
  Since macOS 15.4 only Apple-entitled processes may do that;
  [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter) (BSD-3-Clause, vendored in
  `vendor/mediaremote-adapter`) gets there through `/usr/bin/perl`, which is entitled. Chrome reports its
  position about 0.2s late, which the app corrects.
- **`app/main.js`** turns each report into a track (YouTube video titles and channel names are cleaned up by
  `videoTrack()`), looks up lyrics, and owns the window. The window is frameless, transparent and always on top,
  with native glass behind it from [electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass).
- **`app/lyrics.js`** asks [LRCLIB](https://lrclib.net) through the shared matcher and caches answers on disk.
- **`app/renderer/`** draws the windows. `view.js` keeps the highlighted line on the music, `looks.js` defines the
  appearance options and their limits, `settings.html` is the Settings window, and `island.html` / `island.js`
  are the Dynamic Island ([docs/dynamic-island.md](docs/dynamic-island.md)).
- **`extension/core.js`** (lyric matching, LRC parsing) and **`extension/glass.js`** (refracting glass) are shared
  with the browser extension.

## Look

The window follows Apple's Liquid Glass design. Real macOS glass lets the desktop show through; the song's cover,
blurred, lends it colour. The current line is sharp and the others soften. The title bar and the controls are
glass capsules that bend the lyrics passing beneath them. Research, limits and decisions:
[docs/liquid-glass.md](docs/liquid-glass.md). The notch island, and the open-source notch apps it was weighed
against: [docs/dynamic-island.md](docs/dynamic-island.md).

## Lyrics source

[LRCLIB](https://lrclib.net) is a free, open, crowd-sourced database of line-synced lyrics. Because anyone can
add to it, candidates are scored on title, artist, duration and lyric length before one is shown.

## The browser extension

`extension/` is the earlier Chrome extension. It shows lyrics in Chrome's Picture-in-Picture window, which keeps
Chrome's own title bar, and it needs no app install. Load it unpacked from `chrome://extensions` (Developer mode).
`npm run test:e2e` tests it.

## Develop

```sh
npm test           # matcher, LRC parsing, appearance settings, live LRCLIB lookups
npm run test:app   # plays a song in a test browser and drives the app: sync, themes, settings, controls
```

`npm run test:app` briefly plays music at 2% volume in a test browser that has a temporary copy of the extension
on its own port (47299). A FloatLyrics you have open is left alone. It checks that it is controlling its own
test player before pressing any button.

## Roadmap

- Test Spotify and Apple Music (app and web) end to end.
- Package as a signed `.app`, launch at login, menu-bar icon.
- Windows (System Media Transport Controls) and Linux (MPRIS).
- Word-by-word highlighting, click a line to seek.

## Credits

Lyrics by the [LRCLIB](https://github.com/tranxuanthang/lrclib) community. Animation springs by
[Motion](https://motion.dev) (MIT). Now Playing access by
[mediaremote-adapter](https://github.com/ungive/mediaremote-adapter). Native glass by
[electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass).

## License

[MIT](LICENSE). `vendor/mediaremote-adapter` is BSD-3-Clause; see its LICENSE.
