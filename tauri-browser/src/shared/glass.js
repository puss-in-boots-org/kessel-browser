// Liquid Glass: the iOS-26-style translucent look for the toolbar chrome and
// the new-tab page (styles live in shared/glass.css, scoped to html.glass so
// turning it off falls straight back to the original solid theme).
//
// Glass needs something colorful behind it to refract. Tab content is a
// separate native webview that CSS backdrop-filter can't see into, so both
// the toolbar and the new-tab page paint the same wallpaper, and the new-tab
// page offsets its copy by the chrome insets so the two line up seamlessly
// into one continuous background (like Opera GX's Speed Dial).
//
// Everything here is plain frontend state shared across webviews through
// localStorage (every Kessel page is the same origin):
//   kessel.chrome            {left, top, w, h} -- toolbar geometry, written
//                            by main.js, read by the new-tab page
//   kessel.wallpaper.custom  the user's own wallpaper as a downscaled JPEG
//                            data URL (kept out of settings.json on purpose)
//   kessel.icons             host -> which icon source worked last time

export const WALLPAPERS = {
  nightfall: {
    name: "Nightfall",
    css: `radial-gradient(60% 45% at 18% 78%, rgba(255, 170, 70, 0.55), transparent 70%),
      radial-gradient(45% 40% at 82% 22%, rgba(120, 150, 255, 0.55), transparent 70%),
      radial-gradient(70% 55% at 55% 105%, rgba(20, 140, 170, 0.75), transparent 70%),
      radial-gradient(40% 30% at 40% 30%, rgba(170, 110, 255, 0.35), transparent 70%),
      linear-gradient(180deg, #0a1433 0%, #15306b 42%, #1d4b80 68%, #0a1a33 100%)`,
  },
  aurora: {
    name: "Aurora",
    css: `radial-gradient(55% 40% at 25% 30%, rgba(40, 230, 170, 0.6), transparent 70%),
      radial-gradient(50% 45% at 75% 45%, rgba(150, 90, 255, 0.6), transparent 70%),
      radial-gradient(60% 40% at 50% 100%, rgba(30, 110, 255, 0.55), transparent 70%),
      linear-gradient(160deg, #04121f 0%, #0b2a3a 50%, #140f33 100%)`,
  },
  sunset: {
    name: "Sunset",
    css: `radial-gradient(55% 45% at 30% 75%, rgba(255, 120, 60, 0.75), transparent 70%),
      radial-gradient(50% 40% at 78% 30%, rgba(255, 70, 140, 0.6), transparent 70%),
      radial-gradient(60% 50% at 50% 0%, rgba(120, 60, 200, 0.6), transparent 70%),
      linear-gradient(180deg, #2a1245 0%, #6a2a5e 50%, #f08a5d 100%)`,
  },
  daylight: {
    name: "Daylight",
    css: `radial-gradient(50% 45% at 20% 25%, rgba(255, 255, 255, 0.9), transparent 70%),
      radial-gradient(55% 45% at 80% 70%, rgba(120, 200, 255, 0.8), transparent 70%),
      radial-gradient(45% 40% at 60% 20%, rgba(255, 190, 220, 0.7), transparent 70%),
      linear-gradient(160deg, #cfe6ff 0%, #9cc8f5 50%, #d8d2ff 100%)`,
  },
  graphite: {
    name: "Graphite",
    css: `radial-gradient(50% 45% at 25% 25%, rgba(255, 255, 255, 0.14), transparent 70%),
      radial-gradient(55% 45% at 80% 80%, rgba(120, 130, 160, 0.3), transparent 70%),
      linear-gradient(160deg, #1b1d24 0%, #0d0e12 100%)`,
  },
};

const CUSTOM_KEY = "kessel.wallpaper.custom";
const TONE_KEY = "kessel.wallpaper.custom.tone";
const CHROME_KEY = "kessel.chrome";
const ICON_CACHE_KEY = "kessel.icons";

// Glass text color follows what's *behind* the glass, not the light/dark
// theme -- dark text on a light theme over a dark photo was unreadable.
// "dark" tone = dark backdrop, so white text; "light" = dark text.
const PRESET_TONES = { daylight: "light" };

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    shareSoon(key);
    return true;
  } catch {
    return false; // quota exceeded / storage unavailable
  }
}

// --- Account tabs ---------------------------------------------------------------
// A Kessel page inside an account's tab (see src-tauri/src/accounts.rs) runs
// in that account's own data folder, with its own -- empty -- localStorage.
// So Main's pages hand the wallpaper and toolbar geometry to Rust whenever
// they change, and pages in an account's tab copy them from there on load.

const SHARED_KEYS = [CUSTOM_KEY, TONE_KEY, CHROME_KEY];
const ipc = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args) ?? Promise.reject(new Error("no IPC"));
const changedKeys = new Set();
let shareTimer = null;

function shareSoon(key) {
  if (!SHARED_KEYS.includes(key)) return;
  changedKeys.add(key);
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => {
    sharePageStorage([...changedKeys]);
    changedKeys.clear();
  }, 300);
}

// Called with no keys by the toolbar on startup, to share everything once.
export function sharePageStorage(keys = SHARED_KEYS) {
  const values = Object.fromEntries(keys.map((k) => [k, readStorage(k)]));
  return ipc("share_page_storage", { values }).catch(() => {});
}

async function adoptSharedStorage() {
  const shared = await ipc("shared_page_storage").catch(() => null);
  if (!shared) return; // a Main page: nothing to copy
  for (const [key, value] of Object.entries(shared)) {
    if (!SHARED_KEYS.includes(key) || readStorage(key) === value) continue;
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      continue;
    }
    // This page's own listeners (alignToChrome, watchCustomWallpaper).
    window.dispatchEvent(new StorageEvent("storage", { key }));
  }
  if (lastSettings) applyGlass(lastSettings);
}
adoptSharedStorage();

// --- Settings -> <html> -------------------------------------------------------

let lastSettings = null;

export function applyGlass(settings) {
  lastSettings = settings;
  const root = document.documentElement;
  const enabled = settings?.glass_enabled ?? true;
  root.classList.toggle("glass", enabled);
  root.classList.toggle("glass-refract", enabled && (settings?.glass_refraction ?? true));
  root.style.setProperty("--lg-blur", `${settings?.glass_blur ?? 14}px`);
  // The toolbar sits over the wallpaper's top/left edges, the new-tab page
  // (html[data-glass-role="page"]) over its middle -- each can differ.
  const role = root.dataset.glassRole === "page" ? "page" : "chrome";
  root.dataset.glassTone = wallpaperTone(settings)[role];
  paintWallpapers(settings);
}

function wallpaperTone(settings) {
  const id = settings?.wallpaper || "nightfall";
  if (id === "custom" && readStorage(CUSTOM_KEY)) {
    try {
      const tone = JSON.parse(readStorage(TONE_KEY));
      if (tone?.chrome && tone?.page) return tone;
    } catch {}
    // Chosen before tone detection existed (or storage was cleared) --
    // measure it once in the background, then re-apply.
    analyzeStoredWallpaper();
    return { chrome: "dark", page: "dark" };
  }
  const tone = PRESET_TONES[id] || "dark";
  return { chrome: tone, page: tone };
}

// Relative luminance (WCAG) of a canvas region. Above ~0.25 dark text reads
// better than white; the bias toward white keeps the classic glass look on
// mid-tone images.
function regionLuminance(ctx, x, y, w, h) {
  const px = ctx.getImageData(x, y, w, h).data;
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    sum += 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
  }
  return sum / (px.length / 4);
}

const toneOf = (luminance) => (luminance > 0.25 ? "light" : "dark");

// Samples a 64x40 thumbnail: the top band (64x6) + left strip below it
// (4x34) is what the toolbar's glass sits over -- averaged by area -- and
// the centre is what's behind the new-tab page.
function measureTone(source) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 40;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, 64, 40);
  const top = regionLuminance(ctx, 0, 0, 64, 6);
  const left = regionLuminance(ctx, 0, 6, 4, 34);
  return {
    chrome: toneOf((top * 384 + left * 136) / 520),
    page: toneOf(regionLuminance(ctx, 12, 8, 40, 26)),
  };
}

let analyzing = false;
function analyzeStoredWallpaper() {
  if (analyzing) return;
  analyzing = true;
  const img = new Image();
  img.onload = () => {
    try {
      writeStorage(TONE_KEY, JSON.stringify(measureTone(img)));
      applyGlass(lastSettings);
    } catch {
      // unreadable pixels -- keep the white-text default
    }
    analyzing = false;
  };
  img.onerror = () => (analyzing = false);
  img.src = readStorage(CUSTOM_KEY);
}

// --- Wallpaper ----------------------------------------------------------------

export function wallpaperCss(settings) {
  const id = settings?.wallpaper || "nightfall";
  if (id === "custom") {
    const custom = readStorage(CUSTOM_KEY);
    if (custom) return `url("${custom}") center / cover no-repeat, #0a1433`;
  }
  return (WALLPAPERS[id] || WALLPAPERS.nightfall).css;
}

// Every element with [data-wallpaper] gets the current wallpaper. On the
// new-tab page it's additionally sized/offset to the whole window so it
// lines up with the toolbar's copy (see alignToChrome).
function paintWallpapers(settings) {
  const css = wallpaperCss(settings);
  document.querySelectorAll("[data-wallpaper]").forEach((el) => {
    el.style.background = css;
    if (css.startsWith("url(")) el.style.backgroundSize = "cover";
  });
}

export function readChromeGeometry() {
  try {
    return JSON.parse(readStorage(CHROME_KEY)) || null;
  } catch {
    return null;
  }
}

export function writeChromeGeometry(geometry) {
  writeStorage(CHROME_KEY, JSON.stringify(geometry));
}

// Positions a fixed wallpaper layer inside a content webview as if it were
// drawn across the full window: shifted up/left by the chrome insets and
// sized to the full window, so it continues exactly where the toolbar's
// copy leaves off.
export function alignToChrome(el) {
  const apply = () => {
    const g = readChromeGeometry();
    const left = g?.left ?? 60;
    const top = g?.top ?? 118;
    el.style.left = `${-left}px`;
    el.style.top = `${-top}px`;
    el.style.width = `${window.innerWidth + left}px`;
    el.style.height = `${window.innerHeight + top}px`;
  };
  apply();
  window.addEventListener("resize", apply);
  window.addEventListener("storage", (e) => {
    if (e.key === CHROME_KEY) apply();
  });
}

// Re-apply when another page changes the custom wallpaper image or its
// measured tone.
export function watchCustomWallpaper(getSettings) {
  window.addEventListener("storage", (e) => {
    if (e.key === CUSTOM_KEY || e.key === TONE_KEY) applyGlass(getSettings());
  });
}

export function hasCustomWallpaper() {
  return !!readStorage(CUSTOM_KEY);
}

// Downscales the picked image (max 2560px wide, JPEG) before storing it --
// a raw 4K PNG would blow straight through localStorage's quota.
export async function setCustomWallpaper(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file isn't an image Kessel can read"));
      i.src = url;
    });
    const scale = Math.min(1, 2560 / img.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    // Tone first, so pages repainting on the image change already see it.
    writeStorage(TONE_KEY, JSON.stringify(measureTone(canvas)));
    for (const quality of [0.86, 0.72, 0.58]) {
      if (writeStorage(CUSTOM_KEY, canvas.toDataURL("image/jpeg", quality))) return;
    }
    writeStorage(TONE_KEY, null);
    throw new Error("Image is too large to store -- try a smaller one");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function clearCustomWallpaper() {
  writeStorage(CUSTOM_KEY, null);
  writeStorage(TONE_KEY, null);
}

// --- Refraction filter ----------------------------------------------------------
// An SVG displacement map used through `backdrop-filter: url(#lg-refract)`
// (Chromium/WebView2 only -- exactly what Kessel runs on). Red encodes the
// horizontal push, green the vertical one; both are strongest at the edges
// and fade to neutral grey in the middle, so content behind a glass shape
// bends inward at its rim like light through a thick lens while the centre
// stays undistorted. objectBoundingBox units make the one filter scale to
// every element size.

const DISPLACEMENT_MAP =
  "data:image/svg+xml," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">
  <defs>
    <linearGradient id="x" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#000"/></linearGradient>
    <linearGradient id="y" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0f0"/><stop offset="1" stop-color="#000"/></linearGradient>
    <filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>
  </defs>
  <rect width="100" height="100" fill="url(#x)"/>
  <rect width="100" height="100" fill="url(#y)" style="mix-blend-mode:screen"/>
  <rect x="14" y="14" width="72" height="72" rx="24" fill="rgb(128,128,0)" filter="url(#b)"/>
</svg>`);

export function injectRefractionFilter() {
  if (document.getElementById("lg-filters")) return;
  const holder = document.createElement("div");
  holder.innerHTML = `<svg id="lg-filters" width="0" height="0" style="position:absolute;width:0;height:0" aria-hidden="true">
    <filter id="lg-refract" x="0" y="0" width="1" height="1" primitiveUnits="objectBoundingBox" color-interpolation-filters="sRGB">
      <feImage href="${DISPLACEMENT_MAP}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map"/>
      <feDisplacementMap in="SourceGraphic" in2="map" scale="0.09" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </svg>`;
  document.body.appendChild(holder.firstElementChild);
}

// --- iOS-style site icons -------------------------------------------------------
// Tries the site's own apple-touch-icon first (literally the icon iOS puts
// on the home screen, usually 180px), then its favicon, then falls back to
// a colored letter tile. Whichever source works is remembered per host so
// later renders don't re-request ones that 404.

let iconCache = null;
function loadIconCache() {
  if (iconCache) return iconCache;
  try {
    iconCache = JSON.parse(readStorage(ICON_CACHE_KEY)) || {};
  } catch {
    iconCache = {};
  }
  return iconCache;
}
function rememberIcon(host, source) {
  const cache = loadIconCache();
  if (cache[host] === source) return;
  cache[host] = source;
  writeStorage(ICON_CACHE_KEY, JSON.stringify(cache));
}

// Called when a tab reports a page's real <link rel="icon">. Many big sites
// (Discord, Instagram...) don't serve /apple-touch-icon.png at their root or
// block hot-linking it, so this is often the only icon that works -- once
// you've visited a site, its rail/bookmark/speed-dial icon upgrades from the
// letter tile to the real one.
export function rememberSiteFavicon(pageUrl, faviconUrl) {
  const site = hostAndOrigin(pageUrl);
  if (!site || !faviconUrl) return;
  const cached = loadIconCache()[site.host];
  if (cached === "touch") return; // already have the big one
  rememberIcon(site.host, `url:${faviconUrl}`);
}

function hostAndOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { host: u.hostname.replace(/^www\./, ""), origin: u.origin };
  } catch {
    return null;
  }
}

function hueOf(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function letterTile(el, label) {
  const hue = hueOf(label || "?");
  el.classList.add("letter");
  el.style.setProperty("--icon-hue", hue);
  el.textContent = (label || "?").trim()[0]?.toUpperCase() || "?";
}

// Returns a <span class="app-icon"> squircle. `knownFavicon` (e.g. a tab's
// reported favicon) is tried before guessing well-known paths.
export function siteIcon(url, { label, knownFavicon } = {}) {
  const el = document.createElement("span");
  el.className = "app-icon";
  const site = hostAndOrigin(url);
  const fallbackLabel = label || site?.host || url;
  if (!site) {
    letterTile(el, fallbackLabel);
    return el;
  }

  const cached = loadIconCache()[site.host];
  if (cached?.startsWith("url:") && !knownFavicon) knownFavicon = cached.slice(4);

  const sources = [];
  if (knownFavicon) sources.push(["known", knownFavicon]);
  sources.push(["touch", `${site.origin}/apple-touch-icon.png`]);
  sources.push(["favicon", `${site.origin}/favicon.ico`]);

  if (cached === "letter" && !knownFavicon) {
    letterTile(el, site.host);
    return el;
  }
  if (cached && !cached.startsWith("url:")) {
    const idx = sources.findIndex(([kind]) => kind === cached);
    if (idx > 0) sources.unshift(...sources.splice(idx, 1));
  }

  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  // The icon's container is what drags (e.g. a rail pin tearing off into a
  // pop-out) -- never the image's own native URL drag.
  img.draggable = false;
  let i = 0;
  img.onload = () => {
    // Big square art (touch icons) fills the squircle edge to edge like an
    // iOS app icon; small favicons sit centered on a light glass plate.
    el.classList.toggle("small", img.naturalWidth < 96);
    el.classList.add("loaded");
    if (sources[i][0] !== "known") rememberIcon(site.host, sources[i][0]);
  };
  img.onerror = () => {
    i++;
    if (i < sources.length) {
      img.src = sources[i][1];
    } else {
      img.remove();
      if (!knownFavicon) rememberIcon(site.host, "letter");
      letterTile(el, site.host);
    }
  };
  img.src = sources[0][1];
  el.appendChild(img);
  return el;
}
