# Liquid Glass — design reference for FloatLyrics

The FloatLyrics window follows Apple's Liquid Glass look (iOS 26 / macOS 26). This file collects what that
material is, how it is recreated in a browser, the limits we work within, and the decisions taken. Read it
before changing anything visual.

## What Liquid Glass is (Apple)

Apple describes Liquid Glass as a dynamic material that "combines the optical properties of glass with a sense of
fluidity". The parts that matter for us:

- **Two layers.** Content sits at the bottom; Liquid Glass is a *functional layer* for controls and navigation that
  floats above it. Content scrolls and peeks through beneath the glass. Apple: *don't use Liquid Glass in the
  content layer* — use it sparingly, for the most important controls only.
- **Optics.** Glass bends what is behind it at its edges (lensing/refraction), catches light along its rim (specular
  highlight), and blurs and lifts what shows through.
- **Two variants.**
  - *Regular* blurs and adjusts the luminosity of what is behind it to keep text legible. Use for anything with
    much text.
  - *Clear* is highly translucent, for components floating over rich media (photos, video, album art). Over bright
    content, put a **dark dimming layer of about 35% opacity** behind it.
- **Colour comes from content.** Be judicious with colour in controls and let the content infuse them.
- **Shapes are concentric.** Rounded shapes nest inside their containers with matching curvature
  (inner radius = outer radius − inset).
- **Accessibility.** Users can turn on Reduce Transparency, Increase Contrast and Reduce Motion; the material must
  degrade to something opaque, high-contrast and still.
- **Legibility under scrolling content.** Apple fades and blurs content as it scrolls under bars (its "scroll edge
  effect").

Sources: [Liquid Glass overview](https://developer.apple.com/documentation/technologyoverviews/liquid-glass),
[Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass),
[HIG — Materials](https://developer.apple.com/design/human-interface-guidelines/materials).

## How it is done in a browser

### Refraction: an SVG displacement map used as a backdrop filter

From [kube.io — Liquid Glass in the browser](https://kube.io/blog/liquid-glass-css-svg/), the most physically
grounded write-up:

1. Model the glass edge as a **height profile** across a bezel of width `b`: `x ∈ [0, 1]` from the outer edge to
   where the flat top begins. The *convex squircle* `y = ⁴√(1 − (1 − x)⁴)` gives a smooth transition with no harsh
   ring.
2. For each `x`, take the surface slope, treat the incoming ray as vertical, and apply **Snell's law** (air n = 1,
   glass n ≈ 1.5) to get the refracted ray. Where it lands on the background, relative to where it would land
   without glass, is the **displacement** at that point. It is 0 at the very edge, peaks inside the bezel and is
   0 again on the flat top.
3. Turn that 1-D profile into a 2-D field. For a rounded rectangle, use its signed distance function: distance
   inside the shape gives `x`; the SDF gradient (the edge normal) gives the direction.
4. **Encode** the field into an image: `R = 128 + dx·127`, `G = 128 + dy·127` (normalised by the maximum
   displacement), with 128 meaning "no shift".
5. Use it in an SVG filter: `<feImage href="data:…">` then
   `<feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G" scale="…">` with
   `color-interpolation-filters="sRGB"`. `feDisplacementMap` shifts by `scale × (channel − 0.5)`, so
   `scale = 2 × maxDisplacement` turns the encoded values back into pixels.
6. Apply it with **`backdrop-filter: url(#filter) blur(…) saturate(…)`**. The map must be rebuilt when the element
   changes size; animating only `scale` is cheap.

`backdrop-filter: url(#svg)` is **Chromium-only**. That is fine here: FloatLyrics only runs in Chrome or Edge.
A missing filter reference drops the whole `backdrop-filter`, so only reference a filter that exists in the same
document.

### Specular rim and depth

- **Rim light:** a 1px gradient border made with the mask trick
  (`padding: 1px; mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)`), brightest at
  the top-left and bottom-right (light from about −60°).
- **Inner glow:** a soft radial highlight near the lit corner.
- **Lift:** a soft outer shadow under the glass.

### Other open-source implementations (for ideas, all MIT)

| Project | Approach |
| --- | --- |
| [shuding/liquid-glass](https://github.com/shuding/liquid-glass) | Copy-paste JS: a fragment function (rounded-rect SDF + smoothstep) painted to a canvas, then used as `feImage` → `feDisplacementMap` in a `backdrop-filter` |
| [rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react) | React component with displacement, chromatic aberration and an elastic mouse response. Several refraction modes. |
| [archisvaze/liquid-glass](https://github.com/archisvaze/liquid-glass) | Interactive web demo of the iOS 26 look |
| [naughtyduk/liquidGL](https://github.com/naughtyduk/liquidGL) | WebGL/WebGPU version that renders a cloned background, so it also works outside Chromium. Its licence is not a plain MIT; check before reusing code. |
| [Meridius-Labs/electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass) | *Real* native glass in Electron. It puts macOS 26's `NSGlassEffectView` behind a transparent `BrowserWindow`, with tint, corner radius and variant options. Requires macOS 26+ and Electron 30+, and uses private API for some options. |

## Where the glass is real

**Desktop app (`app/`, the main product).** The window is a frameless, transparent Electron window with macOS 26's
native `NSGlassEffectView` behind the web content (`electron-liquid-glass`, `cornerRadius: 22`, a faint dark
tint). The desktop really shows through, refracted and blurred by the system. On top of it the web layer adds
the cover colour *thinly* (about 60%) so the glass keeps its see-through quality. Below macOS 26 it falls back to
`vibrancy: 'hud'` (frosted).

**Browser extension (`extension/`).** Chrome draws its Document Picture-in-Picture window **opaque** with its own
title bar, so nothing behind it shows through. There the cover colour field stands in for "the world behind the
glass". This limit is why the project moved to the desktop app.

In both, the functional capsules (title, controls) refract the lyrics passing beneath them via `glass.js`.

## Decisions in FloatLyrics

| Layer | Treatment |
| --- | --- |
| Colour field | Two copies of the cover, about 1.6× the window size, `blur(40–56px) saturate(1.7–2)`, slowly drifting and rotating (30–40s cycles). Cross-fade on track change. A fallback gradient when there is no cover. |
| Dimming | About 30% dark gradient over the colour field (Apple's 35% guidance for bright media), plus a faint text shadow on the active line |
| Lyrics (content layer) | Not glass. Active line white and bold; other lines translucent white, slightly blurred and smaller (Apple Music-style focus). Edges fade like a scroll edge effect. |
| Title capsule (functional) | Refracting glass pill: cover thumbnail (concentric radius), title, artist |
| Controls capsule (functional) | Refracting glass pill that appears on hover: ⏮ ⏯ ⏭, then Earlier · Sync · Later (the sync group hides below 330px wide) |
| Window pane | 22px corners matching the native glass, inner hairline rim and top highlight. Capsules use 19px (concentric). |
| Launcher pill (extension only) | CSS glass (blur + saturate + rim) over the real page |
| Accessibility | `prefers-reduced-transparency` → opaque surfaces and a heavier dim; `prefers-reduced-motion` → no drift, no smooth scrolling |

Lens parameters live in `extension/glass.js`. Tune `bezel` (refracting rim width), `thickness` (displacement
strength) and the trailing `blur()` (regular ≈ more blur, clear ≈ less).

## Appearance options (kept deliberately small)

Like Apple's own Liquid Glass settings (Clear / Tinted, text size), people get a few bounded adjustments and
never a free-form editor. Every combination still looks like FloatLyrics, and the defaults are the look above.
Defined and validated in `app/renderer/looks.js`.

| Option | Where | Steps |
| --- | --- | --- |
| Theme | popover + Settings | **Cover** (default: cover colour), **Clear** (most see-through, stronger text shadow), **Tinted** (darker veil, easiest to read), **Graphite** (neutral, no cover colour), **Light** (light veil, dark text) |
| Text size | popover + Settings | 0.85 · **1** · 1.15 · 1.3 × |
| Glass: Clear ↔ Frosted | Settings | veil × 0.4 · 0.7 · **1** · 1.4 · 1.8 |
| Cover colour | Settings | cover opacity × 0 · 0.5 · **1** · 1.3 · 1.6 (capped) |
| Soften other lines | Settings | **on** / off |
| Alignment | Settings | **Centre** / Left |
| Keep above other windows | Settings | **on** / off |

Themes only move CSS variables (`--veil`, `--art-a`, `--glass-fill`, `--fg`…), never the layout.

