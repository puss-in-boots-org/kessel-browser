// kessel://history (Ctrl+H): every page you've visited, searchable, by day
// or by site, plus the searches you've made and what you closed recently.
// Visits live in history.sqlite (see src-tauri/src/history.rs).

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { toast, hostOf, debounce, confirmDialog, escapeHtml, formatRelativeTime } from "./shared/api.js";
import { siteIcon } from "./shared/glass.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const PAGE = 150;

const VIEWS = [
  { id: "all", label: "All history", icon: "history" },
  { id: "sites", label: "By site", icon: "globe" },
  { id: "searches", label: "Searches", icon: "search" },
  { id: "closed", label: "Recently closed", icon: "window" },
];

const state = {
  view: "all",
  text: "",
  range: "any",
  day: "", // yyyy-mm-dd from the date picker
  site: "",
  offset: 0,
  done: false,
  loading: false,
  generation: 0, // bumps on every new query, so late answers are dropped
  visits: [], // the "all" view's loaded rows, in order
  selected: new Set(),
  lastClicked: null,
  lastDay: "",
  // This page's own deletes also announce "history-changed"; those don't
  // need a reload (the rows are already gone).
  quietUntil: 0,
};

const $ = (id) => document.getElementById(id);

// --- Time ---------------------------------------------------------------------

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// Midnight `n` days ago (calendar days, so a daylight-saving change in
// between doesn't shift it by an hour).
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return Math.floor(d.getTime() / 1000);
}

// [from, to) in unix seconds for the chosen range (undefined = open).
function rangeBounds() {
  if (state.day) {
    const [y, m, d] = state.day.split("-").map(Number);
    return { from: startOfDay(new Date(y, m - 1, d)), to: startOfDay(new Date(y, m - 1, d + 1)) };
  }
  switch (state.range) {
    case "today": return { from: daysAgo(0) };
    case "yesterday": return { from: daysAgo(1), to: daysAgo(0) };
    case "week": return { from: daysAgo(6) };
    case "month": return { from: daysAgo(29) };
    default: return {};
  }
}

function dayLabel(unix) {
  const date = new Date(unix * 1000);
  const long = date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const day = startOfDay(date);
  if (day === daysAgo(0)) return `Today – ${long}`;
  if (day === daysAgo(1)) return `Yesterday – ${long}`;
  return long;
}

function timeLabel(unix) {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --- Views --------------------------------------------------------------------

function setView(view) {
  state.view = view;
  for (const item of document.querySelectorAll(".nav-item")) item.classList.toggle("active", item.dataset.view === view);
  $("ranges").style.display = view === "closed" || view === "sites" ? "none" : "";
  $("q").placeholder = view === "sites" ? "Search sites" : view === "searches" ? "Search your searches" : view === "closed" ? "Search recently closed" : "Search history";
  clearSelection();
  reload();
}

function reload() {
  state.generation++;
  state.loading = false;
  state.offset = 0;
  state.done = false;
  state.visits = [];
  state.lastDay = "";
  state.selected.clear();
  updateSelectionBar();
  $("list").replaceChildren();
  $("site-bar").hidden = !(state.view === "all" && state.site);
  if (state.site) $("site-bar-text").textContent = `Visits to ${state.site}`;
  switch (state.view) {
    case "all": return loadMoreVisits();
    case "sites": return loadSites();
    case "searches": return loadSearches();
    case "closed": return loadClosed();
  }
}

function emptyState(text, iconName = "history") {
  const el = document.createElement("div");
  el.className = "empty-state";
  el.innerHTML = `${icon(iconName, 34)}<div></div>`;
  el.querySelector("div").textContent = text;
  return el;
}

// --- All history --------------------------------------------------------------

async function loadMoreVisits() {
  if (state.loading || state.done) return;
  state.loading = true;
  const generation = state.generation;
  $("more").hidden = false;
  const { from, to } = rangeBounds();
  let visits = [];
  try {
    visits = await invoke("query_history", { text: state.text, from, to, site: state.site || null, limit: PAGE, offset: state.offset });
  } catch (err) {
    toast(String(err));
  }
  if (generation !== state.generation) return;
  state.loading = false;
  state.offset += visits.length;
  state.done = visits.length < PAGE;
  $("more").hidden = true;
  const list = $("list");
  if (!state.visits.length && !visits.length) {
    list.appendChild(emptyState(state.text || state.site || state.range !== "any" || state.day ? "No visits match." : "Pages you visit will show up here."));
    return;
  }
  for (const v of visits) {
    const day = new Date(v.visited_at * 1000).toDateString();
    if (day !== state.lastDay) {
      state.lastDay = day;
      const header = document.createElement("div");
      header.className = "day";
      header.textContent = dayLabel(v.visited_at);
      list.appendChild(header);
    }
    state.visits.push(v);
    list.appendChild(visitRow(v));
  }
  // Short page: keep going until it scrolls (or there's nothing more).
  requestAnimationFrame(maybeLoadMore);
}

function visitRow(v) {
  const row = document.createElement("div");
  row.className = "visit";
  row.dataset.id = v.id;
  const title = v.title || v.url;
  row.innerHTML = `
    <input type="checkbox" aria-label="Select" />
    <span class="time">${escapeHtml(timeLabel(v.visited_at))}</span>
    <span class="icon-holder"></span>
    <a class="title"></a>
    <span class="host"></span>
    <button class="btn ghost icon-only sm row-btn" title="More actions">${icon("dotsV", 15)}</button>`;
  row.querySelector(".icon-holder").replaceWith(siteIcon(v.url, { label: v.host || title, guess: false }));
  const link = row.querySelector(".title");
  link.textContent = title;
  link.href = v.url;
  link.title = `${title}\n${v.url}`;
  const host = row.querySelector(".host");
  host.textContent = v.host || hostOf(v.url);
  host.title = `More from ${host.textContent}`;
  host.style.cursor = "pointer";
  host.addEventListener("click", () => showSite(v.host || hostOf(v.url)));

  const box = row.querySelector("input");
  box.checked = state.selected.has(v.id);
  row.classList.toggle("selected", box.checked);
  box.addEventListener("click", (e) => toggleSelected(v, box.checked, e.shiftKey));
  row.querySelector(".row-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, visitMenu(v));
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMenu({ x: e.clientX, y: e.clientY }, visitMenu(v));
  });
  return row;
}

function visitMenu(v) {
  const site = v.host || hostOf(v.url);
  return [
    ["Open in new tab", "plus", () => invoke("open_url", { url: v.url, how: "tab" })],
    ["Open in new window", "window", () => invoke("open_url", { url: v.url, how: "window" })],
    ["Open in private window", "incognito", () => invoke("open_url", { url: v.url, how: "private-window" })],
    ["Copy link", "copy", () => copy(v.url)],
    null,
    [`More from ${site}`, "globe", () => showSite(site)],
    ["Remove from history", "trash", () => deleteVisits([v.id]), "danger"],
  ];
}

function showSite(site) {
  state.site = site;
  if (state.view !== "all") setView("all");
  else reload();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied");
  } catch {
    toast("Couldn't copy -- clipboard unavailable");
  }
}

// --- Selection & deleting -----------------------------------------------------

function toggleSelected(v, on, range) {
  if (range && state.lastClicked != null) {
    const a = state.visits.findIndex((x) => x.id === state.lastClicked);
    const b = state.visits.findIndex((x) => x.id === v.id);
    if (a >= 0 && b >= 0) {
      for (const x of state.visits.slice(Math.min(a, b), Math.max(a, b) + 1)) {
        if (on) state.selected.add(x.id);
        else state.selected.delete(x.id);
      }
    }
  } else if (on) {
    state.selected.add(v.id);
  } else {
    state.selected.delete(v.id);
  }
  state.lastClicked = v.id;
  syncSelectionUi();
}

function syncSelectionUi() {
  for (const row of document.querySelectorAll(".visit[data-id]")) {
    const on = state.selected.has(Number(row.dataset.id));
    row.classList.toggle("selected", on);
    const box = row.querySelector("input[type=checkbox]");
    if (box) box.checked = on;
  }
  updateSelectionBar();
}

function updateSelectionBar() {
  const n = state.selected.size;
  $("selection-bar").hidden = n === 0;
  document.body.classList.toggle("selecting", n > 0);
  $("selection-count").textContent = `${n} selected`;
}

function clearSelection() {
  state.selected.clear();
  state.lastClicked = null;
  syncSelectionUi();
}

async function deleteVisits(ids, { ask = false } = {}) {
  if (!ids.length) return;
  if (ask && !(await confirmDialog(`Remove ${ids.length} ${ids.length === 1 ? "page" : "pages"} from your history?`, "Remove"))) return;
  try {
    state.quietUntil = Date.now() + 1500;
    await invoke("delete_history", { ids });
  } catch (err) {
    toast(String(err));
    return;
  }
  const gone = new Set(ids);
  state.visits = state.visits.filter((v) => !gone.has(v.id));
  for (const id of ids) {
    state.selected.delete(id);
    document.querySelector(`.visit[data-id="${id}"]`)?.remove();
  }
  // Day headers left with no visits under them.
  for (const header of [...document.querySelectorAll(".day")]) {
    const next = header.nextElementSibling;
    if (!next || next.classList.contains("day")) header.remove();
  }
  state.offset = Math.max(0, state.offset - ids.length);
  updateSelectionBar();
  toast(ids.length === 1 ? "Removed from history" : `Removed ${ids.length} pages from history`);
  if (!state.visits.length && state.view === "all") reload();
}

// --- By site ------------------------------------------------------------------

async function loadSites() {
  const generation = state.generation;
  $("more").hidden = false;
  const sites = await invoke("history_sites", { text: state.text, limit: 500 }).catch(() => []);
  if (generation !== state.generation) return;
  $("more").hidden = true;
  const list = $("list");
  if (!sites.length) {
    list.appendChild(emptyState(state.text ? "No sites match." : "Sites you visit will show up here.", "globe"));
    return;
  }
  for (const s of sites) {
    const row = document.createElement("div");
    row.className = "visit";
    row.innerHTML = `
      <span class="icon-holder"></span>
      <a class="title"></a>
      <span class="host"></span>
      <span class="count"></span>
      <button class="btn ghost icon-only sm row-btn" title="More actions">${icon("dotsV", 15)}</button>`;
    row.querySelector(".icon-holder").replaceWith(siteIcon(s.url, { label: s.host, guess: false }));
    const link = row.querySelector(".title");
    link.textContent = s.host;
    link.href = "#";
    link.title = `Show your visits to ${s.host}`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showSite(s.host);
    });
    row.querySelector(".host").textContent = `last visit ${formatRelativeTime(s.last_visit)}`;
    row.querySelector(".count").textContent = `${s.visits} ${s.visits === 1 ? "visit" : "visits"}`;
    const menu = () => [
      ["Show visits", "history", () => showSite(s.host)],
      ["Open site in new tab", "plus", () => invoke("open_url", { url: `https://${s.host}/`, how: "tab" })],
      null,
      ["Delete all from this site", "trash", () => deleteSite(s.host), "danger"],
    ];
    row.querySelector(".row-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, menu());
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY }, menu());
    });
    list.appendChild(row);
  }
}

async function deleteSite(site) {
  if (!(await confirmDialog(`Remove every visit to ${site} from your history?`, "Remove"))) return;
  try {
    state.quietUntil = Date.now() + 1500;
    const n = await invoke("delete_history", { site });
    toast(`Removed ${n} ${n === 1 ? "visit" : "visits"}`);
  } catch (err) {
    toast(String(err));
    return;
  }
  if (state.site === site) state.site = "";
  reload();
}

// --- Searches -----------------------------------------------------------------
// The searches you made, read back from the result pages you visited.

const SEARCH_PAGES = [
  { name: "Google", host: /(^|\.)google\.[a-z.]+$/, path: /^\/search/, param: "q" },
  { name: "Bing", host: /(^|\.)bing\.com$/, path: /^\/search/, param: "q" },
  { name: "DuckDuckGo", host: /(^|\.)duckduckgo\.com$/, path: /^\/$/, param: "q" },
  { name: "Brave", host: /^search\.brave\.com$/, path: /^\/search/, param: "q" },
  { name: "Ecosia", host: /(^|\.)ecosia\.org$/, path: /^\/search/, param: "q" },
  { name: "Startpage", host: /(^|\.)startpage\.com$/, path: /search/, param: "query" },
  { name: "Yahoo", host: /(^|\.)search\.yahoo\.com$/, path: /^\/search/, param: "p" },
  { name: "Yandex", host: /(^|\.)yandex\.[a-z.]+$/, path: /^\/search/, param: "text" },
  { name: "YouTube", host: /(^|\.)youtube\.com$/, path: /^\/results/, param: "search_query" },
  { name: "Wikipedia", host: /(^|\.)wikipedia\.org$/, path: /^\/w\/index\.php/, param: "search" },
  { name: "Amazon", host: /(^|\.)amazon\.[a-z.]+$/, path: /^\/s$/, param: "k" },
  { name: "GitHub", host: /^github\.com$/, path: /^\/search/, param: "q" },
  { name: "Reddit", host: /(^|\.)reddit\.com$/, path: /^\/search/, param: "q" },
];

export function searchOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const page of SEARCH_PAGES) {
    if (page.host.test(u.hostname) && page.path.test(u.pathname)) {
      const term = (u.searchParams.get(page.param) || "").trim();
      return term ? { engine: page.name, term } : null;
    }
  }
  return null;
}

async function loadSearches() {
  const generation = state.generation;
  $("more").hidden = false;
  const { from, to } = rangeBounds();
  const visits = await invoke("query_history", { text: "", from, to, limit: 5000, offset: 0 }).catch(() => []);
  if (generation !== state.generation) return;
  $("more").hidden = true;
  const needle = state.text.toLowerCase();
  const byTerm = new Map();
  for (const v of visits) {
    const s = searchOf(v.url);
    if (!s || (needle && !s.term.toLowerCase().includes(needle))) continue;
    const key = `${s.engine}\n${s.term.toLowerCase()}`;
    const entry = byTerm.get(key);
    if (entry) {
      entry.count++;
      entry.ids.push(v.id);
    } else {
      byTerm.set(key, { ...s, url: v.url, last: v.visited_at, count: 1, ids: [v.id] });
    }
  }
  const list = $("list");
  if (!byTerm.size) {
    list.appendChild(emptyState(needle ? "No searches match." : "Searches you make will show up here.", "search"));
    return;
  }
  for (const s of byTerm.values()) {
    const row = document.createElement("div");
    row.className = "visit";
    row.innerHTML = `
      <span class="time">${escapeHtml(timeLabel(s.last))}</span>
      <span style="color:var(--text-faint);display:flex">${icon("search", 15)}</span>
      <a class="title"></a>
      <span class="host"></span>
      <span class="count"></span>
      <button class="btn ghost icon-only sm row-btn" title="Remove">${icon("trash", 14)}</button>`;
    const link = row.querySelector(".title");
    link.textContent = s.term;
    link.href = s.url;
    link.title = `Search ${s.engine} for "${s.term}" again`;
    row.querySelector(".host").textContent = `${s.engine} · ${formatRelativeTime(s.last)}`;
    row.querySelector(".count").textContent = s.count > 1 ? `${s.count}×` : "";
    row.querySelector(".row-btn").title = "Remove this search from history";
    row.querySelector(".row-btn").addEventListener("click", async () => {
      try {
        state.quietUntil = Date.now() + 1500;
        await invoke("delete_history", { ids: s.ids });
        row.remove();
        toast("Search removed from history");
      } catch (err) {
        toast(String(err));
      }
    });
    list.appendChild(row);
  }
}

// --- Recently closed ------------------------------------------------------------

async function loadClosed() {
  const generation = state.generation;
  const closed = await invoke("get_recently_closed").catch(() => ({ tabs: [], windows: [] }));
  if (generation !== state.generation) return;
  const needle = state.text.toLowerCase();
  const matches = (...texts) => !needle || texts.some((t) => (t || "").toLowerCase().includes(needle));
  const list = $("list");
  const windows = closed.windows.filter((w) => matches(...w.titles));
  const tabs = closed.tabs.filter((t) => matches(t.title, t.url));
  if (!windows.length && !tabs.length) {
    list.appendChild(emptyState(needle ? "Nothing matches." : "Tabs and windows you close will show up here.", "window"));
    return;
  }
  if (windows.length) {
    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = "Windows";
    list.appendChild(title);
    for (const w of windows) {
      const row = document.createElement("div");
      row.className = "visit";
      row.innerHTML = `
        <span class="time"></span>
        <span style="color:var(--text-faint);display:flex">${icon("window", 16)}</span>
        <span class="title"></span>
        <span class="host"></span>
        <button class="btn sm row-btn always">Reopen</button>`;
      row.querySelector(".time").textContent = w.closed_at ? timeLabel(w.closed_at) : "";
      row.querySelector(".title").textContent = `${w.tabs} ${w.tabs === 1 ? "tab" : "tabs"}`;
      row.querySelector(".host").textContent = w.titles.join(", ");
      row.querySelector("button").addEventListener("click", async () => {
        await invoke("reopen_closed_window", { index: w.index }).catch((err) => toast(String(err)));
        reload();
      });
      list.appendChild(row);
    }
  }
  if (tabs.length) {
    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = "Tabs";
    list.appendChild(title);
    for (const t of tabs) {
      const row = document.createElement("div");
      row.className = "visit";
      row.innerHTML = `
        <span class="time"></span>
        <span class="icon-holder"></span>
        <span class="title"></span>
        <span class="host"></span>
        <button class="btn sm row-btn always">Reopen</button>`;
      row.querySelector(".time").textContent = t.closed_at ? timeLabel(t.closed_at) : "";
      row.querySelector(".icon-holder").replaceWith(siteIcon(t.url, { label: t.title || hostOf(t.url), guess: false }));
      row.querySelector(".title").textContent = t.title || t.url;
      row.querySelector(".host").textContent = hostOf(t.url);
      row.querySelector("button").addEventListener("click", async () => {
        await invoke("reopen_closed_tab_url", { url: t.url }).catch((err) => toast(String(err)));
        reload();
      });
      list.appendChild(row);
    }
  }
}

// --- Row menu -------------------------------------------------------------------

let openMenuEl = null;

function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}

// `at` is the button it drops from, or a point {x, y}. Items are
// [label, icon, action, className?] or null (a separator).
function openMenu(at, items) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (!item) {
      menu.appendChild(document.createElement("hr"));
      continue;
    }
    const [label, iconName, action, cls] = item;
    const button = document.createElement("button");
    button.setAttribute("role", "menuitem");
    if (cls) button.className = cls;
    button.innerHTML = `${icon(iconName, 15)}<span></span>`;
    button.querySelector("span").textContent = label;
    button.addEventListener("click", () => {
      closeMenu();
      Promise.resolve(action()).catch((err) => toast(String(err)));
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let x = at instanceof Element ? rect.right - w : rect.left;
  let y = rect.bottom + 4;
  if (y + h > innerHeight - 8) y = Math.max(8, rect.top - h - 4);
  x = Math.min(Math.max(8, x), innerWidth - w - 8);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  openMenuEl = menu;
  menu.querySelector("button")?.focus();
  menu.addEventListener("keydown", (e) => {
    const buttons = [...menu.querySelectorAll("button")];
    const at = buttons.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  });
}

// --- Infinite scroll --------------------------------------------------------------

function maybeLoadMore() {
  if (state.view !== "all" || state.done || state.loading) return;
  const scroller = $("scroller");
  if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 600) loadMoreVisits();
}

// --- Start ------------------------------------------------------------------------

function applyRange(range) {
  state.range = range;
  state.day = "";
  $("day-picker").value = "";
  for (const chip of document.querySelectorAll("#ranges .chip")) chip.classList.toggle("active", chip.dataset.range === range);
  reload();
}

function keepNote() {
  const days = currentSettings()?.history_days ?? 90;
  const note = $("keep-note");
  note.innerHTML = days
    ? `Kessel keeps ${days} days of history. <a id="keep-link">Change</a>`
    : `Kessel keeps your history until you delete it. <a id="keep-link">Change</a>`;
  note.querySelector("#keep-link").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://settings/privacy" }));
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  $("search-icon").outerHTML = icon("search", 16);
  for (const item of document.querySelectorAll(".nav-item")) {
    const view = VIEWS.find((v) => v.id === item.dataset.view);
    item.innerHTML = `${icon(view.icon, 15)}<span>${escapeHtml(view.label)}</span>`;
    item.addEventListener("click", () => {
      if (view.id === "all") state.site = "";
      setView(view.id);
    });
  }
  keepNote();
  window.addEventListener("kessel-settings", keepNote);

  const params = new URLSearchParams(location.search);
  state.text = params.get("q") || "";
  state.site = params.get("site") || "";
  $("q").value = state.text;

  $("q").addEventListener(
    "input",
    debounce(() => {
      state.text = $("q").value.trim();
      const url = new URL(location.href);
      if (state.text) url.searchParams.set("q", state.text);
      else url.searchParams.delete("q");
      history.replaceState(null, "", url);
      reload();
    }, 180),
  );
  for (const chip of document.querySelectorAll("#ranges .chip")) chip.addEventListener("click", () => applyRange(chip.dataset.range));
  $("day-picker").addEventListener("change", () => {
    state.day = $("day-picker").value;
    for (const chip of document.querySelectorAll("#ranges .chip")) chip.classList.toggle("active", !state.day && chip.dataset.range === state.range);
    reload();
  });

  $("select-all-btn").addEventListener("click", () => {
    for (const v of state.visits) state.selected.add(v.id);
    syncSelectionUi();
  });
  $("cancel-selection-btn").addEventListener("click", clearSelection);
  $("delete-selected-btn").addEventListener("click", () => deleteVisits([...state.selected], { ask: true }));
  $("clear-site-btn").addEventListener("click", () => {
    state.site = "";
    reload();
  });
  $("delete-site-btn").addEventListener("click", () => deleteSite(state.site));
  $("clear-data-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://settings/clear" }));

  $("scroller").addEventListener("scroll", maybeLoadMore, { passive: true });
  window.addEventListener("resize", maybeLoadMore);
  document.addEventListener("click", (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
  });
  window.addEventListener("blur", closeMenu);

  document.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLInputElement && e.target.type !== "checkbox";
    if ((e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") || (e.key === "/" && !typing)) {
      e.preventDefault();
      $("q").focus();
      $("q").select();
    } else if (e.key === "Escape") {
      if (openMenuEl) closeMenu();
      else if (state.selected.size) clearSelection();
      else if (typing && $("q").value) {
        $("q").value = "";
        $("q").dispatchEvent(new Event("input"));
      } else return;
      e.preventDefault();
    } else if (e.key === "Delete" && !typing && state.selected.size) {
      e.preventDefault();
      deleteVisits([...state.selected], { ask: true });
    }
  });

  // Coming back to this tab after browsing: show what's new.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && $("scroller").scrollTop < 200 && !state.selected.size) reload();
  });
  listen("history-changed", () => {
    if (Date.now() > state.quietUntil && !state.selected.size) reload();
  });

  setView(state.view);
  $("q").focus();
});
