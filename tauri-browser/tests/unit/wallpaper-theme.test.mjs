import { test } from "node:test";
import assert from "node:assert/strict";
import { swatchesFromCss, swatchesFromPixels, paletteFromSwatches, wallpaperMode, contrast, mergeSwatches } from "../../src/shared/wallpaper-theme.js";
import { resolveStyle, buildLook, setWallpaperSwatches, STYLES } from "../../src/shared/styles.js";

// Kessel's own wallpapers (glass.js), copied: glass.js touches the DOM.
const NIGHTFALL = `radial-gradient(60% 45% at 18% 78%, rgba(255, 170, 70, 0.55), transparent 70%),
      radial-gradient(45% 40% at 82% 22%, rgba(120, 150, 255, 0.55), transparent 70%),
      radial-gradient(70% 55% at 55% 105%, rgba(20, 140, 170, 0.75), transparent 70%),
      radial-gradient(40% 30% at 40% 30%, rgba(170, 110, 255, 0.35), transparent 70%),
      linear-gradient(180deg, #0a1433 0%, #15306b 42%, #1d4b80 68%, #0a1a33 100%)`;
const MIST = `radial-gradient(55% 45% at 25% 30%, rgba(255, 255, 255, 0.95), transparent 70%),
      radial-gradient(50% 45% at 80% 75%, rgba(170, 190, 215, 0.7), transparent 70%),
      linear-gradient(165deg, #e8edf3 0%, #cfd8e3 100%)`;
const hex = /^#[0-9a-f]{6}$/;

test("swatchesFromCss: every colour of a layered gradient, weights adding up to 1", () => {
  const s = swatchesFromCss(NIGHTFALL);
  assert.ok(s.length >= 4);
  for (const { hex: h } of s) assert.match(h, hex);
  const sum = s.reduce((n, x) => n + x.weight, 0);
  assert.ok(Math.abs(sum - 1) < 0.02, String(sum));
  assert.deepEqual(swatchesFromCss("none"), []);
});

test("swatchesFromPixels: the colour covering most comes first, transparent pixels skipped", () => {
  const px = [];
  for (let i = 0; i < 300; i++) px.push(20, 40, 120, 255);
  for (let i = 0; i < 100; i++) px.push(250, 120, 30, 255);
  for (let i = 0; i < 500; i++) px.push(255, 255, 255, 0);
  const s = swatchesFromPixels(Uint8ClampedArray.from(px));
  assert.equal(s.length, 2);
  assert.equal(s[0].hex, "#142878");
  assert.equal(s[0].weight, 0.75);
  assert.deepEqual(swatchesFromPixels(new Uint8ClampedArray(8)), []);
});

test("mergeSwatches joins near shades", () => {
  const s = mergeSwatches([{ hex: "#102060", weight: 1 }, { hex: "#122262", weight: 1 }, { hex: "#ff8800", weight: 1 }]);
  assert.equal(s.length, 2);
});

test("wallpaperMode: dark wallpapers dark, light ones light", () => {
  assert.equal(wallpaperMode(swatchesFromCss(NIGHTFALL)), "dark");
  assert.equal(wallpaperMode(swatchesFromCss(MIST)), "light");
  assert.equal(wallpaperMode(null), "dark");
});

test("paletteFromSwatches: a whole, readable interface in the wallpaper's colours", () => {
  for (const [css, mode] of [[NIGHTFALL, "dark"], [MIST, "light"], [NIGHTFALL, "light"], [MIST, "dark"]]) {
    const p = paletteFromSwatches(swatchesFromCss(css), mode);
    assert.equal(p.mode, mode);
    for (const key of ["bg", "surface", "surface2", "hover", "border", "text", "textDim", "textFaint", "chromeBg", "railBg", "tabActiveBg", "addressBg", "selection", "link"]) assert.match(p.palette[key], hex, key);
    for (const key of ["accent", "accent2", "bgGradientA", "bgGradientB", "glassTintColor"]) assert.match(p[key], hex, key);
    assert.ok(contrast(p.palette.text, p.palette.bg) >= 7, `text on ${mode}`);
    assert.ok(contrast(p.palette.textDim, p.palette.surface) >= 4.5, `dim text on ${mode}`);
    assert.ok(contrast(p.palette.link, p.palette.bg) >= 4.5, `links on ${mode}`);
    assert.notEqual(p.accent, p.accent2);
  }
  // Nightfall's blue shows in its surfaces.
  const night = paletteFromSwatches(swatchesFromCss(NIGHTFALL), "dark").palette.bg;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(night.slice(i, i + 2), 16));
  assert.ok(b > r && b > g, night);
  assert.equal(paletteFromSwatches([]), null);
});

test("an orange wallpaper gives an orange accent", () => {
  const p = paletteFromSwatches([{ hex: "#101014", weight: 0.7 }, { hex: "#f07a1a", weight: 0.3 }], "dark");
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.accent.slice(i, i + 2), 16));
  assert.ok(r > g && g > b, p.accent);
});

test("Colours from the wallpaper recolours the whole look, only while it's on", () => {
  setWallpaperSwatches(swatchesFromCss(NIGHTFALL));
  const on = { ui_style: "clean", ui_custom: { clean: { wallTheme: true, mode: "wallpaper" } } };
  const r = resolveStyle(on);
  const wall = paletteFromSwatches(swatchesFromCss(NIGHTFALL), "dark");
  assert.equal(r.mode, "dark");
  assert.equal(r.values.accent, wall.accent);
  assert.equal(r.values.bg, wall.palette.bg);
  assert.equal(r.values.chromeBg, wall.palette.chromeBg);
  const look = buildLook(r, {}, null);
  assert.equal(look.vars["--bg"], wall.palette.bg);
  assert.equal(look.vars["--text"], wall.palette.text);
  // Your own palette colour still wins.
  const mine = resolveStyle({ ui_style: "clean", ui_custom: { clean: { wallTheme: true, mode: "dark", "bg@dark": "#000000" } } });
  assert.equal(mine.values.bg, "#000000");
  // Off: the style's own colours.
  const off = resolveStyle({ ui_style: "clean", ui_custom: {} });
  assert.notEqual(off.values.bg, wall.palette.bg);
  // Instrument keeps its LCD.
  const inst = resolveStyle({ ui_style: "instrument", ui_custom: { instrument: STYLES.instrument.presets.find((p) => p.name === "Desktop").values } });
  assert.equal(inst.values.addressBg, resolveStyle({ ui_style: "instrument", ui_custom: { instrument: { mode: "dark" } } }).values.addressBg);
  setWallpaperSwatches(null);
  // No wallpaper colours (yet): the style's own.
  assert.equal(resolveStyle(on).values.bg, resolveStyle({ ui_style: "clean", ui_custom: { clean: { mode: "dark" } } }).values.bg);
});
