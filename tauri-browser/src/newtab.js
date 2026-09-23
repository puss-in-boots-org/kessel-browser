import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { resolveInput, hostOf } from "./shared/api.js";
import { siteIcon, alignToChrome, injectRefractionFilter, watchCustomWallpaper } from "./shared/glass.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function go(url) {
  window.location.href = url;
}

function tick() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  document.getElementById("clock").textContent = `${h}:${m}`;
  document.getElementById("date").textContent = now.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });
}

function tile(label, url) {
  const el = document.createElement("div");
  el.className = "tile";
  el.title = url;
  const text = document.createElement("span");
  text.className = "tile-label";
  text.textContent = label;
  el.append(siteIcon(url, { label }), text);
  el.addEventListener("click", () => go(url));
  return el;
}

function renderPinned(pinned) {
  const el = document.getElementById("pinned-grid");
  el.innerHTML = "";
  for (const p of pinned) el.appendChild(tile(p.title || hostOf(p.url), p.url));
  const add = document.createElement("div");
  add.className = "tile";
  add.innerHTML = `<span class="add-glyph">${icon("plus", 22)}</span><span class="tile-label">Pin a site</span>`;
  add.addEventListener("click", () => document.getElementById("omnibox").focus());
  el.appendChild(add);
}

function renderBookmarks(bookmarks) {
  const el = document.getElementById("bookmarks-grid");
  el.innerHTML = bookmarks.length ? "" : `<div class="empty">No bookmarks yet — click the star in the toolbar on any page.</div>`;
  for (const b of bookmarks) el.appendChild(tile(b.title || hostOf(b.url), b.url));
}

window.addEventListener("DOMContentLoaded", async () => {
  alignToChrome(document.getElementById("wallpaper"));
  await initTheme();
  injectRefractionFilter();
  watchCustomWallpaper(currentSettings);
  document.getElementById("omnibox-icon").innerHTML = icon("search", 18);

  tick();
  setInterval(tick, 15000);

  document.getElementById("omnibox").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const raw = e.target.value.trim();
    if (!raw) return;
    go(resolveInput(raw, currentSettings()?.search_engine || "google"));
  });

  const [pinned, bookmarks] = await Promise.all([invoke("get_pinned"), invoke("get_bookmarks")]);
  renderPinned(pinned);
  renderBookmarks(bookmarks);
  listen("pinned-changed", (event) => renderPinned(event.payload));
  listen("bookmarks-changed", (event) => renderBookmarks(event.payload));
});
