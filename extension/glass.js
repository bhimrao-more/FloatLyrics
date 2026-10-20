/*
 * FloatLyrics glass — a liquid-glass lens for Chromium. Builds an SVG displacement map for an element's exact
 * size and uses it as that element's backdrop-filter, so whatever passes beneath bends at the element's rim.
 * Method after kube.io's "Liquid Glass in the browser" (Snell's law over a squircle bezel); see docs/liquid-glass.md.
 */
(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const IOR = 1.5; // glass
  const SAMPLES = 128;

  // Height of the glass across its bezel: 0 at the outer edge, 1 where the flat top begins (convex squircle).
  const surface = (x) => Math.pow(1 - Math.pow(1 - x, 4), 0.25);

  // How far a vertical ray entering at bezel position x lands from where it would without glass, in px.
  function bend(x, bezel, thickness) {
    const d = 0.001;
    const slope = ((surface(Math.min(1, x + d)) - surface(Math.max(0, x - d))) / (2 * d)) * (thickness / bezel);
    const incidence = Math.atan(slope);
    const refracted = Math.asin(Math.sin(incidence) / IOR);
    return surface(x) * thickness * Math.tan(incidence - refracted);
  }

  // Signed distance to a w×h rounded rectangle of corner radius r, negative inside.
  function sdf(px, py, w, h, r) {
    const qx = Math.abs(px - w / 2) - (w / 2 - r);
    const qy = Math.abs(py - h / 2) - (h / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }

  // RGBA pixels of the displacement map, and the filter scale that decodes them back to pixels.
  function displacementMap(w, h, r, bezel, thickness) {
    const profile = new Float32Array(SAMPLES);
    let max = 0;
    for (let i = 0; i < SAMPLES; i++) {
      profile[i] = bend(i / (SAMPLES - 1), bezel, thickness);
      max = Math.max(max, Math.abs(profile[i]));
    }
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let dx = 0;
        let dy = 0;
        const px = x + 0.5;
        const py = y + 0.5;
        const inside = -sdf(px, py, w, h, r);
        if (max > 0 && inside > 0 && inside < bezel) {
          const m = profile[Math.round((inside / bezel) * (SAMPLES - 1))] / max;
          // Edge normal from the SDF gradient; rays bend inward, so sample from further inside.
          const nx = sdf(px + 0.5, py, w, h, r) - sdf(px - 0.5, py, w, h, r);
          const ny = sdf(px, py + 0.5, w, h, r) - sdf(px, py - 0.5, w, h, r);
          const len = Math.hypot(nx, ny) || 1;
          dx = (-nx / len) * m;
          dy = (-ny / len) * m;
        }
        data[o] = 128 + dx * 127;
        data[o + 1] = 128 + dy * 127;
        data[o + 2] = 128;
        data[o + 3] = 255;
      }
    }
    return { data, scale: 2 * max };
  }

  let counter = 0;

  /*
   * Gives `el` (in `doc`) a refracting backdrop. Options: bezel and thickness in px, and `after`, the CSS filters
   * applied to the refracted backdrop (blur, saturate...). Call update() whenever the element may have resized.
   */
  function lens(doc, el, opts = {}) {
    const bezel = opts.bezel || 12;
    const thickness = opts.thickness || 20;
    const after = opts.after || 'blur(2px) saturate(1.8)';
    const id = `fl-lens-${++counter}`;

    let svg = doc.getElementById('fl-lens-defs');
    if (!svg) {
      svg = doc.createElementNS(SVG_NS, 'svg');
      svg.id = 'fl-lens-defs';
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
      svg.appendChild(doc.createElementNS(SVG_NS, 'defs'));
      doc.body.appendChild(svg);
    }
    const filter = doc.createElementNS(SVG_NS, 'filter');
    filter.id = id;
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    const image = doc.createElementNS(SVG_NS, 'feImage');
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('result', 'map');
    const shift = doc.createElementNS(SVG_NS, 'feDisplacementMap');
    shift.setAttribute('in', 'SourceGraphic');
    shift.setAttribute('in2', 'map');
    shift.setAttribute('xChannelSelector', 'R');
    shift.setAttribute('yChannelSelector', 'G');
    filter.append(image, shift);
    svg.firstChild.appendChild(filter);

    let size = '';
    function update() {
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      if (!w || !h || `${w}x${h}` === size) return;
      size = `${w}x${h}`;
      const radius = Math.min(parseFloat(doc.defaultView.getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2);
      const map = displacementMap(w, h, radius, Math.min(bezel, radius || bezel, h / 2), thickness);
      const canvas = doc.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const pixels = ctx.createImageData(w, h);
      pixels.data.set(map.data);
      ctx.putImageData(pixels, 0, 0);
      for (const [k, v] of [['width', w], ['height', h]]) {
        filter.setAttribute(k, String(v));
        image.setAttribute(k, String(v));
      }
      image.setAttribute('href', canvas.toDataURL());
      shift.setAttribute('scale', map.scale.toFixed(2));
      el.style.backdropFilter = `url(#${id}) ${after}`;
    }

    update();
    return { update, id, el };
  }

  const api = { lens, displacementMap, bend, surface };
  root.FloatLyricsGlass = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
