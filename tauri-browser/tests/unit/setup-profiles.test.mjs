import { test } from "node:test";
import assert from "node:assert/strict";
import { describePc, recommendPerformance, recommendStyle, recommendDensity, currentPerformance, performancePatch, currentPrivacy, PRIVACY, setupPatch, lookValues } from "../../src/shared/setup-profiles.js";

const GB = 1024 ** 3;

test("describePc tidies what Rust and the page found", () => {
  const pc = describePc({ threads: 8, memory: 15.8 * GB, battery: true, cpu: "  AMD  Ryzen 7 " }, { gpu: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))", touch: false });
  assert.equal(pc.memoryGB, 15.8);
  assert.equal(pc.cpu, "AMD Ryzen 7");
  assert.equal(describePc({ cpu: "Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz" }).cpu, "Intel Core i5-8250U");
  assert.equal(describePc({ cpu: "AMD Ryzen 7 7840HS w/ Radeon 780M Graphics" }).cpu, "AMD Ryzen 7 7840HS w/ Radeon 780M Graphics");
  assert.equal(pc.softwareGpu, true);
  assert.equal(describePc().memoryGB, null);
});

test("recommendPerformance: light for small PCs, full for big desktops, balanced otherwise", () => {
  assert.equal(recommendPerformance(describePc({ threads: 4, memory: 16 * GB })).id, "light");
  assert.equal(recommendPerformance(describePc({ threads: 12, memory: 8 * GB })).id, "light");
  assert.equal(recommendPerformance(describePc({ threads: 16, memory: 32 * GB })).id, "full");
  assert.equal(recommendPerformance(describePc({ threads: 16, memory: 32 * GB, battery: true })).id, "balanced");
  assert.equal(recommendPerformance(describePc({ threads: 8, memory: 12 * GB })).id, "balanced");
  // Nothing known: the middle.
  assert.equal(recommendPerformance(describePc({})).id, "balanced");
  assert.match(recommendPerformance(describePc({ threads: 4, memory: 6 * GB })).why, /6 GB/);
});

test("looks and density follow the PC", () => {
  assert.equal(recommendStyle(describePc({}, { gpu: "Microsoft Basic Render Driver" }), "balanced"), "clean");
  assert.equal(recommendStyle(describePc({}), "full"), "instrument");
  assert.equal(recommendDensity({ touch: true }), "touch");
  assert.equal(recommendDensity({ screen: { w: 1366, h: 768 } }), "compact");
  assert.equal(recommendDensity({ screen: { w: 2560, h: 1440 } }), "normal");
});

test("performance and privacy choices round-trip", () => {
  const s = { features: { keep: 1 } };
  for (const id of ["light", "balanced", "full"]) {
    const patch = performancePatch(id, s);
    assert.equal(patch.features.keep, 1, "other features stay");
    assert.equal(currentPerformance({ ...s, ...patch }), id);
  }
  assert.equal(currentPerformance({ freeze_tabs_after_minutes: 7 }), null);
  assert.equal(currentPrivacy({ ...PRIVACY.strict.settings }), "strict");
});

test("setupPatch: one patch with every answer, keeping your other style changes", () => {
  const settings = { features: { ui_gen: 3, ui_density: "touch" } };
  const all = { clean: { radius: 4, mode: "light", wallTheme: false }, glass: { glassBlur: 3 } };
  const p = setupPatch(settings, { performance: "light", privacy: "strict", style: "clean", colours: "desktop", density: "normal", search_engine: "brave", tab_layout: "vertical", restore_tabs: true }, all);
  assert.equal(p.ui_style, "clean");
  assert.deepEqual(p.ui_custom.clean, { radius: 4, wallTheme: true, wallSource: "desktop", mode: "wallpaper" });
  assert.deepEqual(p.ui_custom.glass, { glassBlur: 3 });
  assert.equal(p.features.ui_gen, 3);
  assert.equal(p.features.setup_done, true);
  assert.equal(p.features.ui_density, undefined);
  assert.equal(p.features.energy_saver, "always");
  assert.equal(p.https_only, true);
  assert.equal(p.search_engine, "brave");
  assert.equal(p.tab_layout, "vertical");
  assert.equal(p.restore_tabs, true);
  assert.deepEqual(lookValues({ colours: "aurora" }), { wallTheme: true, wallSource: "kessel", mode: "wallpaper", background: "wallpaper", wallpaper: "aurora" });
  assert.deepEqual(lookValues({ colours: "style", mode: "light" }), { wallTheme: false, mode: "light" });
  assert.deepEqual(lookValues({ colours: "desktop", showDesktop: true }).wallpaper, "custom");
});

test("prettyGpu: the card's name, without the engine's details", async () => {
  const { prettyGpu } = await import("../../src/shared/setup-profiles.js");
  assert.equal(prettyGpu("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)"), "NVIDIA GeForce RTX 3060");
  assert.equal(prettyGpu("ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)"), "Intel(R) UHD Graphics 620");
  assert.equal(prettyGpu("Mesa Intel(R) Xe Graphics"), "Mesa Intel(R) Xe Graphics");
  assert.equal(prettyGpu(""), "");
  assert.equal(prettyGpu("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"), "SwiftShader (software)");
});
