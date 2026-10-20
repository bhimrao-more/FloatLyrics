# FloatLyrics

Time-synced lyrics in a small always-on-top window, for the song playing in your browser.
Free and open source (MIT). No account, no API key, no tracking.

Works on **YouTube** and the web players of **YouTube Music**, **Spotify** and **Apple Music** in Chrome or Edge 116+.

## Status

| Player | Track detection | Synced lyrics |
| --- | --- | --- |
| YouTube (`www.youtube.com`, watch pages) | Tested end to end | Tested end to end (`FL_URL=<youtube watch url> npm run test:e2e`) |
| YouTube Music (`music.youtube.com`) | Tested end to end | Tested end to end (`npm run test:e2e`) |
| Apple Music (`music.apple.com`) | Tested (signed out) | Not yet tested with a signed-in account |
| Spotify (`open.spotify.com`) | Not yet tested (needs a login) | Not yet tested |
| Desktop apps (Spotify, Music) | Not supported yet, see Roadmap | |

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder of this repo.
3. Reload any music tab that was already open.

## Use

Play a song, then click the **♪ Lyrics** pill (on YouTube it only appears on a video page) at the bottom right of the player page. A small window opens that
stays above every other window and app. Resize it freely; the text scales with it. Keep the player tab open
(it can be in the background): the window belongs to that tab and closes with it.

Hover the window for **Earlier / Later** to nudge the timing in 0.5s steps when a lyric file is slightly off.

## Look

The window follows Apple's Liquid Glass design. The song's cover, blown up and blurred, tints the window. The
lyrics sit on that colour, with the current line sharp and the rest softened. The title bar and the timing
controls are glass capsules that bend the lyrics passing beneath them (an SVG displacement map used as a
`backdrop-filter`, Chromium only). Chrome draws the floating window opaque, so the desktop does not show through
it; see [docs/liquid-glass.md](docs/liquid-glass.md) for the research, the limits and the design decisions.

## How it works

```
player page ── probe.js ──▶ content.js ──▶ background.js ──▶ lrclib.net
 (page world)   title, artist,   track changed?    looks up + caches
                duration,        asks for lyrics   synced lyrics
                position         renders the window
```

- **`probe.js`** runs in the page's own JS world. It reads the track from the Media Session metadata every one
  of these players publishes, and the playback position from the player's media element. Players that never
  attach that element to the page (Spotify) are caught by wrapping `HTMLMediaElement.prototype.play`. The clock
  shown in the player's UI is the fallback, and on Spotify a cross-check.
- **`content.js`** interpolates the position between reports, picks the line being sung, and renders into a
  [Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)
  window, which the OS keeps on top. Browsers without that API get an in-page panel instead.
- **`background.js`** is the only part that touches the network. It asks [LRCLIB](https://lrclib.net) for the
  track and caches the answer in `chrome.storage.local`.
- **`glass.js`** builds the refracting glass: a displacement map computed from Snell's law over a rounded
  bezel, applied as an SVG `backdrop-filter`.
- **`core.js`** holds the pure logic (LRC parsing, title cleanup, candidate scoring) and is shared by the
  extension and the Node tests.

## Lyrics source

[LRCLIB](https://lrclib.net) — a free, open, crowd-sourced database of line-synced lyrics with a public API that
needs no key. Being crowd-sourced it contains stub and mistimed entries, so candidates are scored on title,
artist, duration and lyric length before one is shown.

## Develop

```sh
npm install        # only needed for the browser test (downloads Chrome for Testing)
npm test           # core logic + live LRCLIB lookups
npm run test:e2e   # plays a song on YouTube Music with the extension loaded and checks the sync
```

There is no build step: `extension/` is loaded as is.

## Roadmap

- Verify and harden Spotify and Apple Music with signed-in accounts.
- Desktop apps: a small local companion (started from the command line) that reads Spotify.app / Music.app and
  feeds the same lyrics view.
- More lyric sources as fallbacks, word-by-word highlighting, click a line to seek.
- Truly see-through glass over other apps: the desktop companion window with native macOS glass
  ([electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass), macOS 26+).
- More looks: light glass, compact single-line mode, word-by-word highlight.

## Credits

Lyrics by the [LRCLIB](https://github.com/tranxuanthang/lrclib) community.

## License

[MIT](LICENSE)
