// "Colours from the wallpaper": the whole interface -- background, panels,
// toolbar, side rail, tabs, the address bar, text, borders, links and both
// accents -- worked out from a wallpaper, so Kessel looks like it belongs on
// your desktop instead of only borrowing one accent colour.
//
// Pure functions only (unit-tested in tests/unit/wallpaper-theme.test.mjs).
// Where the colours come from -- one of Kessel's wallpapers, your own image,
// or the Windows desktop wallpaper -- is theme.js's job: it boils the source
// down to swatches ([{hex, weight}]) with swatchesFromCss / swatchesFromPixels
// and hands them to styles.js (setWallpaperSwatches), which lays
// paletteFromSwatches over the style's own palette.

// --- Colour helpers -----------------------------------------------------------------

function parseHex(hex) {
  const h = String(hex || "").replace("#", "");
  if (/^[0-9a-f]{3}$/i.test(h)) return [...h].map((c) => parseInt(c + c, 16));
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function toHex(rgb) {
  return "#" + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
}

export function luminanceOf(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

export function contrast(a, b) {
  const [x, y] = [luminanceOf(a), luminanceOf(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function rgbToHsl([r, g, b]) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => (v + l - c / 2) * 255);
}

const hsl = (h, s, l) => toHex(hslToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l))));
const hslOf = (hex) => rgbToHsl(parseHex(hex) || [128, 128, 128]);
// How colourful a colour looks (HSL calls near-whites fully saturated).
const chroma = (hex) => {
  const rgb = parseHex(hex) || [0, 0, 0];
  return (Math.max(...rgb) - Math.min(...rgb)) / 255;
};
const hueGap = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// --- Swatches ----------------------------------------------------------------------

// The colours in a CSS background (Kessel's own wallpapers are layered
// gradients): each colour weighted by how much of the picture it covers --
// a radial blob by its size and opacity, a linear gradient's stops sharing
// the base layer.
export function swatchesFromCss(css) {
  const out = [];
  const text = String(css || "");
  // Split into top-level layers (commas inside parentheses don't count).
  const layers = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      layers.push(text.slice(start, i));
      start = i + 1;
    }
  }
  layers.push(text.slice(start));
  for (const layer of layers) {
    const colours = [];
    for (const m of layer.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)|#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
      if (m[5]) colours.push({ hex: toHex(parseHex(m[5])), a: 1 });
      else {
        let a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (String(m[4]).endsWith("%")) a /= 100;
        colours.push({ hex: toHex([+m[1], +m[2], +m[3]]), a });
      }
    }
    if (!colours.length) continue;
    if (/radial-gradient/i.test(layer)) {
      // "55% 40% at ..." -- the blob's size.
      const size = layer.match(/radial-gradient\(\s*([\d.]+)%\s+([\d.]+)%/i);
      const area = size ? (parseFloat(size[1]) * parseFloat(size[2])) / 10000 : 0.25;
      // Only the first stop is the blob; the rest fade it out.
      out.push({ hex: colours[0].hex, weight: colours[0].a * area * 1.6 });
    } else {
      for (const c of colours) out.push({ hex: c.hex, weight: (c.a * 1) / colours.length });
    }
  }
  return mergeSwatches(out);
}

// The colours in a picture: `data` is RGBA pixels (a canvas's getImageData),
// bucketed and counted, most-covering first. Transparent pixels don't count.
export function swatchesFromPixels(data, { max = 12 } = {}) {
  const buckets = new Map();
  let total = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    // 5 bits a channel: close shades fall in one bucket.
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { r: 0, g: 0, b: 0, n: 0 }));
    b.r += data[i];
    b.g += data[i + 1];
    b.b += data[i + 2];
    b.n++;
    total++;
  }
  if (!total) return [];
  const raw = [...buckets.values()].map((b) => ({ hex: toHex([b.r / b.n, b.g / b.n, b.b / b.n]), weight: b.n / total }));
  return mergeSwatches(raw, max);
}

// Joins swatches that look alike (close in hue, lightness and saturation),
// keeping the `max` that cover the most.
export function mergeSwatches(list, max = 12) {
  const sorted = [...list].filter((s) => parseHex(s.hex) && s.weight > 0).sort((a, b) => b.weight - a.weight);
  const merged = [];
  for (const s of sorted) {
    const [h, sat, l] = hslOf(s.hex);
    const near = merged.find((m) => {
      const [mh, ms, ml] = hslOf(m.hex);
      const grey = chroma(m.hex) < 0.08 && chroma(s.hex) < 0.08;
      return Math.abs(ml - l) < 0.12 && (grey || (hueGap(mh, h) < 22 && Math.abs(ms - sat) < 0.35));
    });
    if (near) {
      // Weighted average of the two.
      const a = parseHex(near.hex);
      const b = parseHex(s.hex);
      const t = s.weight / (near.weight + s.weight);
      near.hex = toHex(a.map((c, i) => c + (b[i] - c) * t));
      near.weight += s.weight;
    } else merged.push({ ...s });
  }
  const top = merged.sort((a, b) => b.weight - a.weight).slice(0, max);
  const sum = top.reduce((n, s) => n + s.weight, 0) || 1;
  return top.map((s) => ({ hex: s.hex, weight: Math.round((s.weight / sum) * 1000) / 1000 }));
}

// --- The palette ------------------------------------------------------------------

// Light or dark, judged by how bright the wallpaper is overall.
export function wallpaperMode(swatches) {
  if (!swatches?.length) return "dark";
  const lum = swatches.reduce((n, s) => n + luminanceOf(s.hex) * s.weight, 0) / swatches.reduce((n, s) => n + s.weight, 0);
  return lum > 0.36 ? "light" : "dark";
}

// The most striking colour: colourful, and not a speck.
function pickAccent(swatches, avoidHue = null) {
  let best = null;
  let bestScore = -1;
  for (const s of swatches) {
    const [h, sat, l] = hslOf(s.hex);
    const c = chroma(s.hex);
    if (c < 0.1) continue;
    if (avoidHue !== null && hueGap(h, avoidHue) < 40) continue;
    // Mid lightness reads best as an accent; coverage counts, but less than colour.
    const score = c * 1.4 + sat * 0.4 + Math.sqrt(s.weight) * 0.9 - Math.abs(l - 0.55) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = s.hex;
    }
  }
  return best;
}

// The accent made usable: bright enough to read on a dark interface, deep
// enough on a light one, and never washed out.
function tuneAccent(hex, mode) {
  const [h, s, l] = hslOf(hex);
  const sat = Math.max(0.55, Math.min(0.95, s));
  const light = mode === "dark" ? Math.max(0.56, Math.min(0.7, l)) : Math.max(0.4, Math.min(0.5, l));
  return hsl(h, sat, light);
}

// Every colour of the interface, from a wallpaper's swatches, for `mode`
// ("dark" | "light"; null = whichever suits the wallpaper). Null without
// swatches. Neutral surfaces carry the wallpaper's main hue, gently, so text
// always keeps its contrast; the accents carry its most striking colours.
export function paletteFromSwatches(swatches, mode = null) {
  if (!swatches?.length) return null;
  mode = mode === "light" || mode === "dark" ? mode : wallpaperMode(swatches);
  const dark = mode === "dark";
  // The base hue: the colour covering the most that has any colour at all.
  const colourful = swatches.filter((s) => chroma(s.hex) >= 0.06);
  const base = colourful[0] || swatches[0];
  const [bh, bsRaw] = hslOf(base.hex);
  const bs = chroma(base.hex) < 0.06 ? 0 : Math.min(bsRaw, 1);
  // How much of the hue the surfaces take: enough to feel it, never loud.
  const ns = Math.min(0.32, bs * 0.45);

  const accentRaw = pickAccent(swatches) || hsl(bh, 0.7, 0.6);
  const accent = tuneAccent(accentRaw, mode);
  const accentHue = hslOf(accent)[0];
  const secondRaw = pickAccent(swatches, accentHue) || hsl(accentHue + 150, 0.7, 0.6);
  const accent2 = tuneAccent(secondRaw, mode);

  const p = dark
    ? {
        bg: hsl(bh, ns, 0.085),
        surface: hsl(bh, ns * 0.9, 0.125),
        surface2: hsl(bh, ns * 0.85, 0.165),
        hover: hsl(bh, ns * 0.8, 0.205),
        border: hsl(bh, ns * 0.7, 0.26),
        text: hsl(bh, Math.min(0.25, ns * 0.6), 0.94),
        textDim: hsl(bh, Math.min(0.18, ns * 0.5), 0.72),
        textFaint: hsl(bh, Math.min(0.14, ns * 0.45), 0.54),
        chromeBg: hsl(bh, ns, 0.105),
        railBg: hsl(bh, ns, 0.105),
        tabActiveBg: hsl(bh, ns * 0.9, 0.185),
        addressBg: hsl(bh, ns * 0.85, 0.15),
      }
    : {
        bg: hsl(bh, ns * 0.9, 0.95),
        surface: hsl(bh, ns * 0.7, 0.985),
        surface2: hsl(bh, ns * 0.8, 0.925),
        hover: hsl(bh, ns * 0.8, 0.895),
        border: hsl(bh, ns * 0.6, 0.82),
        text: hsl(bh, Math.min(0.3, ns * 0.8), 0.13),
        textDim: hsl(bh, Math.min(0.2, ns * 0.6), 0.35),
        textFaint: hsl(bh, Math.min(0.15, ns * 0.5), 0.5),
        chromeBg: hsl(bh, ns, 0.915),
        railBg: hsl(bh, ns, 0.915),
        tabActiveBg: hsl(bh, ns * 0.6, 0.99),
        addressBg: hsl(bh, ns * 0.6, 0.99),
      };
  p.selection = accent;
  // Links: the accent, pushed until it reads on the background.
  let [lh, ls, ll] = hslOf(accent);
  let link = accent;
  for (let i = 0; i < 12 && contrast(link, p.bg) < 4.5; i++) {
    ll += dark ? 0.04 : -0.04;
    link = hsl(lh, ls, ll);
  }
  p.link = link;
  // A wallpaper-coloured backdrop for styles that paint a gradient instead.
  const second = colourful.find((s) => hueGap(hslOf(s.hex)[0], bh) > 30) || base;
  const gradient = dark
    ? [hsl(bh, Math.max(0.3, bs * 0.7), 0.16), hsl(hslOf(second.hex)[0], Math.max(0.3, chroma(second.hex) * 0.8), 0.12)]
    : [hsl(bh, Math.max(0.25, bs * 0.6), 0.86), hsl(hslOf(second.hex)[0], Math.max(0.25, chroma(second.hex) * 0.6), 0.9)];
  return {
    mode,
    accent,
    accent2,
    palette: p,
    bgGradientA: gradient[0],
    bgGradientB: gradient[1],
    // The glass picks up the wallpaper's own hue.
    glassTintColor: hsl(bh, Math.max(0.2, bs * 0.6), dark ? 0.2 : 0.85),
    // A few colours to show in Settings and the setup: what it found.
    colours: swatches.slice(0, 6).map((s) => s.hex),
  };
}
