// Tab search (tabsearch.html): every tab of every window -- sleeping ones
// too -- and the recently closed ones. Type to filter (every word must
// match the title or the address), Up/Down and Enter to go to one, the x to
// close it. window.__KESSEL_POPUP__ = { window, toolbar }: the window it was
// opened from.

import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";
import { escapeHtml, hostOf, formatBytes, closeOwnPopup } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const { emitTo } = window.__TAURI__.event;
const info = window.__KESSEL_POPUP__ || {};

let data = { windows: [], closed: [] };
let usage = {};
let rows = []; // what's listed, in order: { kind: "tab" | "closed", tab, window }
let focused = 0;
const thumbnails = new Map();

const close = () => closeOwnPopup();
const toolbarOf = (windowLabel) => `toolbar-${String(windowLabel).replace(/^win-/, "")}`;

function words(q) {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(tab, terms) {
  const hay = `${tab.title || ""} ${tab.url || ""}`.toLowerCase();
  return terms.every((w) => hay.includes(w));
}

// `text` with the typed words highlighted.
function highlight(text, terms) {
  let html = escapeHtml(text);
  for (const w of terms) {
    const re = new RegExp(escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

function favicon(tab) {
  if (tab.favicon) return `<img src="${escapeHtml(tab.favicon)}" alt="" onerror="this.remove()" />`;
  if (!tab.url || tab.url.startsWith("kessel://")) return icon("globe", 12);
  return escapeHtml(faviconLetter(tab.url));
}

function render() {
  const terms = words(document.getElementById("q").value);
  const list = document.getElementById("list");
  const current = data.windows.find((w) => w.current);
  const windows = data.windows.filter((w) => w.private === !!current?.private);
  rows = [];
  let html = "";
  let number = 1;
  for (const w of windows) {
    const found = (w.tabs || []).filter((t) => t.url && matches(t, terms));
    const label = w.current ? "This window" : `Window ${++number}`;
    if (!found.length) continue;
    html += `<div class="section">${label} · ${found.length}</div>`;
    const groups = new Map((w.groups || []).map((g) => [g.id, g]));
    for (const t of found) {
      const i = rows.push({ kind: "tab", tab: t, window: w }) - 1;
      const sleeping = t.discarded || t.id < 0;
      const group = t.group && groups.get(t.group);
      const memory = usage[String(t.id)]?.memory;
      const side = [
        t.audible && !t.muted ? icon("volume", 12) : "",
        t.muted ? icon("volumeOff", 12) : "",
        t.pinned ? icon("pin", 12) : "",
        sleeping ? `${icon("moon2", 12)}asleep` : memory ? formatBytes(memory) : "",
      ].join("");
      html += `<div class="row${t.active && w.current ? " current" : ""}${sleeping ? " sleeping" : ""}" data-i="${i}" role="option">
        <span class="fav">${favicon(t)}</span>
        <div class="main"><div class="title">${highlight(t.title || hostOf(t.url), terms)}</div>
        <div class="sub">${group ? `<span class="dot" style="background:${escapeHtml(groupColorOf(group))}"></span>${escapeHtml(group.name || "Group")} · ` : ""}${highlight(t.url.startsWith("kessel://") ? t.url : hostOf(t.url), terms)}</div></div>
        <span class="side">${side}</span>
        <span class="close" data-close="${i}" title="Close tab">${icon("close", 11)}</span>
      </div>`;
    }
  }
  const closed = (data.closed || []).filter((c) => matches(c, terms)).slice(0, 12);
  if (closed.length) {
    html += `<div class="section">Recently closed</div>`;
    for (const c of closed) {
      const i = rows.push({ kind: "closed", tab: c }) - 1;
      html += `<div class="row" data-i="${i}" role="option">
        <span class="fav">${favicon(c)}</span>
        <div class="main"><div class="title">${highlight(c.title || hostOf(c.url), terms)}</div><div class="sub">${highlight(hostOf(c.url), terms)}</div></div>
        <span class="side">${icon("history", 12)}</span>
      </div>`;
    }
  }
  list.innerHTML = html || `<div id="empty">${terms.length ? "No tab matches" : "No tabs"}</div>`;
  const openCount = windows.reduce((n, w) => n + (w.tabs || []).length, 0);
  document.getElementById("count").textContent = `${openCount} open`;
  focused = Math.min(focused, Math.max(0, rows.length - 1));
  markFocused();
}

const GROUP_COLORS = { grey: "#9aa0a6", blue: "#5b8def", red: "#ef5b5b", yellow: "#f2c14e", green: "#4fbf7f", pink: "#f06ab0", purple: "#a878f0", cyan: "#3fc5d4", orange: "#f59a42" };
function groupColorOf(group) {
  return GROUP_COLORS[group.color] || GROUP_COLORS.grey;
}

function markFocused() {
  document.querySelectorAll(".row").forEach((r) => r.classList.toggle("focused", Number(r.dataset.i) === focused));
  const el = document.querySelector(`.row[data-i="${focused}"]`);
  el?.scrollIntoView({ block: "nearest" });
  showPreview(rows[focused]);
}

// A picture of the tab you're on in the list (taken when it was last left).
let previewFor = null;
async function showPreview(row) {
  const pane = document.getElementById("preview");
  const tab = row?.kind === "tab" ? row.tab : null;
  previewFor = tab?.id ?? null;
  if (!tab || !(tab.id > 0) || tab.discarded || currentSettings()?.hover_card_preview === false) {
    pane.classList.remove("on");
    return;
  }
  let picture = thumbnails.get(tab.id);
  if (picture === undefined) {
    picture = await invoke("tab_thumbnail", { id: tab.id, fresh: false }).catch(() => null);
    thumbnails.set(tab.id, picture);
  }
  if (previewFor !== tab.id) return;
  if (picture) {
    const img = new Image();
    img.alt = "";
    img.src = picture;
    pane.replaceChildren(img);
    pane.classList.add("on");
  } else {
    pane.classList.remove("on");
  }
}

async function open(row) {
  if (!row) return;
  if (row.kind === "closed") {
    await invoke("reopen_closed_tab_url", { url: row.tab.url }).catch(() => {});
  } else {
    await emitTo(toolbarOf(row.window.label), "tab-search-activate", { id: row.tab.id }).catch(() => {});
    if (!row.window.current) await invoke("focus_window", { label: row.window.label }).catch(() => {});
  }
  close();
}

async function closeRow(i) {
  const row = rows[i];
  if (row?.kind !== "tab") return;
  await emitTo(toolbarOf(row.window.label), "tab-search-close", { id: row.tab.id }).catch(() => {});
  row.window.tabs = row.window.tabs.filter((t) => t !== row.tab);
  render();
  document.getElementById("q").focus();
}

async function load() {
  data = await invoke("tab_search_list").catch(() => ({ windows: [], closed: [] }));
  render();
  const live = data.windows.flatMap((w) => w.tabs || []).filter((t) => t.id > 0 && !t.discarded).map((t) => t.id);
  if (live.length) {
    usage = (await invoke("tab_resources", { ids: live }).catch(() => ({}))) || {};
    render();
  }
}

function wire() {
  const q = document.getElementById("q");
  q.addEventListener("input", () => {
    focused = 0;
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      focused = Math.min(rows.length - 1, focused + 1);
      markFocused();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focused = Math.max(0, focused - 1);
      markFocused();
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(rows[focused]);
    }
  });
  document.getElementById("list").addEventListener("click", (e) => {
    const x = e.target.closest("[data-close]");
    if (x) {
      e.stopPropagation();
      closeRow(Number(x.dataset.close));
      return;
    }
    const row = e.target.closest(".row");
    if (row) open(rows[Number(row.dataset.i)]);
  });
  document.getElementById("list").addEventListener("mousemove", (e) => {
    const row = e.target.closest(".row");
    if (row && Number(row.dataset.i) !== focused) {
      focused = Number(row.dataset.i);
      markFocused();
    }
  });
  window.addEventListener("blur", () => setTimeout(() => !document.hasFocus() && close(), 150));
}

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("search-icon").innerHTML = icon("search", 15);
  wire();
  document.getElementById("q").focus();
  await initTheme();
  watchCustomWallpaper(currentSettings);
  await load();
});
