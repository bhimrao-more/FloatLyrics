# Dynamic Island — design reference for FloatLyrics

When the lyrics window is minimised (– button, ⌘M, or the system minimise), it shrinks into the MacBook notch
and a black "Dynamic Island" around the notch carries on showing the current lyric. The window stays the app;
the island is one of its features. Clicking the island's cover or its Open button, or the Dock icon, brings the
window back.

## Survey (2026-10-20)

| Project | Stars · licence | What it offers us |
| --- | --- | --- |
| [TheBoredTeam/boring.notch](https://github.com/TheBoredTeam/boring.notch) | 11k · GPL-3.0 | The most popular notch app: music live activity. Uses mediaremote-adapter; LRCLIB appears in its MusicManager. Xcode project. |
| [Ebullioscopic/Atoll](https://github.com/Ebullioscopic/Atoll) | 5k · GPL-3.0 | "Dynamic Island for macOS". Its code already has synced lyrics (LRCLIB + NetEase, a "lyric sweep" animation). Xcode project, macOS 14+. The best finished app to try. |
| [jackson-storm/DynamicNotch](https://github.com/jackson-storm/DynamicNotch) | 0.6k · GPL-3.0 | Notch "system surface" with an LRCLIB lyrics provider |
| [monuk7735/mew-notch](https://github.com/monuk7735/mew-notch) | 0.6k · GPL-3.0 | Notch HUDs and media |
| [MrKai77/DynamicNotchKit](https://github.com/MrKai77/DynamicNotchKit) | 0.5k · **MIT** | SwiftUI package: notch window, compact/expanded states, automatic floating style on Macs without a notch. **Our behavioural model.** |
| [Lakr233/NotchDrop](https://github.com/Lakr233/NotchDrop) | 2.1k · MIT | Notch file shelf; reference for the notch-shaped window |
| [wxtsky/CodeIsland](https://github.com/wxtsky/CodeIsland), [akalikbergenov/cyclop](https://github.com/akalikbergenov/cyclop) | MIT | Notch panels (agent status; media controls and shelf) |
| Small "notch lyrics" repos (austinmax323-del/notch-lyrics, denjayx/NotchLyrics, bdathe-lb/notch-lyrics…) | MIT, a few stars | Proofs of the same idea for Spotify/Apple Music |

**Decision.** Build the island inside FloatLyrics (Electron, MIT) rather than fork Atoll or boring.notch:

- They are GPL-3.0, so copying their code would force FloatLyrics off MIT.
- They are Xcode projects; this Mac has only the Command Line Tools.
- They would mean a second codebase. FloatLyrics already has Now Playing, lyric matching, controls and settings.

DynamicNotchKit's states and floating fallback are the model; no code is copied from the GPL projects.

## How it works

- **Notch size.** AppKit knows it; Electron does not. `app/main.js` asks once through JXA (`osascript -l JavaScript`):
  `NSScreen.safeAreaInsets.top` is the notch height. The width is the frame width minus
  `auxiliaryTopLeftArea` and `auxiliaryTopRightArea`. This Mac's built-in display reports 208 × 37.5pt. The
  answer is recomputed when displays change.
- **Window.** A 640×240 transparent `panel` at the top centre of the notched display, at `screen-saver` level
  (above the menu bar), on all Spaces and over full-screen apps. It is click-through
  (`setIgnoreMouseEvents(true, { forward: true })`); the renderer watches forwarded mouse moves and turns clicks
  back on only while the pointer is over the island.
- **Which screen** (Settings → *Island appears on*): the MacBook notch (the main screen when there is none), the
  window's screen, or any connected screen by name. AppKit is asked once for every screen's name and notch
  (`NSScreen.localizedName`, `safeAreaInsets`), matched to Electron's displays by their frames, and asked again
  when screens change. A chosen screen that is unplugged stays chosen (remembered by name) and the island goes back
  there when it returns; meanwhile it uses the notch or the main screen.
- **Switching screens.** A notch island and a glass island are different windows, so changing kind makes a fresh
  window. It is never shown before its page has laid itself out for its screen (`island:ready`), and the screen's
  geometry goes to it directly rather than being replayed from the last screen. Before this, a new glass window
  could first draw the old notch layout and stay that way: a black island cropped inside a small glass window.
  `npm run test:island` moves the island across every screen and back while sampling frames, and storms
  play/pause on both kinds.
- **Hand-over animation.** On minimise the window animates its bounds into the notch rectangle
  (`setBounds(…, animate)`), hides, and the island activates. Restore runs the reverse.

## Motion (`app/renderer/island.js`, Motion 12, MIT)

- **Library.** [Motion](https://motion.dev) (the engine behind Framer Motion), MIT. GSAP was considered; it is free
  but not open source. Motion's springs are physical: an interrupted move keeps its velocity, which is what makes
  rapid line changes and resizes feel continuous.
- **Reel.** Every line is a row in one column; the column slides up on a critically damped spring (stiffness 170,
  damping 26: no wobble under words being read). Rows change state with a long ease-out
  (`cubic-bezier(0.22, 1, 0.36, 1)`):
  - current: bright, full size;
  - next: 34% opacity, scaled 0.84, one line;
  - past: fades out and blurs 5px as it leaves upward.

  A jump of more than three lines (a seek) lands without scrolling.
- **Shape.** Width, height and corners spring with stiffness 380, damping 25 (damping ratio ≈ 0.65: the slight
  overshoot of iPhone's island).
- **Type.** SF Pro (system), 16px semibold (15px in the pill), tracking −0.014em, balanced wrapping, two lines max.
- **The window's lyric list** scrolls on the same kind of spring (Motion animating `scrollTop`), not the browser's
  stock smooth scroll.
- **Reduce Motion** turns every spring into an instant change.

## The pill (screens without a notch)

One row, 40px tall (taller when a line wraps): round cover on the left, the lyric scrolling up inside the row,
equaliser on the right. Hover drops the controls row below. It appears when the island's screen has no notch: an
external monitor chosen in Settings → *Island appears on* (or the window's screen), or the lid closed. Its shape
and glass are described under *Glass island* below.

## States and sizes (`app/renderer/island.js`)

| State | When | Size |
| --- | --- | --- |
| hidden | the window is open | — |
| idle | nothing playing, or paused for 15s | exactly the notch (black on black, invisible) |
| compact | playing, between lyric lines or no synced lyrics | notch + 46px each side: cover left, equaliser right |
| lyric | a line is being sung | widens to fit the line (max 600px, two lines max), grows below the notch |
| expanded | hover (140ms in, 380ms out) | at least 400px: adds title, artist, ⏮ ⏯ ⏭, Open |

- **Motion.** Width and height ride an underdamped spring (ζ 0.62, 0.6s) sampled into a CSS `linear()` easing, so
  the island overshoots slightly like the iPhone's. Lines use a softer spring (ζ 0.85): the new line rises in from
  below out of a blur while the old one leaves upward.
- **Colour.** The island stays pure black so it reads as the notch growing. Only the equaliser takes a colour,
  the cover's most saturated hue, lifted to at least 64% lightness so it reads on black. The window's text size
  setting applies here too; themes do not.
- **Shape.** The bottom corners round with the size (10px idle, 12px compact, 22px lyric, 26px expanded). The
  notch's concave top corners are drawn as two 10px radial-gradient "ears" that travel with the edges.

## Glass island (screens without a notch)

The window takes the island's own size and wears native macOS glass (`electron-liquid-glass`, corner radius 16).
It sits 16px above the screen's top edge, so the top corners are hidden: it hangs from the top like a notch, with
only the bottom corners rounded.

A version that curved into the top edge at both corners, like NotchNook (SwiftUI `glassEffect(in:)` in a notch
outline, and before that a layer mask on the glass view), was tried on 2026-10-20. The user preferred this one, so
it was taken out.

It follows the window's theme, text size, clarity and cover colour live; the glass tint turns light for the Light
theme. It resizes on a spring (stiffness 380, damping 27) stepped by the main process, the glass following the
window; small width changes (18px or less) do not resize it. When there is nothing to show
(paused for 15s, not a song) it fades away instead of leaving empty glass at the top of the screen.

## Singing along: timing (`extension/core.js`)

One line at a time, so the timing does the reading-ahead:
- `singingSpan`: LRC only gives each line's start. Estimate when it has been sung from its length (about 10
  characters a second) or from its word times, never past the next line.
- `handoverAt`: the next line takes over once the current one has probably been sung. After a pause that is at
  most 1.2s before it is due; when lines run on, 0.35s; never in a line's first moment on screen. (Karaoke tools
  call this an anticipation buffer; subtitle practice is about 1s minimum on screen and 12–17 characters a second
  reading speed.)
- `progressAt`: the karaoke fill. It follows word times when the lyrics have them (enhanced LRC
  `<mm:ss.xx>` tags) and otherwise runs evenly over the estimated singing span. Sung words take the cover's colour.
- After an instrumental break the coming line brightens over its last 1.5s: a count-in.
- The cover is a record: round, turning while playing, with a ring that fills over the song's length.

