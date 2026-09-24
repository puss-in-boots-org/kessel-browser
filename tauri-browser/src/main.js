// Toolbar webview: renders the left icon rail (Opera-GX style) and the top
// tab-strip/nav-bar chrome. Talks to Rust exclusively through invoke() --
// it never touches a content webview directly. Rail icons open a slide-out
// side panel (a real webview Rust positions beside the active tab) rather
// than a new tab -- see toggleSidePanel below and side_panel commands in
// src-tauri/src/main.rs.
import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { ENGINES, resolveInput, toast, hostOf } from "./shared/api.js";
import { siteIcon, injectRefractionFilter, writeChromeGeometry, watchCustomWallpaper, rememberSiteFavicon } from "./shared/glass.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

// Tells Rust's toolbar watchdog this page is alive. If this renderer
// process dies (crash, or killed in Task Manager) the heartbeats stop and
// Rust reloads the toolbar -- see restoreAfterToolbarReload. Started before
// anything else so a slow init can't be mistaken for a dead toolbar.
invoke("toolbar_heartbeat").catch(() => {});
setInterval(() => invoke("toolbar_heartbeat").catch(() => {}), 1000);

// --- Tab state -----------------------------------------------------------
// Each tab maps to a real native webview created by Rust. This module only
// tracks id/url/title/loading for the tab-strip UI and forwards actions.

// { id, url, title, loading, discarded, neverCreated, lastActiveAt }
// `discarded` tabs have no live webview backing them right now -- either
// they were idle and got their webview destroyed to free memory (see
// wireTabDiscarding), or (neverCreated: true) they're a restored-session
// tab that was never actually opened yet, since eagerly recreating every
// webview from your last session on launch is exactly the kind of memory
// waste this whole thing is meant to avoid.
let tabs = [];
let activeTabId = null;
let bookmarks = [];
let pinned = [];
let blockedCount = 0;
let activeDownloads = 0;
let openPanelKind = null; // e.g. "pinned:<id>" / "downloads" / "passwords" / "settings", or null

const INTERNAL_TITLES = { "kessel://settings": "Settings", "kessel://passwords": "Passwords", "kessel://downloads": "Downloads" };

// Real tab ids come from Rust as positive u32s -- negative numbers can
// never collide with one, so they're a safe local-only key for a tab that
// doesn't have (or no longer has) a real webview behind it.
let placeholderCounter = 0;
function nextPlaceholderId() {
  return --placeholderCounter;
}

function findTab(id) {
  return tabs.find((t) => t.id === id);
}

// Inserts as the first child rather than replacing innerHTML -- rail-shield
// and rail-downloads already contain a badge <span> in the static HTML, and
// clobbering it here would break the badge lookups later during init.
function iconFor(id, svg) {
  const el = document.getElementById(id);
  if (el) el.insertAdjacentHTML("afterbegin", svg);
}

function paintStaticIcons() {
  iconFor("rail-add-pin", icon("plus", 15));
  iconFor("rail-shield", icon("shield", 18));
  iconFor("rail-downloads", icon("download", 18));
  iconFor("rail-passwords", icon("key", 18));
  iconFor("rail-settings", icon("settings", 18));
  iconFor("back-btn", icon("back", 18));
  iconFor("forward-btn", icon("forward", 18));
  iconFor("reload-btn", icon("reload", 17));
  iconFor("new-tab-btn", icon("plus", 16));
  iconFor("lock-icon", icon("lock", 13));
  iconFor("engine-btn", icon("chevronDown", 13));
  iconFor("star-btn", icon("star", 16));
  iconFor("shields-btn", icon("shieldCheck", 16));
  iconFor("win-min", icon("winMin", 14));
  iconFor("win-max", icon("winMax", 13));
  iconFor("win-close", icon("close", 14));
}

// --- Frameless window: title-bar dragging + window controls -------------------

function wireWindowControls() {
  document.getElementById("win-min").addEventListener("click", () => appWindow.minimize());
  document.getElementById("win-max").addEventListener("click", () => appWindow.toggleMaximize());
  document.getElementById("win-close").addEventListener("click", () => appWindow.close());

  // Only the bar's own empty space drags -- never a tab, button or input.
  const isDragSurface = (target) => target.id === "tab-bar" || target.id === "drag-space" || target.id === "tabs";
  const tabBar = document.getElementById("tab-bar");
  tabBar.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !isDragSurface(e.target)) return;
    if (e.detail === 2) {
      appWindow.toggleMaximize();
      return;
    }
    appWindow.startDragging();
  });

  const syncMaxIcon = async () => {
    const maximized = await appWindow.isMaximized().catch(() => false);
    const btn = document.getElementById("win-max");
    btn.innerHTML = icon(maximized ? "winRestore" : "winMax", 13);
    btn.title = maximized ? "Restore" : "Maximize";
  };
  syncMaxIcon();
  appWindow.onResized(syncMaxIcon);
}

// --- Chrome geometry -> Rust ----------------------------------------------------
// Content webviews are placed by Rust at (left, top). Rather than a
// hardcoded constant that has to match this CSS by hand, measure the real
// rendered rail width / top-chrome height and report it whenever it changes
// (first paint, bookmarks bar toggled, interface size, glass on/off). Also
// shared with the new-tab page so its wallpaper lines up with ours.

let reportedInsets = { left: -1, top: -1 };

function reportChromeInsets() {
  const left = Math.ceil(document.getElementById("rail").getBoundingClientRect().right);
  const bm = document.getElementById("bookmarks-bar");
  const lastChrome = bm.hidden ? document.getElementById("nav-bar") : bm;
  const top = Math.ceil(lastChrome.getBoundingClientRect().bottom);
  writeChromeGeometry({ left, top, w: window.innerWidth, h: window.innerHeight });
  if (left === reportedInsets.left && top === reportedInsets.top) return Promise.resolve();
  reportedInsets = { left, top };
  return invoke("set_chrome_insets", { left, top }).catch(() => {});
}

function wireChromeInsets() {
  const observer = new ResizeObserver(() => reportChromeInsets());
  for (const id of ["rail", "tab-bar", "nav-bar", "bookmarks-bar"]) {
    observer.observe(document.getElementById(id));
  }
  window.addEventListener("resize", reportChromeInsets);
  return reportChromeInsets();
}

// --- Tab strip rendering ---------------------------------------------------

// Every tab-strip change goes through renderTabs, so that's where the
// toolbar hands Rust a copy of its state -- the one thing a reloaded
// toolbar can't ask the tabs themselves (sleeping tabs have no webview).
let snapshotTimer = null;
function pushToolbarSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    const snapshot = {
      tabs: tabs.map(({ id, url, title, favicon, discarded, neverCreated, userTitled }) => ({ id, url, title, favicon, discarded, neverCreated, userTitled })),
      activeTabId,
      placeholderCounter,
    };
    invoke("set_toolbar_snapshot", { snapshot: JSON.stringify(snapshot) }).catch(() => {});
  }, 250);
}

// Rebuilds the tab strip after Rust had to reload a dead toolbar: live tabs
// come from Rust (current url + last reported title/favicon), sleeping ones
// and the strip's order from our own last snapshot. Tabs closed in the
// meantime drop out; tabs opened meanwhile (e.g. a middle-clicked link,
// whose "tab-created" event had nobody listening) get appended. Returns
// false on a normal startup, where Rust has no tabs yet.
async function restoreAfterToolbarReload() {
  const live = await invoke("get_open_tabs").catch(() => null);
  if (!live || !live.tabs.length) return false;
  let snapshot = null;
  try {
    snapshot = JSON.parse((await invoke("get_toolbar_snapshot")) || "null");
  } catch {}

  const liveById = new Map(live.tabs.map((t) => [t.id, t]));
  const now = Date.now();
  const restored = [];
  for (const saved of snapshot?.tabs || []) {
    if (saved.discarded) {
      restored.push({ ...saved, loading: false, lastActiveAt: now });
      continue;
    }
    const tab = liveById.get(saved.id);
    if (!tab) continue; // closed while the toolbar was down
    liveById.delete(saved.id);
    restored.push({ ...saved, url: tab.url, title: tab.title || saved.title, favicon: tab.favicon ?? saved.favicon, loading: false, lastActiveAt: now });
  }
  for (const tab of liveById.values()) {
    const title = tab.title || INTERNAL_TITLES[tab.url] || hostOf(tab.url);
    restored.push({ id: tab.id, url: tab.url, title, favicon: tab.favicon, userTitled: !!tab.title, loading: false, lastActiveAt: now });
  }

  tabs = restored;
  activeTabId = live.active ?? restored.find((t) => !t.discarded)?.id ?? null;
  placeholderCounter = Math.min(snapshot?.placeholderCounter ?? 0, ...restored.map((t) => t.id), 0);
  openPanelKind = live.panel ?? null;
  renderTabs();
  updateAddressBarForActiveTab();
  updatePanelHighlights();
  invoke("set_tab_order", { ids: tabs.map((t) => t.id) }).catch(() => {});
  return true;
}

function renderTabs() {
  pushToolbarSnapshot();
  const container = document.getElementById("tabs");
  container.innerHTML = "";
  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "tab" +
      (tab.id === activeTabId ? " active" : "") +
      (tab.justCreated ? " tab-enter" : "") +
      (tab.discarded ? " discarded" : "");
    tab.justCreated = false;
    if (tab.discarded) el.title = "Sleeping to save memory -- click to reload";
    el.dataset.tabId = String(tab.id);
    el.draggable = true;

    const fav = document.createElement("span");
    fav.className = "tab-favicon" + (tab.loading ? " loading" : "");
    fav.innerHTML = tab.loading ? icon("reload", 11) : faviconGlyph(tab);

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || (tab.url ? hostOf(tab.url) : "New Tab");

    const close = document.createElement("span");
    close.className = "close-tab";
    close.innerHTML = icon("close", 12);

    el.append(fav, title, close);

    el.addEventListener("click", (e) => {
      if (e.target.closest(".close-tab")) {
        e.stopPropagation();
        closeTab(tab.id);
      } else {
        activateTab(tab.id);
      }
    });
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab.id);
      }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showTabContextMenu(tab, e.clientX, e.clientY);
    });
    wireTabDrag(el, tab);

    container.appendChild(el);
  }
}

function faviconGlyph(tab) {
  if (tab.favicon) return `<img class="fav-img" data-tab-id="${tab.id}" src="${tab.favicon}" alt="" />`;
  if (!tab.url || tab.url.startsWith("kessel://")) return icon("globe", 11);
  return `<span>${faviconLetter(tab.url)}</span>`;
}

// A favicon URL that 404s or otherwise fails just falls back to the letter
// avatar on the next render, rather than showing a broken-image icon.
document.addEventListener(
  "error",
  (e) => {
    if (!(e.target instanceof HTMLImageElement) || !e.target.classList.contains("fav-img")) return;
    const tab = findTab(parseInt(e.target.dataset.tabId, 10));
    if (tab) {
      tab.favicon = null;
      renderTabs();
    }
  },
  true
);

// --- Drag-to-reorder tabs --------------------------------------------------
// Moves DOM nodes directly on dragover (rather than re-rendering, which
// would recreate the dragged element mid-drag and abort the drag session),
// then reconciles the `tabs` array order from the final DOM order once.

let draggedTabId = null;

function wireTabDrag(el, tab) {
  el.addEventListener("dragstart", (e) => {
    draggedTabId = tab.id;
    el.classList.add("dragging");
    // A private type only, so web pages under the cursor ignore the drag
    // instead of e.g. navigating to a dropped URL.
    e.dataTransfer.setData("application/x-kessel-tab", String(tab.id));
    e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (draggedTabId === null || draggedTabId === tab.id) return;
    const container = document.getElementById("tabs");
    const draggedEl = container.querySelector(`[data-tab-id="${draggedTabId}"]`);
    if (!draggedEl) return;
    const rect = el.getBoundingClientRect();
    const before = e.clientX - rect.left < rect.width / 2;
    container.insertBefore(draggedEl, before ? el : el.nextSibling);
  });
  el.addEventListener("dragend", (e) => {
    el.classList.remove("dragging");
    draggedTabId = null;
    const newOrderIds = Array.from(document.getElementById("tabs").children).map((c) => parseInt(c.dataset.tabId, 10));
    tabs.sort((a, b) => newOrderIds.indexOf(a.id) - newOrderIds.indexOf(b.id));
    invoke("set_tab_order", { ids: tabs.map((t) => t.id) }).catch(() => {});
    persistSession();
    // Dropped somewhere that isn't the tab strip -- below the toolbar (over
    // the page) or outside the window entirely: tear it off.
    if (e.dataTransfer.dropEffect === "none" && (e.clientY > reportedInsets.top || isOutsideWindow(e))) {
      tearOffTab(tab, e);
    }
  });
}

// --- Tear-off pop-out windows (see pop_out / dock_popout in main.rs) --------

function isOutsideWindow(e) {
  return e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
}

// Where the dragged thing was let go, in screen coordinates, nudged so the
// pop-out's title bar lands under the cursor. Falls back to a cascade near
// the main window if the drag didn't report a usable position.
function popOutPosition(e) {
  if (e.screenX || e.screenY) return { x: e.screenX - 90, y: e.screenY - 18 };
  return { x: window.screenX + 120, y: window.screenY + 120 };
}

async function tearOffTab(tab, e) {
  if (!tab.url) return;
  const title = tab.title && tab.title !== "New Tab" ? tab.title : "";
  try {
    await invoke("pop_out", { url: tab.url, title, ...popOutPosition(e) });
  } catch (err) {
    toast(`Couldn't pop out: ${err}`);
    return;
  }
  // Moved, not copied -- and not a "recently closed" tab either.
  await closeTab(tab.id, { remember: false });
}

async function popOutPinned(p, e) {
  await invoke("pop_out", { url: p.url, title: p.title || "", ...popOutPosition(e) }).catch((err) =>
    toast(`Couldn't pop out: ${err}`)
  );
}

// --- Per-tab right-click context menu --------------------------------------

function showTabContextMenu(tab, x, y) {
  document.querySelector(".tab-context-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu tab-context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.right = "auto";

  const items = [
    { label: "Duplicate tab", iconName: "copy", action: () => createTab(tab.url) },
    { label: "Close tab", iconName: "close", action: () => closeTab(tab.id) },
    {
      label: "Close other tabs",
      iconName: "x",
      // Sequential on purpose -- closeTab() mutates the shared `tabs`
      // array, and firing several concurrently only invites races.
      action: async () => {
        for (const other of tabs.filter((t) => t.id !== tab.id)) {
          await closeTab(other.id);
        }
      },
    },
  ];
  if (tab.url && !tab.url.startsWith("kessel://") && !pinned.some((p) => p.url === tab.url)) {
    items.push({ label: "Pin to rail", iconName: "pin", action: () => pinUrl(tab.url, tab.title !== "New Tab" ? tab.title : null) });
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "menu-item";
    row.innerHTML = `${icon(item.iconName, 14)}<span>${item.label}</span>`;
    row.addEventListener("click", () => {
      menu.remove();
      item.action();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("click", closeMenu, true);
    }
  };
  document.addEventListener("click", closeMenu, true);
}

function updateAddressBarForActiveTab() {
  const tab = findTab(activeTabId);
  const input = document.getElementById("url-input");
  if (document.activeElement !== input) {
    // Internal kessel:// pages show a blank omnibox, like a real browser's
    // new-tab/settings pages do -- there's nothing useful to type over.
    input.value = tab && tab.url && !tab.url.startsWith("kessel://") ? tab.url : "";
  }
  updateStarButton();
  updateNavButtons();
  updateShieldsButton();
}

// --- Shields button (address bar) -------------------------------------------
// Shows how much Shields blocked on the active tab's current page; clicking
// it opens the Shields popup (shields.html) for that tab. Counts arrive as
// "shields-stats" events from Rust (see shields.rs / main.rs).

const shieldsStats = new Map(); // tab id -> { blocked, https_upgrades, params_stripped, host }

function updateShieldsButton() {
  const btn = document.getElementById("shields-btn");
  const count = document.getElementById("shields-count");
  const tab = findTab(activeTabId);
  const webPage = !!(tab && tab.url && /^https?:/.test(tab.url));
  btn.hidden = !webPage;
  const on = currentSettings()?.adblock_enabled ?? true;
  const stats = shieldsStats.get(activeTabId);
  const blocked = stats?.blocked || 0;
  btn.classList.toggle("off", !on);
  count.hidden = !on || blocked === 0;
  count.textContent = blocked > 99 ? "99+" : String(blocked);
  btn.title = on ? `Shields: ${blocked} blocked on this page` : "Shields are off";
}

async function toggleShieldsPopup() {
  if (!activeTabId || activeTabId < 0) return;
  const rect = document.getElementById("shields-btn").getBoundingClientRect();
  await invoke("toggle_shields_popup", { id: activeTabId, x: rect.right + 6, y: rect.bottom }).catch(() => {});
}

function updateNavButtons() {
  // We don't track per-tab history state from Rust (webview doesn't expose
  // it), so back/forward stay enabled whenever a tab exists -- clicking
  // them is a no-op if there's nothing to go back/forward to.
  const hasTab = !!activeTabId;
  document.getElementById("back-btn").disabled = !hasTab;
  document.getElementById("forward-btn").disabled = !hasTab;
  document.getElementById("reload-btn").disabled = !hasTab;
}

async function activateTab(id) {
  const tab = findTab(id);
  if (!tab) return;
  // The Shields popup belongs to the tab it was opened for.
  invoke("close_shields_popup").catch(() => {});

  // Stamp the tab we're leaving as "went idle now" -- wireTabDiscarding
  // measures elapsed time from this, not from when it was created.
  const prev = findTab(activeTabId);
  if (prev && prev.id !== id) prev.lastActiveAt = Date.now();

  if (tab.discarded) {
    // No live webview behind this one (idle-discarded, or a restored
    // session tab that was never actually opened) -- (re)create it fresh.
    // It reloads from scratch: scroll position and any unsaved page state
    // from before it was discarded is gone, same trade every browser's
    // "memory saver" makes.
    const newId = await invoke("new_tab", { url: tab.url });
    tab.id = newId;
    tab.discarded = false;
    tab.neverCreated = false;
    tab.loading = false;
    // new_tab always appends to Rust's own tab-cycling order -- resync it
    // to match the toolbar's visual order so Ctrl+Tab / Ctrl+1..9 don't
    // drift from what's actually on screen.
    invoke("set_tab_order", { ids: tabs.map((t) => t.id) }).catch(() => {});
    activeTabId = newId;
  } else {
    activeTabId = id;
    await invoke("switch_tab", { id });
  }
  renderTabs();
  updateAddressBarForActiveTab();
  persistSession();
}

async function createTab(url) {
  const id = await invoke("new_tab", { url: url ?? null });
  // Resolve what Rust will actually open this tab to, so the omnibox/star/
  // pin logic below has an accurate url immediately -- don't wait on a
  // possibly-unreliable navigation event for internal kessel:// pages.
  const resolvedUrl = url ?? (currentSettings()?.homepage || "kessel://newtab");
  tabs.push({ id, url: resolvedUrl, title: "New Tab", justCreated: true, loading: false, lastActiveAt: Date.now() });
  activeTabId = id;
  renderTabs();
  updateAddressBarForActiveTab();
  persistSession();
  return id;
}

// Adds a tab entry with NO webview behind it yet -- used for session-restore
// tabs you aren't looking at right now. Costs nothing until you click it.
function addPlaceholderTab(url) {
  const id = nextPlaceholderId();
  tabs.push({
    id,
    url,
    title: INTERNAL_TITLES[url] || hostOf(url),
    discarded: true,
    neverCreated: true,
    loading: false,
    lastActiveAt: Date.now(),
  });
  return id;
}

async function closeTab(id, { remember = true } = {}) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (!tab.neverCreated) {
    // A discarded-but-previously-real tab's id is still a valid u32 Rust
    // once knew (close_tab just no-ops if it's already gone) -- only a
    // never-created placeholder's negative synthetic id can't be sent to a
    // u32-typed command at all.
    const closedUrl = tab.discarded || !remember ? null : tab.url;
    await invoke("close_tab", { id, url: closedUrl || null });
  }
  // Recompute the index at removal time by identity, not from a value
  // captured before the await above -- if another closeTab() call ran
  // concurrently (e.g. "close other tabs") and already spliced entries
  // out from under this one, a pre-await index would now point at the
  // wrong element.
  const idx = tabs.indexOf(tab);
  if (idx === -1) return; // something else already removed it
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    await createTab();
    return;
  }

  if (activeTabId === id) {
    const next = tabs[Math.max(0, idx - 1)];
    await activateTab(next.id);
  } else {
    renderTabs();
  }
  persistSession();
}

// --- Idle tab discarding (destroys a background tab's webview to free
// memory; reviving it in activateTab() above just reloads the page) -------

async function discardTab(tab) {
  try {
    await invoke("close_tab", { id: tab.id, url: null });
  } catch {
    // Already gone somehow -- fine, we're marking it discarded either way.
  }
  tab.discarded = true;
  tab.loading = false;
  renderTabs();
}

function wireTabDiscarding() {
  setInterval(() => {
    const minutes = currentSettings()?.discard_tabs_after_minutes ?? 0;
    if (!minutes) return; // 0 = disabled
    const cutoff = Date.now() - minutes * 60 * 1000;
    for (const tab of tabs) {
      if (tab.discarded || tab.id === activeTabId) continue;
      if (SINGLETON_ROUTES.has(tab.url)) continue; // never discard Settings/Passwords
      if ((tab.lastActiveAt ?? 0) < cutoff) discardTab(tab);
    }
  }, 60 * 1000);
}

// Settings and Passwords can still be reached as full tabs (e.g. typing
// kessel://settings into the omnibox) -- opening them again focuses the
// one already-open tab instead of spawning another full webview. The rail
// icons themselves go through the side panel instead (see below).
const SINGLETON_ROUTES = new Set(["kessel://settings", "kessel://passwords"]);

async function openSingleton(route) {
  await invoke("open_singleton_tab", { route });
  // No local state mutation here -- Rust emits "tab-focused" (existing tab)
  // or "tab-created" (new one) either way, and the listeners below handle both.
}

async function navigateActiveTab(rawInput) {
  const tab = findTab(activeTabId);
  if (!tab) return;
  const url = resolveInput(rawInput, currentSettings()?.search_engine || "google");
  if (!url) return;
  if (SINGLETON_ROUTES.has(url)) {
    await openSingleton(url);
    return;
  }
  if (url.startsWith("kessel://")) {
    // kessel://newtab and friends: always open as a new tab rather than
    // replacing the current one -- avoids guessing a platform-specific
    // app-scheme URL for an already-loaded external webview.
    await createTab(url);
    return;
  }
  await invoke("navigate", { id: tab.id, url });
}

function persistSession() {
  const settings = currentSettings();
  if (!settings || !settings.restore_tabs) return;
  // Settings/Passwords are excluded on purpose: restoring one as a plain
  // tab would bypass the singleton dedup the next time it's reopened.
  const urls = tabs
    .map((t) => t.url)
    .filter((u) => u && (u.startsWith("http") || u.startsWith("kessel://")) && !SINGLETON_ROUTES.has(u));
  invoke("save_session", { urls }).catch(() => {});
}

// --- Bookmarks --------------------------------------------------------

async function refreshBookmarks() {
  bookmarks = await invoke("get_bookmarks");
  updateStarButton();
  renderBookmarksBar();
}

// Opera-style bookmarks bar under the omnibox. Click opens in the current
// tab, middle-click (or Ctrl-click) in a new one.
function renderBookmarksBar() {
  const bar = document.getElementById("bookmarks-bar");
  bar.hidden = currentSettings()?.bookmarks_bar === false;
  bar.innerHTML = "";
  if (!bookmarks.length) {
    bar.innerHTML = `<span class="bm-empty">Bookmarks you star show up here</span>`;
    return;
  }
  for (const b of bookmarks) {
    const chip = document.createElement("div");
    chip.className = "bm-chip";
    chip.title = `${b.title}\n${b.url}`;
    const title = document.createElement("span");
    title.className = "bm-title";
    title.textContent = b.title || hostOf(b.url);
    chip.append(siteIcon(b.url, { label: b.title }), title);
    chip.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) createTab(b.url);
      else openInActiveTab(b.url);
    });
    chip.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        createTab(b.url);
      }
    });
    bar.appendChild(chip);
  }
}

async function openInActiveTab(url) {
  const tab = findTab(activeTabId);
  if (!tab || tab.discarded || url.startsWith("kessel://")) {
    await createTab(url);
    return;
  }
  await invoke("navigate", { id: tab.id, url });
}

function updateStarButton() {
  const tab = findTab(activeTabId);
  const btn = document.getElementById("star-btn");
  const isBookmarked = tab && bookmarks.some((b) => b.url === tab.url);
  btn.classList.toggle("starred", !!isBookmarked);
  btn.innerHTML = icon(isBookmarked ? "starFilled" : "star", 16);
}

async function toggleBookmark() {
  const tab = findTab(activeTabId);
  if (!tab || !tab.url || tab.url.startsWith("kessel://")) return;
  const existing = bookmarks.find((b) => b.url === tab.url);
  if (existing) {
    await invoke("remove_bookmark", { url: tab.url });
    toast("Removed bookmark");
  } else {
    await invoke("add_bookmark", { url: tab.url, title: tab.title || tab.url });
    toast("Bookmarked");
  }
  await refreshBookmarks();
}

// --- Pinned sites (rail icons) -----------------------------------------

async function refreshPinned() {
  pinned = await invoke("get_pinned").catch(() => []);
  renderPinned();
}

function renderPinned() {
  const list = document.getElementById("pinned-list");
  list.innerHTML = "";
  for (const p of pinned) {
    const kind = `pinned:${p.id}`;
    const el = document.createElement("div");
    el.className = "pin-item" + (openPanelKind === kind ? " panel-open" : "");
    el.title = p.title || p.url;
    el.dataset.kind = kind;
    // Drag a pin off the rail to open that site in its own floating window.
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-kessel-pin", p.id);
      e.dataTransfer.effectAllowed = "copy";
    });
    el.addEventListener("dragend", (e) => {
      const railRight = document.getElementById("rail").getBoundingClientRect().right;
      if (e.dataTransfer.dropEffect === "none" && (e.clientX > railRight + 16 || isOutsideWindow(e))) popOutPinned(p, e);
    });
    el.append(siteIcon(p.url, { label: p.title }));
    el.insertAdjacentHTML("beforeend", `<span class="pin-remove">${icon("close", 9)}</span>`);
    el.addEventListener("click", (e) => {
      if (e.target.closest(".pin-remove")) {
        e.stopPropagation();
        invoke("remove_pinned", { id: p.id });
        return;
      }
      toggleSidePanel(kind, p.url);
    });
    list.appendChild(el);
  }
}

async function pinUrl(url, title) {
  if (!url || url.startsWith("kessel://")) {
    toast("Nothing to pin on this page");
    return;
  }
  if (pinned.some((p) => p.url === url)) {
    toast("Already pinned");
    return;
  }
  await invoke("add_pinned", { url, title: title || hostOf(url) });
  toast("Pinned");
}

async function pinCurrentTab() {
  const tab = findTab(activeTabId);
  // A brand-new tab's title starts as the "New Tab" placeholder until the
  // real page title arrives asynchronously -- pinning right away (before
  // that update lands) would otherwise save "New Tab" as the pin's
  // permanent label. Falling back to the hostname when the title is still
  // that placeholder is what pinUrl already does when given no title.
  const title = tab && tab.title && tab.title !== "New Tab" ? tab.title : null;
  await pinUrl(tab?.url, title);
}

// --- Ad-block shield (a direct toggle, not a panel) ----------------------

function updateShield() {
  const settings = currentSettings();
  const enabled = settings ? settings.adblock_enabled : true;
  const btn = document.getElementById("rail-shield");
  btn.classList.toggle("active-shield", enabled);
  btn.classList.toggle("inactive-shield", !enabled);
  btn.innerHTML = icon(enabled ? "shieldCheck" : "shieldOff", 18) +
    `<span class="rail-badge" id="shield-badge" ${blockedCount > 0 ? "" : "hidden"}>${blockedCount > 99 ? "99+" : blockedCount}</span>`;
  btn.title = enabled ? `Ad & tracker blocking is on (${blockedCount} blocked this session)` : "Ad & tracker blocking is off";
}

async function toggleShield() {
  const settings = currentSettings();
  const next = !(settings ? settings.adblock_enabled : true);
  await saveSettings({ adblock_enabled: next });
  updateShield();
  toast(next ? "Ad blocking enabled (open tabs reload to apply)" : "Ad blocking disabled");
}

function updateDownloadsBadge() {
  const badge = document.getElementById("downloads-badge");
  badge.hidden = activeDownloads === 0;
  badge.textContent = activeDownloads;
}

// --- Side panel (Opera-GX-style slide-out) -------------------------------

async function toggleSidePanel(kind, url) {
  const nowOpen = await invoke("toggle_side_panel", { kind, url }).catch(() => null);
  if (nowOpen === null) return;
  openPanelKind = nowOpen ? kind : null;
  updatePanelHighlights();
}

function updatePanelHighlights() {
  document.getElementById("rail-downloads").classList.toggle("panel-open", openPanelKind === "downloads");
  document.getElementById("rail-passwords").classList.toggle("panel-open", openPanelKind === "passwords");
  document.getElementById("rail-settings").classList.toggle("panel-open", openPanelKind === "settings");
  renderPinned();
}

// --- Search engine menu ---------------------------------------------------

function renderEngineMenu() {
  const menu = document.getElementById("engine-menu");
  const current = currentSettings()?.search_engine || "google";
  menu.innerHTML = "";
  for (const [key, engine] of Object.entries(ENGINES)) {
    const item = document.createElement("div");
    item.className = "menu-item" + (key === current ? " selected" : "");
    item.innerHTML = `${icon(key === current ? "check" : "search", 14)}<span>${engine.name}</span>`;
    item.addEventListener("click", async () => {
      await saveSettings({ search_engine: key });
      menu.hidden = true;
      renderEngineMenu();
    });
    menu.appendChild(item);
  }
}


// --- Wire up UI --------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  injectRefractionFilter();
  watchCustomWallpaper(currentSettings);
  paintStaticIcons();
  wireWindowControls();
  renderEngineMenu();

  await refreshBookmarks();
  await refreshPinned();
  blockedCount = await invoke("get_blocked_count").catch(() => 0);
  updateShield();
  updateDownloadsBadge();

  // Before the first tab exists, so Rust places it below the real chrome.
  await wireChromeInsets();

  // Restore last session's tabs if enabled, else open the homepage. Only
  // the tab you're actually looking at gets a real webview -- the rest
  // come back as sleeping placeholders (see addPlaceholderTab) that only
  // cost a webview once you actually click them. Eagerly recreating every
  // tab from last time on every launch is exactly the kind of waste this
  // whole feature exists to avoid.
  const settings = currentSettings();
  // A reload after the toolbar's process died picks up the tabs that are
  // still running instead of opening a fresh one.
  let restored = await restoreAfterToolbarReload();
  if (!restored && settings?.restore_tabs) {
    const urls = await invoke("get_session").catch(() => []);
    if (urls && urls.length) {
      await createTab(urls[0]);
      for (let i = 1; i < urls.length; i++) addPlaceholderTab(urls[i]);
      renderTabs();
      restored = true;
    }
  }
  if (!restored) await createTab();

  wireTabDiscarding();

  document.getElementById("rail-home").addEventListener("click", () => createTab());
  document.getElementById("rail-add-pin").addEventListener("click", pinCurrentTab);
  document.getElementById("rail-shield").addEventListener("click", toggleShield);
  document.getElementById("rail-downloads").addEventListener("click", () => toggleSidePanel("downloads", "kessel://downloads"));
  document.getElementById("rail-passwords").addEventListener("click", () => toggleSidePanel("passwords", "kessel://passwords"));
  document.getElementById("rail-settings").addEventListener("click", () => toggleSidePanel("settings", "kessel://settings"));

  document.getElementById("new-tab-btn").addEventListener("click", () => createTab());
  document.getElementById("back-btn").addEventListener("click", () => {
    if (activeTabId) invoke("go_back", { id: activeTabId });
  });
  document.getElementById("forward-btn").addEventListener("click", () => {
    if (activeTabId) invoke("go_forward", { id: activeTabId });
  });
  document.getElementById("reload-btn").addEventListener("click", () => {
    if (activeTabId) invoke("reload", { id: activeTabId });
  });
  document.getElementById("star-btn").addEventListener("click", toggleBookmark);
  document.getElementById("shields-btn").addEventListener("click", toggleShieldsPopup);
  document.getElementById("engine-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = document.getElementById("engine-menu");
    menu.hidden = !menu.hidden;
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#engine-menu") && !e.target.closest("#engine-btn")) {
      document.getElementById("engine-menu").hidden = true;
    }
  });

  document.getElementById("url-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { navigateActiveTab(e.target.value); e.target.blur(); }
    else if (e.key === "Escape") { updateAddressBarForActiveTab(); e.target.blur(); }
  });
  document.getElementById("url-input").addEventListener("focus", (e) => e.target.select());

  // Keyboard shortcuts (fire while focus is inside this toolbar webview --
  // the same shortcuts also work from inside a loaded page, see
  // src-tauri/src/adblock.rs::build_content_script).
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key === "t") { e.preventDefault(); createTab(); return; }
    if (mod && e.key === "w") { e.preventDefault(); if (activeTabId) closeTab(activeTabId); return; }
    if (mod && e.key === "l") {
      e.preventDefault();
      const input = document.getElementById("url-input");
      input.focus();
      input.select();
      return;
    }
    if (e.key === "F5" || (mod && e.key === "r")) {
      e.preventDefault();
      if (activeTabId) invoke("reload", { id: activeTabId });
      return;
    }
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); if (activeTabId) invoke("go_back", { id: activeTabId }); return; }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); if (activeTabId) invoke("go_forward", { id: activeTabId }); return; }
    if (mod && e.key === "d") { e.preventDefault(); toggleBookmark(); return; }
    if (mod && e.key === "Tab") { e.preventDefault(); invoke("cycle_tab", { direction: e.shiftKey ? -1 : 1 }); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      invoke("reopen_closed_tab").then((id) => { if (id != null) toast("Reopened closed tab"); });
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); toggleSidePanel("passwords", "kessel://passwords"); return; }
    if (mod && e.key === "b") {
      e.preventDefault();
      invoke("close_side_panel").then(() => {
        openPanelKind = null;
        updatePanelHighlights();
      });
      return;
    }
    if (mod && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      invoke("switch_tab_by_index", { index: e.key === "9" ? -1 : parseInt(e.key, 10) - 1 });
      return;
    }
  });

  // --- Backend events ----------------------------------------------------

  await listen("tab-navigated", (event) => {
    // Rust only emits this for genuine external http(s) navigation --
    // internal kessel://... pages are filtered out on the Rust side (see
    // on_navigation in main.rs), so whatever we track here is real.
    const { id, url } = event.payload;
    shieldsStats.delete(id); // a new page starts counting from zero
    const tab = findTab(id);
    if (tab) {
      tab.url = url;
      tab.favicon = null; // stale from whatever page this tab was on before
      if (!tab.userTitled) tab.title = hostOf(url);
    }
    if (id === activeTabId) updateAddressBarForActiveTab();
    renderTabs();
    persistSession();
  });

  await listen("tab-favicon-changed", (event) => {
    const { id, url } = event.payload;
    const tab = findTab(id);
    if (tab) {
      tab.favicon = url;
      rememberSiteFavicon(tab.url, url);
      renderTabs();
    }
  });

  await listen("tab-title-changed", (event) => {
    const { id, title } = event.payload;
    const tab = findTab(id);
    if (tab && title) {
      tab.title = title;
      tab.userTitled = true;
    }
    renderTabs();
  });

  await listen("tab-load-started", (event) => {
    const tab = findTab(event.payload.id);
    if (tab) tab.loading = true;
    if (event.payload.id === activeTabId) showProgress(true);
    renderTabs();
  });

  await listen("tab-load-finished", (event) => {
    const tab = findTab(event.payload.id);
    if (tab) tab.loading = false;
    if (event.payload.id === activeTabId) showProgress(false);
    renderTabs();
  });

  await listen("tab-created", (event) => {
    const { id, url, activate } = event.payload;
    if (!findTab(id)) {
      tabs.push({ id, url, title: INTERNAL_TITLES[url] || hostOf(url), justCreated: true, loading: false, lastActiveAt: Date.now() });
      if (activate) {
        activeTabId = id;
        updateAddressBarForActiveTab();
      } else {
        toast("Opened in a new tab");
      }
      renderTabs();
      persistSession();
    }
  });

  // A singleton page (Settings/Passwords) was already open -- Rust already
  // switched the actual webview, this just syncs the toolbar's own state.
  await listen("tab-focused", (event) => {
    activeTabId = event.payload.id;
    renderTabs();
    updateAddressBarForActiveTab();
  });

  await listen("pinned-changed", (event) => {
    pinned = event.payload;
    renderPinned();
  });

  await listen("bookmarks-changed", (event) => {
    bookmarks = event.payload;
    updateStarButton();
    renderBookmarksBar();
  });

  await listen("side-panel-changed", (event) => {
    openPanelKind = event.payload;
    updatePanelHighlights();
  });

  await listen("shields-stats", (event) => {
    shieldsStats.set(event.payload.id, event.payload.stats);
    if (event.payload.id === activeTabId) updateShieldsButton();
  });

  await listen("adblock-count-changed", (event) => {
    blockedCount = event.payload;
    updateShield();
  });

  await listen("download-started", () => {
    activeDownloads++;
    updateDownloadsBadge();
    toast("Download started");
  });

  await listen("download-finished", (event) => {
    activeDownloads = Math.max(0, activeDownloads - 1);
    updateDownloadsBadge();
    toast(event.payload.success ? "Download complete" : "Download failed");
  });

  window.addEventListener("kessel-settings", () => {
    updateShieldsButton();
    updateShield();
    renderEngineMenu();
    renderBookmarksBar();
  });
});

// --- Loading progress bar --------------------------------------------------
// Now driven by real on_page_load Started/Finished events from Rust instead
// of a fixed-duration animation guess.
let progressResetTimer = null;
function showProgress(active) {
  const fill = document.getElementById("progress-fill");
  clearTimeout(progressResetTimer);
  if (active) {
    fill.classList.remove("done");
    fill.classList.add("active");
  } else {
    fill.classList.add("done");
    progressResetTimer = setTimeout(() => fill.classList.remove("active", "done"), 300);
  }
}
