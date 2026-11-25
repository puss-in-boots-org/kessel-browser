// Applies the persisted appearance settings -- the UI style and everything
// you changed about it (shared/styles.js) -- to <html>, and keeps every open
// page (toolbar, new tab, settings, passwords are each a separate
// webview/document) in sync live via the "settings-changed" event the
// backend broadcasts on every save.

import { applyGlass, WALLPAPERS } from "./glass.js";
import { applyStyle, applyCachedLook, backdropCss, backdropTone, setRiceAccent, resolveStyle, setWallpaperSwatches } from "./styles.js";
import { swatchesFromCss, swatchesFromPixels } from "./wallpaper-theme.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Last load's look, straight away -- the settings are still on their way.
applyCachedLook();
// Which page this is, popups included, for Instrument's per-page rules
// (instrument.css): its file's name (menu.html -> "menu"). (data-page, which only
// full pages have, stays as it is: styles.css tells pages from popups by it.)
document.documentElement.dataset.kPage = location.pathname.split("/").pop().replace(/\.html$/, "") || "index";

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

// --- Colours from the wallpaper ------------------------------------------------------
// styles.js lays a palette made from the wallpaper's colours over the style;
// this works out those colours for whichever wallpaper the look follows:
// one of Kessel's (from its CSS, at once), your own image or the Windows
// desktop wallpaper (sampled from the picture, then remembered here so the
// next page doesn't sample it again). The desktop's is checked every 5 s
// while it's in use, so changing it on the desktop recolours Kessel.

const SWATCH_CACHE = "kessel.wallpaper.swatches";
let wallKey = null;
const DESKTOP_ID = "kessel.wallpaper.desktop";
// The desktop wallpaper seen last (its path and date), so a page opening
// paints its colours straight away instead of after the first check.
let desktopId = (() => {
  try {
    return localStorage.getItem(DESKTOP_ID);
  } catch {
    return null;
  }
})();
let desktopTimer = 0;
let desktopChecked = false;

function readSwatchCache() {
  try {
    return JSON.parse(localStorage.getItem(SWATCH_CACHE)) || {};
  } catch {
    return {};
  }
}

function rememberSwatches(key, swatches) {
  const cache = readSwatchCache();
  delete cache[key];
  cache[key] = swatches;
  // A handful is plenty: the newest few wallpapers.
  const keys = Object.keys(cache);
  for (const old of keys.slice(0, Math.max(0, keys.length - 8))) delete cache[old];
  try {
    localStorage.setItem(SWATCH_CACHE, JSON.stringify(cache));
  } catch {}
}

// The colours in a picture (a URL or data URL), from a small copy of it.
export function imageSwatches(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 96;
        canvas.height = 60;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 96, 60);
        resolve(swatchesFromPixels(ctx.getImageData(0, 0, 96, 60).data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// The Windows desktop wallpaper: {id, url} (url only when it changed since
// `known`), or null when there's none Kessel can read. With several
// monitors it's one monitor's picture (setup.rs picks which); one spanned
// across all of them is cut down to that monitor's part here.
export async function desktopWallpaper(known = null) {
  const got = await invoke("desktop_wallpaper", { known }).catch(() => null);
  if (!got?.id) return null;
  let url = got.data ? `data:${got.mime || "image/jpeg"};base64,${got.data}` : null;
  if (url && Array.isArray(got.crop) && got.crop.length === 4) url = (await cropImage(url, got.crop)) || url;
  return { id: got.id, url };
}

// The [x, y, w, h] part (fractions of the picture) of an image, as a JPEG
// data URL at most 2560 px wide; null if it can't be read.
export function cropImage(src, [x, y, w, h]) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const sx = x * img.naturalWidth;
        const sy = y * img.naturalHeight;
        const sw = Math.max(1, w * img.naturalWidth);
        const sh = Math.max(1, h * img.naturalHeight);
        const scale = Math.min(1, 2560 / sw);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(sw * scale);
        canvas.height = Math.round(sh * scale);
        canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function customStamp() {
  try {
    const data = localStorage.getItem("kessel.wallpaper.custom") || "";
    return data ? `${data.length}:${data.slice(-24)}` : null;
  } catch {
    return null;
  }
}

function watchDesktop(on) {
  if (!on) {
    clearInterval(desktopTimer);
    desktopTimer = 0;
    return;
  }
  if (desktopTimer) return;
  const check = async () => {
    // Only pages on screen keep checking.
    if (desktopChecked && document.hidden) return;
    // The picture itself only when no Kessel page has its colours yet: the
    // file can be megabytes, and every page asks.
    const known = readSwatchCache()[`desktop:${desktopId}`] ? desktopId : null;
    const got = await desktopWallpaper(known);
    desktopChecked = true;
    const id = got?.id || null;
    if (id === desktopId && (!got?.url || readSwatchCache()[`desktop:${id}`])) return;
    desktopId = id;
    try {
      if (id) localStorage.setItem(DESKTOP_ID, id);
      else localStorage.removeItem(DESKTOP_ID);
    } catch {}
    const key = `desktop:${id}`;
    if (id && !readSwatchCache()[key] && got.url) {
      const swatches = await imageSwatches(got.url);
      if (swatches?.length) rememberSwatches(key, swatches);
    }
    wallKey = null;
    if (cached) applyTheme(cached);
  };
  check();
  desktopTimer = setInterval(check, 5000);
}

// Points styles.js at the right wallpaper's colours before the look is
// built. Returns nothing; a picture still being sampled repaints when done.
function syncWallpaper(settings) {
  const v = resolveStyle(settings).values;
  if (!v.wallTheme && v.mode !== "wallpaper") {
    watchDesktop(false);
    return;
  }
  const want = v.wallSource === "desktop" && v.wallTheme ? "desktop" : v.wallpaper || "nightfall";
  watchDesktop(want === "desktop");
  const key = want === "desktop" ? `desktop:${desktopId}` : want === "custom" ? `custom:${customStamp()}` : want;
  if (key === wallKey) return;
  if (want === "desktop" && !readSwatchCache()[key]) {
    // No desktop wallpaper (yet): the style's own colours until there is.
    wallKey = null;
    setWallpaperSwatches(null);
    return;
  }
  if (WALLPAPERS[want]) {
    wallKey = key;
    setWallpaperSwatches(swatchesFromCss(WALLPAPERS[want].css));
    return;
  }
  const known = readSwatchCache()[key];
  if (known) {
    wallKey = key;
    setWallpaperSwatches(known);
    return;
  }
  if (want === "custom") {
    let data = null;
    try {
      data = localStorage.getItem("kessel.wallpaper.custom");
    } catch {}
    if (!data) {
      setWallpaperSwatches(null);
      return;
    }
    wallKey = key;
    imageSwatches(data).then((swatches) => {
      if (!swatches?.length || wallKey !== key) return;
      rememberSwatches(key, swatches);
      setWallpaperSwatches(swatches);
      if (cached) applyTheme(cached);
    });
  }
}

function applyTheme(settings) {
  syncWallpaper(settings);
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
  // "Time of day" background: painted again as the sky changes.
  clearTimeout(skyTimer);
  if (r.values.background === "sky") skyTimer = setTimeout(() => applyTheme(window.__kesselSettings), 1800000 - (Date.now() % 1800000) + 500);
  window.dispatchEvent(new CustomEvent("kessel-settings", { detail: settings }));
}
let skyTimer = 0;

let cached = null;
// >0 while this page has style edits the backend hasn't confirmed yet: an
// older broadcast arriving meanwhile mustn't snap them back.
let holds = 0;
const STYLE_FIELDS = ["ui_style", "ui_custom", "ui_presets"];

// "Accent from the wallpaper": the rice hub rewrites ~/.config/rice/theme.json when
// the wallpaper changes; every Kessel page checks it every 3 s and repaints if the
// accent moved and the look follows it.
let riceSeen;
async function pullRice() {
  let accent = null;
  try {
    accent = JSON.parse((await invoke("rice_theme")) || "null")?.accent || null;
  } catch {}
  if (accent === riceSeen) return;
  riceSeen = accent;
  setRiceAccent(accent);
  if (cached && window.__kesselStyle?.values.accentFollow) applyTheme(cached);
}

export async function initTheme() {
  await pullRice();
  setInterval(pullRice, 3000);
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
  // Your own wallpaper changed on another page: its colours too.
  window.addEventListener("storage", (e) => {
    if (e.key === "kessel.wallpaper.custom" && cached) applyTheme(cached);
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
