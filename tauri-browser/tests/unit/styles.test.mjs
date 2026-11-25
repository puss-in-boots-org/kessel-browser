import { test } from "node:test";
import assert from "node:assert/strict";
import { tintToward, isColourful, skyCss, luminance, resolveStyle, buildLook, setRiceAccent, STYLE_IDS, STYLES } from "../../src/shared/styles.js";

test("Accent from the wallpaper: the rice hub's accent lights the keys, only while it's on", () => {
  const wall = { ui_style: "instrument", ui_custom: { instrument: STYLES.instrument.presets.find((p) => p.name === "Wallpaper").values } };
  setRiceAccent("#ed9582");
  const r = resolveStyle(wall);
  assert.equal(r.values.accent, "#ed9582");
  assert.equal(buildLook(r, {}, null).vars["--accent"], "#ed9582");
  assert.equal(resolveStyle({ ui_style: "instrument", ui_custom: {} }).values.accent, "#ff5a1f", "off: your own accent");
  setRiceAccent(null); // no hub: your own accent again
  assert.equal(resolveStyle(wall).values.accent, "#ff5a1f");
  setRiceAccent("not a colour");
  assert.equal(resolveStyle(wall).values.accent, "#ff5a1f");
});

test("isColourful: greys, whites, blacks and near-whites have no colour", () => {
  for (const c of ["#ffffff", "#000000", "#808080", "#faf7ff", "#1e2327", "nope", ""]) assert.equal(isColourful(c), false, c);
  for (const c of ["#1f7a4d", "#5b2a86", "#0b3d91", "#ff0000"]) assert.equal(isColourful(c), true, c);
});

test("tintToward keeps the chrome's lightness and leaves grey pages alone", () => {
  const base = "#131316";
  assert.equal(tintToward(base, "#ffffff", 60), base);
  assert.equal(tintToward(base, "#1f7a4d", 0), base);
  const green = tintToward(base, "#1f7a4d", 60);
  assert.notEqual(green, base);
  // Still dark: text on it keeps its contrast.
  assert.ok(Math.abs(luminance(green) - luminance(base)) < 0.03, green);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));
  assert.ok(g > r && g > b, `green wins: ${green}`);
  // Light chrome stays light.
  assert.ok(luminance(tintToward("#efeeea", "#0b3d91", 100)) > 0.6);
});

test("skyCss follows the clock", () => {
  const at = (h) => skyCss(new Date(2026, 10, 17, h, 0));
  assert.notEqual(at(3), at(12));
  assert.match(at(12), /radial-gradient\(circle at [\d.]+% [\d.]+%/);
  assert.match(at(23), /linear-gradient\(180deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)/);
  // Washed toward the background, white text reads on a noon sky, dark
  // text on a midnight one.
  const sky = (h, bg) => skyCss(new Date(2026, 10, 17, h, 0), bg).match(/linear-gradient\(180deg, (#\w{6}), (#\w{6})\)/).slice(1).map(luminance);
  for (const l of sky(12, "#16161a")) assert.ok(l < 0.18, `noon on dark: ${l}`);
  for (const l of sky(0, "#f6f5f2")) assert.ok(l > 0.25, `midnight on light: ${l}`);
});

test("Instrument is Kessel's look: first, the default, one row, dark legends on orange", () => {
  assert.ok(STYLE_IDS[0] === "instrument" && STYLES.instrument);
  assert.equal(resolveStyle({}).id, "instrument");
  const r = resolveStyle({ ui_style: "instrument", ui_custom: {} });
  const look = buildLook(r, {}, null);
  assert.equal(look.attrs["data-k-layout"], "one", "the address beside the tabs");
  assert.notEqual(look.vars["--k-tab-active-bg"], r.values.accent, "the tab you're on is raised in light, not lit orange");
  assert.equal(look.vars["--accent-text"], "#0b0b10", "dark legends on the orange keys");
  const two = resolveStyle({ ui_style: "instrument", ui_custom: { instrument: STYLES.instrument.presets.find((p) => p.name === "Two rows").values } });
  assert.equal(buildLook(two, {}, null).attrs["data-k-layout"], "two", "Two rows is a preset");
});

test("the page's colour, on a style that asks for it", () => {
  const settings = { ui_style: "clean", ui_custom: { clean: { pageTint: 60, stripeTop: "page" } } };
  const r = resolveStyle(settings);
  const plain = buildLook(r, settings, null);
  assert.equal(plain.vars["--k-stripe"], r.values.accent);
  const tinted = buildLook(r, settings, "#5b2a86");
  assert.equal(tinted.vars["--k-stripe"], "#5b2a86");
  assert.notEqual(tinted.vars["--k-chrome-fill"], plain.vars["--k-chrome-fill"]);
  assert.ok(tinted.classes["k-page-tint"]);
});

test("styles without page tint ignore the page's colour", () => {
  const settings = { ui_style: "robust", ui_custom: { robust: { accent: "#1f6feb" } } };
  const r = resolveStyle(settings);
  assert.deepEqual(buildLook(r, settings, "#5b2a86"), buildLook(r, settings, null));
  assert.equal(buildLook(r, settings, null).attrs["data-k-layout"], "two");
});
