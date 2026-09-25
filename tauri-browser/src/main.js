// Toolbar webview: renders the left icon rail (Opera-GX style) and the top
// tab-strip/nav-bar chrome. Talks to Rust exclusively through invoke() --
// it never touches a content webview directly. Rail icons open a slide-out
// side panel (a real webview Rust positions beside the active tab) rather
// than a new tab -- see toggleSidePanel below and side_panel commands in
// src-tauri/src/main.rs.
import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { ENGINES, resolveInput, toast, hostOf, listenHere, internalTitle, internalPageKey, escapeHtml } from "./shared/api.js";
import { siteIcon, injectRefractionFilter, writeChromeGeometry, watchCustomWallpaper, rememberSiteFavicon, sharePageStorage } from "./shared/glass.js";
import { avatarHtml, accountName } from "./shared/accounts.js";

const { invoke } = window.__TAURI__.core;
// Only events for this window's toolbar (and broadcasts) -- see listenHere.
const listen = listenHere;
const appWindow = window.__TAURI__.window.getCurrentWindow();

// Which browser window this toolbar belongs to (set by Rust, see
// browser_windows.rs). A private window's tabs are InPrivate: no history,
// no session restore, nothing on the recently-closed list.
const WIN = window.__KESSEL_WINDOW__ || { label: "win-1", number: 1, private: false };
document.documentElement.classList.toggle("private-window", !!WIN.private);

// Tells Rust's toolbar watchdog this page is alive. If this renderer
// process dies (crash, or killed in Task Manager) the heartbeats stop and
// Rust reloads the toolbar -- see restoreAfterToolbarReload. Started before
// anything else so a slow init can't be mistaken for a dead toolbar.
invoke("toolbar_heartbeat").catch(() => {});
setInterval(() => invoke("toolbar_heartbeat").catch(() => {}), 1000);

// --- Tab state -----------------------------------------------------------
// Each tab maps to a real native webview created by Rust. This module only
// tracks id/url/title/loading for the tab-strip UI and forwards actions.

// { id, url, title, loading, discarded, neverCreated, lastActiveAt, account }
// `account`: the id of the account the tab is signed in as, null for Main
// (see src-tauri/src/accounts.rs). An account's tabs stay together in the
// strip as a coloured, collapsible group.
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

// A read-only view of the tab strip for the end-to-end tests (tests/e2e).
window.__kesselTest = {
  tabs: () =>
    tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.id === activeTabId,
      discarded: !!t.discarded,
      loading: !!t.loading,
      account: t.account ?? null,
    })),
  activeTabId: () => activeTabId,
  window: () => WIN,
  // The toolbar's own actions, as its buttons and shortcuts run them.
  createTab: (url, account) => createTab(url, account),
  activateTab: (id) => activateTab(id),
  closeTab: (id) => closeTab(id),
};

// Rust's tab-cycling order (Ctrl+Tab, Ctrl+1..9) follows the strip's.
// Sleeping placeholders have no real (u32) id to send.
function syncTabOrder() {
  invoke("set_tab_order", { ids: tabs.filter((t) => t.id > 0).map((t) => t.id) }).catch(() => {});
}

// --- Accounts ----------------------------------------------------------------

let accounts = []; // [{ id, name, color }], Main not included
const collapsedGroups = new Set(); // account ids whose tab group is folded

function accountById(id) {
  return (id && accounts.find((a) => a.id === id)) || null;
}

function activeAccount() {
  return findTab(activeTabId)?.account ?? null;
}

// A new tab joins its account's group: right after that account's last tab
// (Main tabs, and the first tab of an account, go at the end).
function insertTab(tab) {
  let last = -1;
  if (tab.account) tabs.forEach((t, i) => { if (t.account === tab.account) last = i; });
  if (last === -1) tabs.push(tab);
  else tabs.splice(last + 1, 0, tab);
  if (last !== -1) syncTabOrder();
}

// Keeps every account's tabs contiguous (a dragged tab can't leave its
// group, or split one: it can't change which account it's signed in as).
function normalizeGroups() {
  const out = [];
  const seen = new Set();
  for (const t of tabs) {
    if (!t.account) out.push(t);
    else if (!seen.has(t.account)) {
      seen.add(t.account);
      out.push(...tabs.filter((x) => x.account === t.account));
    }
  }
  tabs = out;
}

function updateAccountButton() {
  const btn = document.getElementById("account-btn");
  const account = accountById(activeAccount());
  btn.innerHTML = avatarHtml(account, 20);
  btn.title = `This tab: ${accountName(account)}. Open a tab or window as another account`;
}

async function toggleAccountsPopup() {
  const rect = document.getElementById("account-btn").getBoundingClientRect();
  await invoke("toggle_accounts_popup", { x: rect.right + 6, y: rect.bottom }).catch(() => {});
}

// The group's label in the tab strip: click folds/unfolds the group,
// right-click has the group's actions.
function groupChip(account) {
  const count = tabs.filter((t) => t.account === account.id).length;
  const collapsed = collapsedGroups.has(account.id);
  const chip = document.createElement("div");
  chip.className = "tab-group" + (collapsed ? " collapsed" : "");
  chip.dataset.group = account.id;
  chip.style.setProperty("--acct", account.color);
  chip.textContent = collapsed ? `${account.name} · ${count}` : account.name;
  chip.title = `${account.name}: ${count} tab${count === 1 ? "" : "s"} signed in as this account.\nClick to ${collapsed ? "expand" : "collapse"}, right-click for more.`;
  chip.addEventListener("click", () => {
    if (collapsed) collapsedGroups.delete(account.id);
    else collapsedGroups.add(account.id);
    renderTabs();
  });
  chip.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(
      [
        { label: `New tab as ${account.name}`, iconName: "plus", action: () => createTab(undefined, account.id) },
        { label: "Open in a new window", iconName: "popOut", action: () => invoke("open_account_tab", { account: account.id, window: true }).catch((err) => toast(String(err))) },
        {
          label: "Close group",
          iconName: "close",
          action: async () => {
            for (const t of tabs.filter((x) => x.account === account.id)) await closeTab(t.id);
          },
        },
      ],
      e.clientX,
      e.clientY
    );
  });
  return chip;
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
  iconFor("menu-btn", icon("dotsV", 18));
  iconFor("win-min", icon("winMin", 14));
  iconFor("win-max", icon("winMax", 13));
  iconFor("win-close", icon("close", 14));
  if (WIN.private) {
    const badge = document.getElementById("private-badge");
    badge.innerHTML = `${icon("incognito", 14)}<span>Private</span>`;
    badge.hidden = false;
  }
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
      tabs: tabs.map(({ id, url, title, favicon, discarded, neverCreated, userTitled, account }) => ({ id, url, title, favicon, discarded, neverCreated, userTitled, account })),
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
    restored.push({ ...saved, url: tab.url, title: tab.title || saved.title, favicon: tab.favicon ?? saved.favicon, account: tab.account ?? null, loading: false, lastActiveAt: now });
  }
  for (const tab of liveById.values()) {
    const title = tab.title || internalTitle(tab.url) || hostOf(tab.url);
    restored.push({ id: tab.id, url: tab.url, title, favicon: tab.favicon, userTitled: !!tab.title, account: tab.account ?? null, loading: false, lastActiveAt: now });
  }

  tabs = restored;
  normalizeGroups();
  activeTabId = live.active ?? restored.find((t) => !t.discarded)?.id ?? null;
  placeholderCounter = Math.min(snapshot?.placeholderCounter ?? 0, ...restored.map((t) => t.id), 0);
  openPanelKind = live.panel ?? null;
  renderTabs();
  updateAddressBarForActiveTab();
  updatePanelHighlights();
  syncTabOrder();
  return true;
}

function renderTabs() {
  pushToolbarSnapshot();
  const container = document.getElementById("tabs");
  container.innerHTML = "";
  let prevGroup = null;
  for (const tab of tabs) {
    // An account's tabs: a labelled chip in front, its colour on each tab,
    // and (folded) only the chip -- plus the active tab if it's in there.
    const account = accountById(tab.account);
    if (account && account.id !== prevGroup) container.appendChild(groupChip(account));
    prevGroup = account?.id ?? null;
    if (account && collapsedGroups.has(account.id) && tab.id !== activeTabId) continue;

    const el = document.createElement("div");
    el.className = "tab" +
      (tab.id === activeTabId ? " active" : "") +
      (tab.justCreated ? " tab-enter" : "") +
      (tab.discarded ? " discarded" : "") +
      (account ? " grouped" : "");
    if (account) el.style.setProperty("--acct", account.color);
    tab.justCreated = false;
    // The full title on hover -- the strip truncates it.
    el.title = tab.discarded ? "Sleeping to save memory -- click to reload" : tab.title || "";
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
  if (tab.favicon) return `<img class="fav-img" data-tab-id="${tab.id}" src="${escapeHtml(tab.favicon)}" alt="" />`;
  if (!tab.url || tab.url.startsWith("kessel://")) return icon("globe", 11);
  return `<span>${escapeHtml(faviconLetter(tab.url))}</span>`;
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
    // The strip's new order. A folded group's hidden tabs aren't in the
    // DOM -- they stay right behind their group's chip.
    const children = Array.from(document.getElementById("tabs").children);
    const shown = new Set(children.filter((c) => c.dataset.tabId).map((c) => parseInt(c.dataset.tabId, 10)));
    const order = [];
    for (const c of children) {
      if (c.dataset.group) order.push(...tabs.filter((t) => t.account === c.dataset.group && !shown.has(t.id)));
      else if (c.dataset.tabId) order.push(findTab(parseInt(c.dataset.tabId, 10)));
    }
    tabs = [...order.filter(Boolean), ...tabs.filter((t) => !order.includes(t))];
    normalizeGroups();
    syncTabOrder();
    renderTabs();
    persistSession();
    // Dropped somewhere that isn't a tab strip -- below the toolbar (over
    // the page) or outside the window: it moves into a window of its own.
    // (Dropped on another window's strip, that window took it: "move".)
    if (e.dataTransfer.dropEffect === "none" && (e.clientY > reportedInsets.top || isOutsideWindow(e))) {
      moveTabToNewWindow(tab, e);
    }
  });
}

// A tab from another Kessel window dropped on this strip moves here, page
// and all (see adopt_tab in browser_windows.rs).
function wireTabDrops() {
  const strip = document.getElementById("tabs");
  const isForeignTab = (e) => draggedTabId === null && e.dataTransfer.types.includes("application/x-kessel-tab");
  for (const target of [strip, document.getElementById("tab-bar")]) {
    target.addEventListener("dragover", (e) => {
      if (!isForeignTab(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    target.addEventListener("drop", async (e) => {
      if (!isForeignTab(e)) return;
      e.preventDefault();
      const id = parseInt(e.dataTransfer.getData("application/x-kessel-tab"), 10);
      if (!(id > 0) || findTab(id)) return;
      // Where it was dropped: before the first tab whose middle is right of the cursor.
      const els = [...strip.querySelectorAll(".tab")];
      const before = els.find((el) => {
        const r = el.getBoundingClientRect();
        return e.clientX < r.left + r.width / 2;
      });
      try {
        const info = await invoke("adopt_tab", { id });
        adoptTabInfo(info, before ? findTab(parseInt(before.dataset.tabId, 10)) : null);
        await activateTab(info.id);
        await appWindow.setFocus();
      } catch (err) {
        toast(String(err));
      }
    });
  }
}

// Puts a live tab that moved in from another window into the strip, before
// `beforeTab` (or at the end).
function adoptTabInfo(info, beforeTab = null) {
  if (findTab(info.id)) return;
  const tab = {
    id: info.id,
    url: info.url,
    title: info.title || internalTitle(info.url) || hostOf(info.url),
    userTitled: !!info.title,
    favicon: info.favicon ?? null,
    account: info.account ?? null,
    justCreated: true,
    loading: false,
    lastActiveAt: Date.now(),
  };
  const at = beforeTab ? tabs.indexOf(beforeTab) : -1;
  if (at >= 0) tabs.splice(at, 0, tab);
  else tabs.push(tab);
  normalizeGroups();
  syncTabOrder();
}

// "Move to new window" / dragging a tab out: the tab keeps its page and
// moves into a new window (at the drop point, when there is one). A
// sleeping tab has no page to move, so a new window just opens its address.
async function moveTabToNewWindow(tab, e = null) {
  const at = e && (e.screenX || e.screenY) ? { x: e.screenX - 90, y: e.screenY - 18 } : {};
  try {
    if (tab.discarded || tab.id < 0) {
      await invoke("new_window", { private: !!WIN.private, url: tab.url });
      await closeTab(tab.id, { remember: false });
    } else if (tabs.length > 1) {
      await invoke("move_tab_to_new_window", { id: tab.id, ...at });
    }
  } catch (err) {
    toast(`Couldn't move the tab: ${err}`);
  }
}

// "Move to window ▸": sends a live tab to another open window.
async function sendTabToWindow(tab, target) {
  try {
    await invoke("send_tab_to_window", { id: tab.id, target });
  } catch (err) {
    toast(String(err));
  }
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
    await invoke("pop_out", { url: tab.url, title, account: tab.account ?? null, ...popOutPosition(e) });
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

async function showTabContextMenu(tab, x, y) {
  const otherWindows = (await invoke("get_windows").catch(() => [])).filter((w) => !w.current && w.private === !!WIN.private);
  const items = [
    { label: "Duplicate tab", iconName: "copy", action: () => createTab(tab.url, tab.account ?? null) },
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
  if (tabs.length > 1) items.push({ label: "Move to new window", iconName: "popOut", action: () => moveTabToNewWindow(tab) });
  if (tab.id > 0 && !tab.discarded) {
    for (const w of otherWindows) {
      const name = w.title ? `“${w.title.length > 28 ? w.title.slice(0, 27) + "…" : w.title}”` : "another window";
      items.push({ label: `Move to window with ${name} (${w.tabs} tab${w.tabs === 1 ? "" : "s"})`, iconName: "arrowRight", action: () => sendTabToWindow(tab, w.label) });
    }
  }
  if (tab.url && !WIN.private) items.push({ label: "Pop out", iconName: "popOut", action: () => tearOffTab(tab, {}) });
  if (tab.url && !tab.url.startsWith("kessel://") && !pinned.some((p) => p.url === tab.url)) {
    items.push({ label: "Pin to rail", iconName: "pin", action: () => pinUrl(tab.url, tab.title !== "New Tab" ? tab.title : null) });
  }
  // The same page, signed in as someone else.
  if (tab.url && accounts.length) {
    for (const account of [null, ...accounts]) {
      if ((account?.id ?? null) === (tab.account ?? null)) continue;
      items.push({ label: `Open as ${accountName(account)}`, iconName: "user", action: () => createTab(tab.url, account?.id ?? null) });
    }
  }
  showContextMenu(items, x, y);
}

function showContextMenu(items, x, y) {
  document.querySelector(".tab-context-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu tab-context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.right = "auto";

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "menu-item";
    row.innerHTML = icon(item.iconName, 14);
    const label = document.createElement("span");
    label.textContent = item.label; // account names are user-typed
    row.appendChild(label);
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

// `force`: even while you're typing in it (Escape, undoing your edit).
function updateAddressBarForActiveTab(force = false) {
  const tab = findTab(activeTabId);
  const input = document.getElementById("url-input");
  if (force || document.activeElement !== input) {
    // Internal kessel:// pages show a blank omnibox, like a real browser's
    // new-tab/settings pages do -- there's nothing useful to type over.
    input.value = tab && tab.url && !tab.url.startsWith("kessel://") ? tab.url : "";
    input.classList.remove("search-mode");
  }
  updateStarButton();
  updateNavButtons();
  updateShieldsButton();
  updateAccountButton();
  updateZoomIndicator();
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
  const reload = document.getElementById("reload-btn");
  reload.disabled = !hasTab;
  // While the page loads, it's a stop button (Escape does the same).
  const loading = !!findTab(activeTabId)?.loading;
  if (reload.dataset.mode !== (loading ? "stop" : "reload")) {
    reload.dataset.mode = loading ? "stop" : "reload";
    reload.innerHTML = icon(loading ? "close" : "reload", loading ? 16 : 17);
    reload.title = loading ? "Stop loading (Esc)" : "Reload (F5)";
  }
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
    const newId = await invoke("new_tab", { url: tab.url, account: tab.account ?? null });
    tab.id = newId;
    tab.discarded = false;
    tab.neverCreated = false;
    tab.loading = false;
    // new_tab always appends to Rust's own tab-cycling order -- resync it
    // to match the toolbar's visual order so Ctrl+Tab / Ctrl+1..9 don't
    // drift from what's actually on screen.
    syncTabOrder();
    activeTabId = newId;
  } else {
    activeTabId = id;
    await invoke("switch_tab", { id });
  }
  renderTabs();
  updateAddressBarForActiveTab();
  persistSession();
}

// A new tab opens in the same account as the tab you're on (so "+" and
// Ctrl+T inside an account's group stay signed in as that account), unless
// `account` says otherwise (null = Main).
async function createTab(url, account = activeAccount()) {
  account = accountById(account)?.id ?? null;
  const id = await invoke("new_tab", { url: url ?? null, account });
  // Resolve what Rust will actually open this tab to, so the omnibox/star/
  // pin logic below has an accurate url immediately -- don't wait on a
  // possibly-unreliable navigation event for internal kessel:// pages.
  const resolvedUrl = url ?? (currentSettings()?.homepage || "kessel://newtab");
  insertTab({ id, url: resolvedUrl, title: "New Tab", account, justCreated: true, loading: false, lastActiveAt: Date.now() });
  if (account) collapsedGroups.delete(account);
  activeTabId = id;
  renderTabs();
  updateAddressBarForActiveTab();
  persistSession();
  catchUpTab(id);
  return id;
}

// A page can load (and report its title and icon) before new_tab has even
// returned its id to us -- those reports found no tab here and were dropped.
// Rust keeps the latest, so ask once the tab is in the strip.
async function catchUpTab(id) {
  const info = await invoke("get_tab_info", { id }).catch(() => null);
  const tab = findTab(id);
  if (!info || !tab) return;
  let changed = false;
  if (info.title && !tab.userTitled) {
    tab.title = info.title;
    tab.userTitled = true;
    changed = true;
  }
  if (info.favicon && !tab.favicon) {
    tab.favicon = info.favicon;
    changed = true;
  }
  // Only a real address -- right after creation the webview can still be on
  // about:blank, which isn't where the tab is going.
  if (info.url && /^(https?|file):/.test(info.url) && info.url !== tab.url) {
    tab.url = info.url;
    changed = true;
    if (id === activeTabId) updateAddressBarForActiveTab();
  }
  if (changed) {
    renderTabs();
    persistSession();
  }
}

// Adds a tab entry with NO webview behind it yet -- used for session-restore
// tabs you aren't looking at right now. Costs nothing until you click it.
function addPlaceholderTab(url, account = null, title = null) {
  const id = nextPlaceholderId();
  tabs.push({
    id,
    url,
    account: accountById(account)?.id ?? null,
    title: title || internalTitle(url) || hostOf(url),
    userTitled: !!title,
    discarded: true,
    neverCreated: true,
    loading: false,
    lastActiveAt: Date.now(),
  });
  return id;
}

// What this window opens first (see take_window_init in main.rs): the tabs
// of a restored window -- only the one you were looking at gets a real
// webview, the rest come back as sleeping placeholders that cost nothing
// until clicked -- tabs moved in from another window, or links (Shift+click
// opens one in a new window). Returns whether it opened anything.
async function openWindowInit(init) {
  if (!init) return false;
  if (init.session?.tabs?.length) {
    const saved = init.session.tabs;
    const active = Math.min(Math.max(init.session.active || 0, 0), saved.length - 1);
    for (let i = 0; i < saved.length; i++) {
      if (i === active) await createTab(saved[i].url, saved[i].account ?? null);
      else addPlaceholderTab(saved[i].url, saved[i].account ?? null, saved[i].title);
    }
    normalizeGroups();
    renderTabs();
    return true;
  }
  if (init.adopt?.length) {
    for (const info of init.adopt) adoptTabInfo(info);
    await activateTab(init.adopt[0].id);
    return true;
  }
  if (init.urls?.length) {
    for (const url of init.urls) await createTab(url);
    return true;
  }
  return false;
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
      if (SINGLETON_ROUTES.has(internalPageKey(tab.url))) continue; // never discard Settings/Passwords
      if ((tab.lastActiveAt ?? 0) < cutoff) discardTab(tab);
    }
  }, 60 * 1000);
}

// Settings and Passwords can still be reached as full tabs (e.g. typing
// kessel://settings into the omnibox) -- opening them again focuses the
// one already-open tab instead of spawning another full webview. The rail
// icons themselves go through the side panel instead (see below).
const SINGLETON_ROUTES = new Set(["kessel://settings", "kessel://passwords", "kessel://history", "kessel://downloads", "kessel://help"]);

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
  if (SINGLETON_ROUTES.has(internalPageKey(url))) {
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

// This window's tabs, for restoring the session next time (and after a
// crash). Private windows keep nothing.
let sessionTimer = null;
// --- Browser commands ---------------------------------------------------------
// Every command -- from a shortcut (Rust sends "browser-command", see
// src-tauri/src/commands.rs), the menu, the command palette or a button --
// runs here. `ctx.page` is the page the key was pressed in (a tab, or the
// side panel's page); without one, the active tab.

let commandList = []; // [{ id, label, category, keys, ... }] from get_commands

async function runCommand(id, ctx = {}) {
  const page = ctx.page ?? (activeTabId > 0 ? activeTabId : null);
  const act = (action, value = null) => (page ? invoke("page_action", { id: page, action, value }).catch((err) => toast(String(err))) : null);
  const tabNumber = /^tab-([1-8])$/.exec(id);
  if (tabNumber) return goToTab(parseInt(tabNumber[1], 10) - 1);
  switch (id) {
    case "new-tab": return createTab();
    case "close-tab": return activeTabId != null && closeTab(activeTabId);
    case "reopen-closed-tab": return reopenClosed();
    case "next-tab": return cycleTabs(1);
    case "prev-tab": return cycleTabs(-1);
    case "last-tab": return goToTab(-1);
    case "move-tab-left": return moveActiveTab(-1);
    case "move-tab-right": return moveActiveTab(1);
    case "duplicate-tab": {
      const tab = findTab(activeTabId);
      return tab && tab.url && createTab(tab.url, tab.account ?? null);
    }
    case "close-other-tabs": return closeOtherTabs(activeTabId);
    case "new-window": return invoke("new_window", { private: false });
    case "new-private-window": return invoke("new_window", { private: true });
    case "close-window": return appWindow.close();
    case "reopen-closed-window":
      return invoke("reopen_closed_window", {}).then((w) => { if (!w) toast("No recently closed windows"); });
    case "fullscreen": return invoke("toggle_fullscreen", {});
    case "back":
    case "forward":
    case "reload":
    case "hard-reload":
    case "stop":
    case "zoom-in":
    case "zoom-out":
    case "zoom-reset":
    case "print":
    case "save-page":
    case "devtools":
    case "task-manager":
      return act(id);
    case "home": return openInActiveTab(currentSettings()?.homepage || "kessel://newtab");
    case "focus-address-bar": return focusAddressBar(false);
    case "focus-search": return focusAddressBar(true);
    case "find":
    case "find-next":
    case "find-prev":
      return findInPage(id, page);
    case "open-file": {
      const url = await invoke("open_file_dialog").catch((err) => toast(String(err)));
      if (url) await createTab(url);
      return;
    }
    case "view-source": {
      const tab = findTab(page) || findTab(activeTabId);
      if (tab && /^(https?|file):/.test(tab.url)) await createTab(`view-source:${tab.url}`, tab.account ?? null);
      else toast("This page has no source to show");
      return;
    }
    case "bookmark": return toggleBookmark();
    case "bookmark-all-tabs": return bookmarkAllTabs();
    case "toggle-bookmarks-bar": return saveSettings({ bookmarks_bar: currentSettings()?.bookmarks_bar === false });
    case "history": return openSingleton("kessel://history");
    case "downloads": return openSingleton("kessel://downloads");
    case "clear-browsing-data": return openSingleton("kessel://settings/clear");
    case "settings": return openSingleton("kessel://settings");
    case "help": return openSingleton("kessel://help");
    case "menu": return toggleMainMenu();
    case "passwords": return toggleSidePanel("passwords", "kessel://passwords");
    case "side-panel":
      await invoke("close_side_panel").catch(() => {});
      openPanelKind = null;
      updatePanelHighlights();
      return;
    default:
      console.warn("unknown command", id);
  }
}

// Ctrl+Tab / Ctrl+Shift+Tab: through every tab in the strip's order,
// sleeping ones included (they wake up), wrapping around.
async function cycleTabs(direction) {
  const shown = tabs.filter((t) => !isHiddenInGroup(t));
  if (shown.length < 2) return;
  const at = shown.findIndex((t) => t.id === activeTabId);
  const next = shown[(at + direction + shown.length) % shown.length];
  await activateTab(next.id);
}

// Ctrl+1..8 -> that tab; Ctrl+9 (index -1) -> the last one.
async function goToTab(index) {
  const shown = tabs.filter((t) => !isHiddenInGroup(t));
  if (!shown.length) return;
  const tab = index < 0 ? shown[shown.length - 1] : shown[index];
  if (tab) await activateTab(tab.id);
}

// A tab in a folded group only shows as its group's chip -- unless it's
// the active one.
function isHiddenInGroup(tab) {
  return !!(tab.account && collapsedGroups.has(tab.account) && tab.id !== activeTabId);
}

// Ctrl+Shift+PageUp/PageDown: moves the active tab one place, within its
// account's group.
function moveActiveTab(direction) {
  const at = tabs.findIndex((t) => t.id === activeTabId);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= tabs.length || (tabs[to].account ?? null) !== (tabs[at].account ?? null)) return;
  [tabs[at], tabs[to]] = [tabs[to], tabs[at]];
  syncTabOrder();
  renderTabs();
  persistSession();
}

async function closeOtherTabs(keepId) {
  // Sequential on purpose -- closeTab() mutates the shared `tabs` array.
  for (const other of tabs.filter((t) => t.id !== keepId)) await closeTab(other.id);
}

// Ctrl+Shift+T: the last closed tab -- or window, if that closed later.
async function reopenClosed() {
  const result = await invoke("reopen_closed_tab").catch(() => null);
  if (!result) toast("Nothing to reopen");
}

async function bookmarkAllTabs() {
  const pages = tabs.filter((t) => /^(https?|file):/.test(t.url || ""));
  const known = new Set(bookmarks.map((b) => b.url));
  let added = 0;
  for (const t of pages) {
    if (known.has(t.url)) continue;
    await invoke("add_bookmark", { url: t.url, title: t.title || t.url });
    known.add(t.url);
    added++;
  }
  await refreshBookmarks();
  toast(added ? `Bookmarked ${added} tab${added === 1 ? "" : "s"}` : "All tabs are already bookmarked");
}

// F6 / Ctrl+L / Alt+D -- or Ctrl+K / Ctrl+E, which start a search: like
// Chrome, the address bar gets a "?" and whatever follows it is searched
// for, even if it looks like an address.
async function focusAddressBar(search) {
  await invoke("focus_webview").catch(() => {});
  if (search) {
    urlInputEl().value = "? ";
    urlInputEl().focus();
    urlInputEl().setSelectionRange(2, 2);
    urlInputEl().classList.add("search-mode");
  } else {
    urlInputEl().focus();
    urlInputEl().select();
  }
}

// Gives the keyboard back to the active tab's page.
function focusPage() {
  if (activeTabId > 0) invoke("page_action", { id: activeTabId, action: "focus", value: null }).catch(() => {});
}

function urlInputEl() {
  return document.getElementById("url-input");
}

// Enter in the address bar: `where` is "here", "tab" (Alt+Enter) or
// "window" (Shift+Enter).
async function navigateFromAddressBar(text, where) {
  const url = resolveInput(text, currentSettings()?.search_engine || "google");
  if (!url) return;
  urlInputEl().blur();
  if (where === "tab") await createTab(url);
  else if (where === "window") await invoke("new_window", { private: !!WIN.private, url });
  else await navigateActiveTab(text);
  if (where !== "window") focusPage();
}

// The Kessel menu (⋮, Alt+F, Alt+E, F10): a popup under its button.
async function toggleMainMenu() {
  const rect = document.getElementById("menu-btn").getBoundingClientRect();
  const tab = findTab(activeTabId);
  const init = {
    zoom: tab?.zoom ?? currentSettings()?.default_zoom ?? 1,
    web: !!(tab && /^(https?|file):/.test(tab.url || "")),
  };
  await invoke("toggle_popup", { kind: "menu", x: rect.right + 4, y: rect.bottom, width: 300, height: 700, init }).catch(() => {});
}

// Ctrl+F opens the engine's own find bar on the page (starting with the
// selected text, like Chrome); F3 / Ctrl+G and Shift+F3 / Ctrl+Shift+G go to
// the next / previous match -- starting a search if there isn't one yet.
async function findInPage(command, page) {
  if (!page) return;
  const term = command === "find" ? await invoke("page_selection", { id: page }).catch(() => "") : null;
  await invoke("page_action", { id: page, action: command, value: term || null }).catch((err) => toast(String(err)));
}

// The address bar's zoom badge: the active tab's zoom when it isn't the
// default; clicking it resets it.
function updateZoomIndicator() {
  const btn = document.getElementById("zoom-btn");
  if (!btn) return;
  const tab = findTab(activeTabId);
  const def = currentSettings()?.default_zoom ?? 1;
  const zoom = tab?.zoom ?? def;
  const show = Math.abs(zoom - def) > 0.001;
  btn.hidden = !show;
  btn.textContent = `${Math.round(zoom * 100)}%`;
  btn.title = `Zoom: ${Math.round(zoom * 100)}% -- click to reset (Ctrl+0)`;
}

function persistSession() {
  if (WIN.private) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    // Settings/Passwords are excluded on purpose: restoring one as a plain
    // tab would bypass the singleton dedup the next time it's reopened.
    const kept = tabs.filter((t) => t.url && (/^(https?|file):/.test(t.url) || t.url.startsWith("kessel://")) && !SINGLETON_ROUTES.has(internalPageKey(t.url)));
    const saved = kept.map((t) => ({ url: t.url, account: t.account ?? null, title: t.userTitled ? t.title : null }));
    const active = Math.max(0, kept.findIndex((t) => t.id === activeTabId));
    invoke("save_window_session", { tabs: saved, active }).catch(() => {});
  }, 300);
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
  // Account tabs copy the wallpaper and our geometry from Main (glass.js).
  sharePageStorage();
  paintStaticIcons();
  wireWindowControls();
  renderEngineMenu();

  await refreshBookmarks();
  await refreshPinned();
  accounts = (await invoke("get_accounts").catch(() => null))?.accounts ?? [];
  blockedCount = await invoke("get_blocked_count").catch(() => 0);
  updateShield();
  updateDownloadsBadge();

  // Before the first tab exists, so Rust places it below the real chrome.
  await wireChromeInsets();

  wireTabDiscarding();
  wireTabDrops();

  document.getElementById("rail-home").addEventListener("click", () => createTab());
  document.getElementById("rail-add-pin").addEventListener("click", pinCurrentTab);
  document.getElementById("rail-shield").addEventListener("click", toggleShield);
  document.getElementById("rail-downloads").addEventListener("click", () => toggleSidePanel("downloads", "kessel://downloads"));
  document.getElementById("rail-passwords").addEventListener("click", () => toggleSidePanel("passwords", "kessel://passwords"));
  document.getElementById("rail-settings").addEventListener("click", () => toggleSidePanel("settings", "kessel://settings"));

  document.getElementById("new-tab-btn").addEventListener("click", () => createTab());
  document.getElementById("back-btn").addEventListener("click", () => runCommand("back"));
  document.getElementById("forward-btn").addEventListener("click", () => runCommand("forward"));
  // Reload, or stop while the page is still loading (like Chrome's button).
  document.getElementById("reload-btn").addEventListener("click", () => runCommand(findTab(activeTabId)?.loading ? "stop" : "reload"));
  document.getElementById("star-btn").addEventListener("click", toggleBookmark);
  document.getElementById("menu-btn").addEventListener("click", toggleMainMenu);
  document.getElementById("zoom-btn").addEventListener("click", () => runCommand("zoom-reset"));
  document.getElementById("shields-btn").addEventListener("click", toggleShieldsPopup);
  document.getElementById("account-btn").addEventListener("click", toggleAccountsPopup);
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

  // The address bar's own keys. (Every browser shortcut -- Ctrl+T, F5... --
  // is handled in Rust, see src-tauri/src/commands.rs, and arrives here as
  // a "browser-command" event.)
  //   Enter            go there / search
  //   Alt+Enter        ...in a new tab
  //   Shift+Enter      ...in a new window
  //   Ctrl+Enter       add www. and .com ("kessel" -> www.kessel.com)
  //   Escape           undo your edit; again: back to the page
  const urlInput = document.getElementById("url-input");
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      let text = e.target.value;
      if ((e.ctrlKey || e.metaKey) && text.trim() && !/[\s./:]/.test(text.trim())) text = `www.${text.trim()}.com`;
      const where = e.altKey ? "tab" : e.shiftKey ? "window" : "here";
      navigateFromAddressBar(text, where);
    } else if (e.key === "Escape") {
      e.preventDefault();
      const tab = findTab(activeTabId);
      const shown = tab && tab.url && !tab.url.startsWith("kessel://") ? tab.url : "";
      if (e.target.value !== shown) {
        updateAddressBarForActiveTab(true);
        e.target.select();
      } else {
        e.target.blur();
        focusPage();
      }
    }
  });
  urlInput.addEventListener("focus", (e) => e.target.select());
  urlInput.addEventListener("blur", () => urlInput.classList.remove("search-mode"));

  // Every shortcut, menu item and palette entry ends up here.
  await listen("browser-command", (event) => runCommand(event.payload.command, event.payload));
  commandList = await invoke("get_commands").catch(() => []);
  window.addEventListener("kessel-settings", async () => {
    commandList = await invoke("get_commands").catch(() => commandList);
  });

  await listen("fullscreen-changed", (event) => {
    document.documentElement.classList.toggle("fullscreen", !!event.payload.on);
    reportChromeInsets();
  });

  await listen("zoom-changed", (event) => {
    const tab = findTab(event.payload.id);
    if (!tab) return;
    tab.zoom = event.payload.factor;
    if (tab.id === activeTabId) updateZoomIndicator();
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
      // Stale from whatever page this tab was on before -- the new page's
      // own title and icon follow from Rust as it loads (watch_page).
      tab.favicon = null;
      tab.title = hostOf(url);
      tab.userTitled = false;
    }
    if (id === activeTabId) updateAddressBarForActiveTab();
    renderTabs();
    persistSession();
  });

  // Titles and icons change often (a video starting, an unread count), so
  // they're patched into the tab in place instead of redrawing the strip.
  await listen("tab-favicon-changed", (event) => {
    const { id, url } = event.payload;
    const tab = findTab(id);
    if (!tab || tab.favicon === url) return;
    tab.favicon = url;
    rememberSiteFavicon(tab.url, url);
    const fav = document.querySelector(`.tab[data-tab-id="${id}"] .tab-favicon`);
    if (fav && !tab.loading) fav.innerHTML = faviconGlyph(tab);
    pushToolbarSnapshot();
  });

  await listen("tab-title-changed", (event) => {
    const { id, title } = event.payload;
    const tab = findTab(id);
    if (!tab || !title || (tab.title === title && tab.userTitled)) return;
    tab.title = title;
    tab.userTitled = true;
    const el = document.querySelector(`.tab[data-tab-id="${id}"]`);
    if (el) {
      el.querySelector(".tab-title").textContent = title;
      if (!tab.discarded) el.title = title;
    }
    pushToolbarSnapshot();
  });

  // The page changed its address without loading a new one (YouTube,
  // Gmail...), or a navigation ended somewhere else than it started.
  await listen("tab-url-changed", (event) => {
    const { id, url } = event.payload;
    const tab = findTab(id);
    if (!tab || tab.url === url) return;
    tab.url = url;
    if (id === activeTabId) updateAddressBarForActiveTab();
    pushToolbarSnapshot();
    persistSession();
  });

  await listen("tab-load-started", (event) => {
    const tab = findTab(event.payload.id);
    if (tab) tab.loading = true;
    if (event.payload.id === activeTabId) {
      showProgress(true);
      updateNavButtons();
    }
    renderTabs();
  });

  await listen("tab-load-finished", (event) => {
    const tab = findTab(event.payload.id);
    if (tab) tab.loading = false;
    if (event.payload.id === activeTabId) {
      showProgress(false);
      updateNavButtons();
    }
    renderTabs();
  });

  await listen("tab-created", (event) => {
    const { id, url, activate, account = null } = event.payload;
    if (!findTab(id)) {
      insertTab({ id, url, title: internalTitle(url) || hostOf(url), account, justCreated: true, loading: false, lastActiveAt: Date.now() });
      if (activate) {
        activeTabId = id;
        if (account) collapsedGroups.delete(account);
        updateAddressBarForActiveTab();
      } else {
        toast("Opened in a new tab");
      }
      renderTabs();
      persistSession();
    }
  });

  await listen("accounts-changed", (event) => {
    accounts = event.payload || [];
    renderTabs();
    updateAccountButton();
  });

  // A deleted account's tabs go too -- sleeping ones included, which only
  // this toolbar knows about.
  await listen("account-removed", async (event) => {
    collapsedGroups.delete(event.payload);
    for (const t of tabs.filter((x) => x.account === event.payload)) {
      await closeTab(t.id, { remember: false });
    }
  });

  // A singleton page (Settings/Passwords) was already open -- Rust already
  // switched the actual webview, this just syncs the toolbar's own state.
  await listen("tab-focused", (event) => {
    activeTabId = event.payload.id;
    renderTabs();
    updateAddressBarForActiveTab();
  });

  // One of this window's tabs moved to another window (dragged there, or
  // "Move to..."). It's still open, just not here any more; a window whose
  // last tab left closes, like in any browser.
  await listen("tab-moved-out", async (event) => {
    const tab = findTab(event.payload.id);
    if (!tab) return;
    const idx = tabs.indexOf(tab);
    tabs.splice(idx, 1);
    if (!tabs.length) {
      await appWindow.close();
      return;
    }
    if (activeTabId === tab.id) await activateTab(tabs[Math.max(0, idx - 1)].id);
    else renderTabs();
    syncTabOrder();
    persistSession();
  });

  // A tab sent here from another window: show it.
  await listen("tab-moved-in", async (event) => {
    adoptTabInfo(event.payload);
    await activateTab(event.payload.id);
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

  // Only now, with every listener above in place, does this window open its
  // tabs -- a fast page can report its title before an earlier listener
  // would even exist. A reload after the toolbar's process died picks up
  // the tabs that are still running instead of opening a fresh one.
  // Otherwise this window opens what it was made for -- your last session's
  // tabs, tabs moved in from another window, a link -- or else the start page.
  let restored = await restoreAfterToolbarReload();
  if (!restored) restored = await openWindowInit(await invoke("take_window_init").catch(() => null));
  if (!restored) await createTab();
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
