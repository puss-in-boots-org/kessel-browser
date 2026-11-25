// The first-run setup's suggestions (welcome.html), and Settings' quick
// "How hard Kessel works" choice: what a PC like this one should start with,
// and what each choice changes. Pure, so tests/unit/setup-profiles.test.mjs
// can check them.

const GB = 1024 ** 3;

// Software drawing (no usable graphics card): WebGL names these.
const SOFTWARE_GPU = /swiftshader|basic render|llvmpipe|software/i;

// What the setup knows about the PC, tidied: {threads, memoryGB, battery,
// onBattery, cpu, gpu, softwareGpu, touch, screen: {w, h}}.
export function describePc(profile = {}, browser = {}) {
  const memoryGB = profile.memory ? Math.round((profile.memory / GB) * 10) / 10 : null;
  return {
    threads: profile.threads || null,
    memoryGB,
    battery: !!profile.battery,
    onBattery: !!profile.on_battery,
    // "Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz" -> "Intel Core i5-8250U".
    cpu: String(profile.cpu || "").replace(/\((R|TM|C)\)/gi, "").replace(/\s+@.*$/, "").replace(/\s+(CPU|Processor)\b/gi, "").replace(/\s+\d+-Core$/i, "").replace(/\s+/g, " ").trim(),
    gpu: String(browser.gpu || "").trim(),
    softwareGpu: SOFTWARE_GPU.test(browser.gpu || ""),
    touch: !!browser.touch,
    screen: browser.screen || null,
  };
}

// A graphics card's name as people know it: WebGL says
// "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)".
export function prettyGpu(name) {
  let n = String(name || "").trim();
  if (/swiftshader/i.test(n)) return "SwiftShader (software)";
  if (/basic render/i.test(n)) return "Microsoft Basic Render (software)";
  const angle = /^ANGLE \((.*)\)$/.exec(n);
  if (angle) {
    const parts = angle[1].split(", ");
    n = parts.length >= 2 ? parts[1] : parts[0];
  }
  return n.replace(/\s*\(0x[0-9a-f]+\)/gi, "").replace(/\s+(Direct3D|D3D|OpenGL|Vulkan)\S*.*$/i, "").replace(/\s+/g, " ").trim();
}

// --- How hard Kessel works --------------------------------------------------------------

export const PERFORMANCE = {
  light: {
    label: "Light",
    tagline: "Easy on an older or smaller PC",
    points: ["Background tabs rest after 2 minutes", "At most 8 tabs kept awake", "Energy saver always on"],
    settings: { freeze_tabs_after_minutes: 2, max_awake_tabs: 8, discard_tabs_after_minutes: 5, reduce_background_memory: true, hover_card_preview: false },
    features: { energy_saver: "always" },
  },
  balanced: {
    label: "Balanced",
    tagline: "Quick, and kind to the battery",
    points: ["Background tabs rest after 5 minutes", "Energy saver on battery", "All the effects"],
    settings: { freeze_tabs_after_minutes: 5, max_awake_tabs: 0, discard_tabs_after_minutes: 10, reduce_background_memory: true, hover_card_preview: true },
    features: { energy_saver: "battery" },
  },
  full: {
    label: "Full power",
    tagline: "Every tab ready the moment you switch",
    points: ["Background tabs stay awake for 15 minutes", "Tabs never unloaded", "All the effects"],
    settings: { freeze_tabs_after_minutes: 15, max_awake_tabs: 0, discard_tabs_after_minutes: 0, reduce_background_memory: false, hover_card_preview: true },
    features: { energy_saver: "battery" },
  },
};

// Which suits this PC, and why, in a sentence.
export function recommendPerformance(pc) {
  const { memoryGB, threads, softwareGpu, battery } = pc;
  if ((memoryGB && memoryGB <= 8) || (threads && threads <= 4) || softwareGpu) {
    const why = memoryGB && memoryGB <= 8 ? `${fmtGB(memoryGB)} of memory` : threads && threads <= 4 ? `${threads} processor threads` : "drawing without a graphics card";
    return { id: "light", why: `With ${why}, resting background tabs keeps the tab you're on quick.` };
  }
  if (memoryGB >= 16 && threads >= 8 && !battery) {
    return { id: "full", why: `${fmtGB(memoryGB)} of memory and ${threads} threads: plenty to keep every tab awake.` };
  }
  return { id: "balanced", why: battery ? "On a laptop, resting idle tabs saves battery without you noticing." : "A good mix of speed and memory for this PC." };
}

const fmtGB = (gb) => `${Math.round(gb)} GB`;

// Which of PERFORMANCE the settings are on now (null: something in between).
export function currentPerformance(settings) {
  for (const [id, p] of Object.entries(PERFORMANCE)) {
    if (Object.entries(p.settings).every(([k, v]) => k === "hover_card_preview" || settings?.[k] === v)) return id;
  }
  return null;
}

export function performancePatch(id, settings) {
  const p = PERFORMANCE[id] || PERFORMANCE.balanced;
  return { ...p.settings, features: { ...(settings?.features || {}), ...p.features } };
}

// --- Privacy --------------------------------------------------------------------------

export const PRIVACY = {
  standard: {
    label: "Standard",
    tagline: "Blocks ads and trackers; every site works",
    points: ["Ads and trackers blocked", "Other sites' cookies blocked", "Asks sites not to sell your data"],
    settings: { adblock_enabled: true, shields_tracking_prevention: "balanced", shields_fingerprinting: true, block_third_party_cookies: true, https_only: false, send_gpc: true, send_dnt: false },
  },
  strict: {
    label: "Strict",
    tagline: "The most protection; a few sites may need a tap",
    points: ["Everything in Standard", "Strict tracking prevention", "Secure (HTTPS) connections only"],
    settings: { adblock_enabled: true, shields_tracking_prevention: "strict", shields_fingerprinting: true, block_third_party_cookies: true, https_only: true, send_gpc: true, send_dnt: true },
  },
};

export function currentPrivacy(settings) {
  for (const [id, p] of Object.entries(PRIVACY)) if (Object.entries(p.settings).every(([k, v]) => settings?.[k] === v)) return id;
  return null;
}

// --- Looks ------------------------------------------------------------------------------

// The styles the setup offers (all of them stay in Settings -> Appearance).
export const SETUP_STYLES = ["instrument", "glass", "clean", "fluent"];

// Liquid Glass blurs and bends what's behind it: lovely, and the heaviest
// on a graphics card.
export function recommendStyle(pc, performance) {
  if (pc.softwareGpu || performance === "light") return "clean";
  return "instrument";
}

// The density that suits the screen: big targets on a touch screen, more
// page on a small one.
export function recommendDensity(pc) {
  if (pc.touch) return "touch";
  if (pc.screen && pc.screen.h && pc.screen.h < 800) return "compact";
  return "normal";
}

export const DESKTOP_BLUR = 24;

// Colours: "desktop" (the Windows wallpaper's), a Kessel wallpaper's id
// (with that wallpaper behind the bars), or "style" (the style's own, in
// `mode`). `showDesktop`: the desktop picture behind the bars too.
export function lookValues({ colours = "style", mode = "dark", showDesktop = false } = {}) {
  if (colours === "desktop") {
    // Behind the toolbar, the desktop picture is blurred so it doesn't
    // compete with the tabs and the address bar.
    return { wallTheme: true, wallSource: "desktop", mode: "wallpaper", ...(showDesktop ? { background: "wallpaper", wallpaper: "custom", wallBlur: DESKTOP_BLUR } : {}) };
  }
  if (colours && colours !== "style") return { wallTheme: true, wallSource: "kessel", mode: "wallpaper", background: "wallpaper", wallpaper: colours };
  return { wallTheme: false, mode };
}

// Everything the setup's answers change, as one settings patch.
// `answers`: {performance, privacy, style, colours, mode, showDesktop,
// density, search_engine, tab_layout, restore_tabs}.
export function setupPatch(settings, answers, allCustom = {}) {
  const features = { ...(settings?.features || {}), ...(PERFORMANCE[answers.performance]?.features || {}), setup_done: true };
  if (answers.density && answers.density !== "normal") features.ui_density = answers.density;
  else delete features.ui_density;
  const style = answers.style || "instrument";
  const look = lookValues(answers);
  const mine = { ...(allCustom[style] || {}) };
  // A fresh choice of colours replaces the last one.
  for (const key of ["wallTheme", "wallSource", "mode", "background", "wallpaper", "wallBlur"]) delete mine[key];
  return {
    ...(PERFORMANCE[answers.performance]?.settings || {}),
    ...(PRIVACY[answers.privacy]?.settings || {}),
    ...(answers.search_engine ? { search_engine: answers.search_engine } : {}),
    ...(answers.tab_layout ? { tab_layout: answers.tab_layout } : {}),
    ...(answers.restore_tabs !== undefined ? { restore_tabs: !!answers.restore_tabs } : {}),
    ui_style: style,
    ui_custom: { ...allCustom, [style]: { ...mine, ...look } },
    features,
  };
}
