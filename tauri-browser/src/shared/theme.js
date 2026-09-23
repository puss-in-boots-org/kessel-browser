// Applies the persisted appearance settings to <html> as CSS custom
// properties, and keeps every open page (toolbar, new tab, settings,
// passwords are each a separate webview/document) in sync live via the
// "settings-changed" event the backend broadcasts on every save.

import { applyGlass } from "./glass.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function applyTheme(settings) {
  const root = document.documentElement;
  if (settings.theme === "light") {
    root.setAttribute("data-theme", "light");
  } else if (settings.theme === "dark") {
    root.setAttribute("data-theme", "dark");
  } else {
    // custom -- explicit variables override the dark baseline
    root.setAttribute("data-theme", "dark");
    root.style.setProperty("--bg", settings.custom_bg);
    root.style.setProperty("--surface", settings.custom_surface);
    root.style.setProperty("--text", settings.custom_text);
  }
  if (settings.theme !== "custom") {
    root.style.removeProperty("--bg");
    root.style.removeProperty("--surface");
    root.style.removeProperty("--text");
  }
  root.style.setProperty("--accent", settings.accent);
  root.style.setProperty("--font-scale", settings.font_scale ?? 1);
  root.classList.toggle("reduce-motion", !!settings.reduce_motion);
  applyGlass(settings);
  window.__kesselSettings = settings;
  window.dispatchEvent(new CustomEvent("kessel-settings", { detail: settings }));
}

let cached = null;

export async function initTheme() {
  try {
    cached = await invoke("get_settings");
    applyTheme(cached);
  } catch (e) {
    // Fall back to CSS defaults (dark) if the backend isn't ready yet.
  }
  listen("settings-changed", (event) => {
    cached = event.payload;
    applyTheme(cached);
  });
  return cached;
}

export function currentSettings() {
  return cached;
}

export async function saveSettings(patch) {
  const next = { ...(cached || {}), ...patch };
  await invoke("update_settings", { settings: next });
  cached = next;
  applyTheme(next);
  return next;
}
