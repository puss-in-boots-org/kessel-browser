import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { resolveInput, hostOf } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;

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

function tile(label, url, onClick) {
  const el = document.createElement("div");
  el.className = "tile";
  el.innerHTML = `<span class="tile-icon">${faviconLetter(url)}</span><span class="tile-label"></span>`;
  el.querySelector(".tile-label").textContent = label;
  el.addEventListener("click", onClick ?? (() => go(url)));
  return el;
}

async function renderPinned() {
  const pinned = await invoke("get_pinned");
  const el = document.getElementById("pinned-grid");
  el.innerHTML = "";
  for (const p of pinned) el.appendChild(tile(p.title || hostOf(p.url), p.url));
  const add = document.createElement("div");
  add.className = "tile add-tile";
  add.innerHTML = `<span class="tile-icon">${icon("plus", 15)}</span><span class="tile-label">Pin a site</span>`;
  add.addEventListener("click", () => document.getElementById("omnibox").focus());
  el.appendChild(add);
}

async function renderBookmarks() {
  const bookmarks = await invoke("get_bookmarks");
  const el = document.getElementById("bookmarks-grid");
  el.innerHTML = bookmarks.length ? "" : `<div class="empty">No bookmarks yet — click the star in the toolbar on any page.</div>`;
  for (const b of bookmarks) el.appendChild(tile(b.title || b.url, b.url));
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  document.getElementById("logo-mark").innerHTML = icon("logo", 17);
  document.getElementById("omnibox-icon").innerHTML = icon("search", 16);

  tick();
  setInterval(tick, 15000);

  document.getElementById("omnibox").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const raw = e.target.value.trim();
    if (!raw) return;
    go(resolveInput(raw, currentSettings()?.search_engine || "google"));
  });

  await Promise.all([renderPinned(), renderBookmarks()]);
});
