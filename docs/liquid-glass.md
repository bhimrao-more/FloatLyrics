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

## The limit we work within

The always-on-top window is a Chrome **Document Picture-in-Picture** window. Chrome draws it as an **opaque**
window, and `requestWindow()` has no transparency option. The desktop behind it therefore cannot show through.
So inside the extension:

- The *album cover*, blown up and heavily blurred, acts as the "world behind the glass". It gives the window its
  colour.
- The window itself is treated as a pane of glass over that colour field: rim light, depth, and a dimming layer
  for legibility.
- The functional controls are real refracting glass: the title capsule and the timing capsule. The lyrics
  scrolling beneath them bend at their edges.

Truly see-through glass over other apps needs a native window. That is the desktop-companion path: an Electron
window with `transparent: true` plus `electron-liquid-glass` (macOS 26+), loading the same UI. Keep the UI
self-contained (DOM + CSS + `glass.js`) so it can move into such a window unchanged.

The in-page fallback panel (used when Document PiP is unavailable) floats over the player page itself, so there
`backdrop-filter` gives genuine translucency over the page.

## Decisions in FloatLyrics

| Layer | Treatment |
| --- | --- |
| Colour field | Two copies of the cover, about 1.6× the window size, `blur(40–56px) saturate(1.7–2)`, slowly drifting and rotating (30–40s cycles). Cross-fade on track change. A fallback gradient when there is no cover. |
| Dimming | About 30% dark gradient over the colour field (Apple's 35% guidance for bright media), plus a faint text shadow on the active line |
| Lyrics (content layer) | Not glass. Active line white and bold; other lines translucent white, slightly blurred and smaller (Apple Music-style focus). Edges fade like a scroll edge effect. |
| Title capsule (functional) | Refracting glass pill: cover thumbnail (concentric radius), title, artist |
| Timing capsule (functional) | Refracting glass pill that appears on hover: Earlier · Sync · Later, plus the source |
| Window pane | Inner hairline rim and top highlight around the whole window |
| Launcher pill on the page | CSS glass (blur + saturate + rim) over the real page |
| Accessibility | `prefers-reduced-transparency` → opaque surfaces and a heavier dim; `prefers-reduced-motion` → no drift, no smooth scrolling |

Lens parameters live in `extension/glass.js`. Tune `bezel` (refracting rim width), `thickness` (displacement
strength) and the trailing `blur()` (regular ≈ more blur, clear ≈ less).
