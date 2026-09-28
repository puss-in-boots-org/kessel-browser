// Applies the persisted appearance settings -- the UI style and everything
// you changed about it (shared/styles.js) -- to <html>, and keeps every open
// page (toolbar, new tab, settings, passwords are each a separate
// webview/document) in sync live via the "settings-changed" event the
// backend broadcasts on every save.

import { applyGlass } from "./glass.js";
import { applyStyle, applyCachedLook, backdropCss, backdropTone } from "./styles.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Last load's look, straight away -- the settings are still on their way.
applyCachedLook();

// What glass.js needs from the style: whether the glass is on, and what the
// backdrop layer behind the chrome paints.
function glassLook(r) {
  const v = r.values;
  const toneOption = { white: "dark", dark: "light" }[v.glassTone];
  return {
    enabled: r.id === "glass",
    refraction: v.glassRefraction,
    refractionScale: v.refractionStrength / 100,
    wallpaper: v.wallpaper,
    backdrop: v.background === "wallpaper" ? null : backdropCss(v) || v.bg,
    tone: toneOption || (v.background === "wallpaper" ? null : backdropTone(v)),
  };
}

let ambientOn = false;

function applyTheme(settings) {
  const r = applyStyle(settings);
  document.documentElement.classList.toggle("reduce-motion", !!settings.reduce_motion);
  applyGlass(settings, glassLook(r));
  window.__kesselSettings = settings;
  window.__kesselStyle = r;
  // Ambient drift runs off the wall clock so the toolbar and a new tab page,
  // separate pages, move in step and their backgrounds stay seamless. Set
  // as it starts: moving it later would make a running drift jump.
  const root = document.documentElement;
  const ambient = root.classList.contains("k-ambient");
  if (ambient && !ambientOn) root.style.setProperty("--k-ambient-delay", `-${Date.now() % 120000}ms`);
  ambientOn = ambient;
  window.dispatchEvent(new CustomEvent("kessel-settings", { detail: settings }));
}

let cached = null;
// >0 while this page has style edits the backend hasn't confirmed yet: an
// older broadcast arriving meanwhile mustn't snap them back.
let holds = 0;
const STYLE_FIELDS = ["ui_style", "ui_custom", "ui_presets"];

export async function initTheme() {
  try {
    cached = await invoke("get_settings");
    applyTheme(cached);
  } catch (e) {
    // Fall back to CSS defaults (dark) if the backend isn't ready yet.
  }
  listen("settings-changed", (event) => {
    const incoming = event.payload;
    if (holds > 0 && cached) for (const key of STYLE_FIELDS) incoming[key] = cached[key];
    cached = incoming;
    applyTheme(cached);
  });
  // "Follow Windows" mode: repaint when Windows switches dark/light.
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => cached && applyTheme(cached));
  } catch {}
  return cached;
}

export function currentSettings() {
  return cached;
}

export async function saveSettings(patch) {
  const previous = cached;
  const next = { ...(cached || {}), ...patch };
  holds++;
  try {
    cached = next;
    applyTheme(next);
    await invoke("update_settings", { settings: next });
  } catch (e) {
    // Not saved: don't keep showing it.
    cached = previous;
    if (previous) applyTheme(previous);
    throw e;
  } finally {
    holds--;
  }
  return next;
}

// Shows `patch` on this page right away without saving it (a slider being
// dragged); saveSettings makes it stick. Wrap the edit in beginPreview /
// endPreview so older broadcasts arriving meanwhile don't snap it back.
export function previewSettings(patch) {
  if (!cached) return;
  cached = { ...cached, ...patch };
  applyTheme(cached);
}

export function beginPreview() {
  holds++;
}

export function endPreview() {
  holds = Math.max(0, holds - 1);
}
