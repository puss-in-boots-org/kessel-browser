// Toolbar webview: renders the left icon rail (Opera-GX style) and the top
// tab-strip/nav-bar chrome. Talks to Rust exclusively through invoke() --
// it never touches a content webview directly. Rail icons open a slide-out
// side panel (a real webview Rust positions beside the active tab) rather
// than a new tab -- see toggleSidePanel below and side_panel commands in
// src-tauri/src/main.rs.
import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { ENGINES, resolveInput, looksLikeUrl, toast, hostOf, listenHere, internalTitle, internalPageKey, escapeHtml, keyLabel } from "./shared/api.js";
import { siteIcon, injectRefractionFilter, writeChromeGeometry, watchCustomWallpaper, rememberSiteFavicon, sharePageStorage } from "./shared/glass.js";
import { avatarHtml, accountName } from "./shared/accounts.js";
import { setupOmnibox } from "./omnibox.js";

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

// { id, url, title, loading, discarded, neverCreated, lastActiveAt, account,
//   pinned, audible, muted }
// `account`: the id of the account the tab is signed in as, null for Main
// (see src-tauri/src/accounts.rs). An account's tabs stay together in the
// strip as a coloured, collapsible group.
// `pinned` tabs sit at the front of the strip, icon only, and can't be
// closed by accident (no close button; "close other tabs" keeps them).
// `audible` / `muted`: the page plays sound / was muted (see "tab-audio").
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
      pinned: !!t.pinned,
      audible: !!t.audible,
      muted: !!t.muted,
      selected: selectedTabs.has(t.id),
    })),
  activeTabId: () => activeTabId,
  window: () => WIN,
  // The toolbar's own actions, as its buttons and shortcuts run them.
  createTab: (url, account) => createTab(url, account),
  activateTab: (id) => activateTab(id),
  closeTab: (id) => closeTab(id),
  // The tab strip's mouse actions, as a click would run them.
  clickTab: (id, mods = {}) => document.querySelector(`.tab[data-tab-id="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true, ...mods })),
  // A tab's right-click menu: the items it would show ({ label, keys,
  // disabled... }), or with `pick` (a label) runs that item instead.
  tabMenu: async (id, pick = null) => {
    const items = await tabMenuItems(findTab(id));
    if (pick === null) return items.map((i) => (i === "-" || i.header ? i : { label: i.label, keys: i.keys ?? null, disabled: !!i.disabled }));
    const item = items.find((i) => i.label === pick);
    if (!item || item.disabled) throw new Error(`no menu item "${pick}"`);
    await item.action();
    return true;
  },
};

// Rust's tab-cycling order (Ctrl+Tab, Ctrl+1..9) follows the strip's.
// Sleeping placeholders have no real (u32) id to send.
function syncTabOrder() {
  invoke("set_tab_order", { ids: tabs.filter((t) => t.id > 0).map((t) => t.id) }).catch(() => {});
}

// --- Accounts ----------------------------------------------------------------

let accounts = []; // [{ id, name, color }], Main not included
const collapsedGroups = new Set(); // account ids whose tab group is folded

// Tabs picked with Ctrl+click / Shift+click, besides the active one (which
// always counts as picked too). A right-click on any of them acts on all.
const selectedTabs = new Set();
let selectionAnchor = null; // where a Shift+click range starts

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
  if (tab.account) tabs.forEach((t, i) => { if (t.account === tab.account && !t.pinned) last = i; });
  if (last === -1) tabs.push(tab);
  else tabs.splice(last + 1, 0, tab);
  if (last !== -1) syncTabOrder();
}

// Pinned tabs first, then the rest with every account's tabs contiguous (a
// dragged tab can't leave its group, or split one: it can't change which
// account it's signed in as).
function normalizeGroups() {
  const out = tabs.filter((t) => t.pinned);
  const seen = new Set();
  for (const t of tabs) {
    if (t.pinned) continue;
    if (!t.account) out.push(t);
    else if (!seen.has(t.account)) {
      seen.add(t.account);
      out.push(...tabs.filter((x) => x.account === t.account && !x.pinned));
    }
  }
  tabs = out;
}

// Puts `tab` right after `anchor` in the strip (a duplicate next to its
// original, "New tab to the right").
function moveTabAfter(tab, anchor) {
  if (!tabs.includes(tab) || !tabs.includes(anchor) || tab === anchor) return;
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.splice(tabs.indexOf(anchor) + 1, 0, tab);
  normalizeGroups();
  syncTabOrder();
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
  iconFor("home-btn", icon("home", 17));
  iconFor("share-btn", icon("share", 15));
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
      tabs: tabs.map(({ id, url, title, favicon, discarded, neverCreated, userTitled, account, pinned, muted }) => ({ id, url, title, favicon, discarded, neverCreated, userTitled, account, pinned, muted })),
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
  // Rust lost track of which tab was showing: show ours.
  if (live.active == null && activeTabId > 0) await invoke("switch_tab", { id: activeTabId }).catch(() => {});
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
  for (const id of selectedTabs) if (!findTab(id) || id === activeTabId) selectedTabs.delete(id);
  let prevGroup = null;
  for (const tab of tabs) {
    // An account's tabs: a labelled chip in front, its colour on each tab,
    // and (folded) only the chip -- plus the active tab if it's in there.
    // Pinned tabs sit in front of everything, small, without a chip.
    const account = accountById(tab.account);
    const grouped = account && !tab.pinned;
    if (grouped && account.id !== prevGroup) container.appendChild(groupChip(account));
    prevGroup = grouped ? account.id : null;
    if (grouped && collapsedGroups.has(account.id) && tab.id !== activeTabId) continue;

    const el = document.createElement("div");
    el.className = "tab" +
      (tab.id === activeTabId ? " active" : "") +
      (selectedTabs.has(tab.id) ? " selected" : "") +
      (tab.pinned ? " pinned" : "") +
      (tab.justCreated ? " tab-enter" : "") +
      (tab.discarded ? " discarded" : "") +
      (account ? " grouped" : "");
    if (account) el.style.setProperty("--acct", account.color);
    tab.justCreated = false;
    // The full title on hover -- the strip truncates it.
    el.title = tab.discarded ? `${tab.title || ""}\nSleeping to save memory -- click to wake it up`.trim() : tab.title || "";
    el.dataset.tabId = String(tab.id);
    el.draggable = true;

    const fav = document.createElement("span");
    fav.className = "tab-favicon" + (tab.loading ? " loading" : "");
    fav.innerHTML = tab.loading ? icon("reload", 11) : faviconGlyph(tab);

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || (tab.url ? hostOf(tab.url) : "New Tab");
    el.append(fav, title);

    // Playing sound, or muted: a speaker to click (mute / unmute).
    if (tab.audible || tab.muted) {
      const audio = document.createElement("span");
      audio.className = "tab-audio" + (tab.muted ? " muted" : "");
      audio.title = tab.muted ? "Unmute this tab" : "Mute this tab";
      audio.innerHTML = icon(tab.muted ? "volumeOff" : "volume", 13);
      el.appendChild(audio);
    }

    if (!tab.pinned) {
      const close = document.createElement("span");
      close.className = "close-tab";
      close.innerHTML = icon("close", 12);
      el.appendChild(close);
    }

    el.addEventListener("click", (e) => {
      if (e.target.closest(".close-tab")) {
        e.stopPropagation();
        closeTab(tab.id);
      } else if (e.target.closest(".tab-audio")) {
        e.stopPropagation();
        toggleMute([tab]);
      } else if (e.ctrlKey || e.metaKey) {
        toggleSelected(tab);
      } else if (e.shiftKey) {
        selectRange(tab);
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

// Dragging a tab out: the tab keeps its page and moves into a new window (at
// the drop point, when there is one). A sleeping tab has no page to move, so
// a new window just opens its address.
async function moveTabToNewWindow(tab, e = null) {
  const at = e && (e.screenX || e.screenY) ? { x: e.screenX - 90, y: e.screenY - 18 } : {};
  try {
    if (tab.discarded || tab.id < 0) {
      await invoke("new_window", { private: !!WIN.private, url: tab.url });
      await closeTab(tab.id, { remember: false });
    } else if (tabs.length > 1) {
      await invoke("move_tab_to_new_window", { id: tab.id, pinned: !!tab.pinned, ...at });
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
  showContextMenu(await tabMenuItems(tab), x, y);
}

// "3 tabs" / "tab".
function tabCount(n, one = "tab") {
  return n === 1 ? one : `${n} tabs`;
}

// A command's first shortcut, as the menus show it.
function commandKeys(id) {
  const keys = commandList.find((c) => c.id === id)?.keys;
  return keys?.length ? keyLabel(keys[0]) : undefined;
}

// What a tab's right-click menu offers -- for every picked tab when it's one
// of several picked (Ctrl/Shift+click), otherwise for that tab.
async function tabMenuItems(tab) {
  const list = targetsFor(tab);
  const n = list.length;
  const single = n === 1;
  const live = list.filter((t) => t.id > 0 && !t.discarded);
  const web = list.filter((t) => /^(https?|file):/.test(t.url || ""));
  const allPinned = list.every((t) => t.pinned);
  const allMuted = live.length > 0 && live.every((t) => t.muted);
  const first = tabs.indexOf(list[0]);
  const last = tabs.indexOf(list[n - 1]);
  const picked = new Set(list);
  const right = tabs.slice(last + 1).filter((t) => !t.pinned);
  const left = tabs.slice(0, first).filter((t) => !t.pinned && !picked.has(t));
  const others = tabs.filter((t) => !picked.has(t) && !t.pinned);
  const unpinned = tabs.filter((t) => !t.pinned);
  const otherWindows = (await invoke("get_windows").catch(() => [])).filter((w) => !w.current && w.private === !!WIN.private);

  const items = [
    { label: "New tab to the right", iconName: "plus", action: () => createTab(undefined, list[n - 1].account ?? null, { after: list[n - 1] }) },
    "-",
    { label: single ? "Reload" : `Reload ${tabCount(n)}`, iconName: "reload", keys: single && tab.id === activeTabId ? commandKeys("reload") : undefined, disabled: !live.length, action: () => reloadTabs(live) },
    { label: single ? "Duplicate" : `Duplicate ${tabCount(n)}`, iconName: "copy", keys: single && tab.id === activeTabId ? commandKeys("duplicate-tab") : undefined, disabled: !list.some((t) => t.url), action: () => duplicateTabs(list) },
    { label: `${allPinned ? "Unpin" : "Pin"} ${tabCount(n)}`, iconName: "pin", keys: single && tab.id === activeTabId ? commandKeys("pin-tab") : undefined, action: () => setPinned(list, !allPinned) },
    { label: `${allMuted ? "Unmute" : "Mute"} ${tabCount(n)}`, iconName: allMuted ? "volume" : "volumeOff", keys: single && tab.id === activeTabId ? commandKeys("mute-tab") : undefined, disabled: !live.length, action: () => toggleMute(live) },
    "-",
    { label: single ? "Bookmark tab" : `Bookmark ${tabCount(n)}`, iconName: "star", disabled: !web.length, action: () => bookmarkTabs(web) },
    { label: single ? "Copy link" : `Copy ${n} links`, iconName: "link", disabled: !web.length, action: () => copyTabLinks(web) },
    "-",
    { label: single ? "Move to new window" : `Move ${tabCount(n)} to new window`, iconName: "popOut", disabled: n >= tabs.length, action: () => moveTabsToNewWindow(list) },
  ];
  if (live.length) {
    for (const w of otherWindows) {
      const name = w.title ? `“${w.title.length > 28 ? w.title.slice(0, 27) + "…" : w.title}”` : "another window";
      items.push({ label: `Move to window with ${name} (${w.tabs} tab${w.tabs === 1 ? "" : "s"})`, iconName: "arrowRight", action: () => sendTabsToWindow(live, w.label) });
    }
  }
  if (single) {
    if (tab.url && !WIN.private) items.push({ label: "Pop out", iconName: "popOut", action: () => tearOffTab(tab, {}) });
    if (tab.url && !tab.url.startsWith("kessel://") && !pinned.some((p) => p.url === tab.url)) {
      items.push({ label: "Add to sidebar", iconName: "pin", action: () => pinUrl(tab.url, tab.title !== "New Tab" ? tab.title : null) });
    }
    // The same page, signed in as someone else.
    if (tab.url && accounts.length) {
      items.push("-");
      for (const account of [null, ...accounts]) {
        if ((account?.id ?? null) === (tab.account ?? null)) continue;
        items.push({ label: `Open as ${accountName(account)}`, iconName: "user", action: () => createTab(tab.url, account?.id ?? null, { after: tab }) });
      }
    }
  }
  items.push(
    "-",
    { label: single ? "Close" : `Close ${tabCount(n)}`, iconName: "close", keys: single && tab.id === activeTabId ? commandKeys("close-tab") : undefined, action: () => closeTabs(list) },
    { label: "Close other tabs", iconName: "x", keys: single && tab.id === activeTabId ? commandKeys("close-other-tabs") : undefined, disabled: !others.length, action: () => closeTabs(others) },
    { label: "Close tabs to the right", iconName: "arrowRight", keys: single && tab.id === activeTabId ? commandKeys("close-tabs-right") : undefined, disabled: !right.length, action: () => closeTabs(right) },
    { label: "Close tabs to the left", iconName: "back", keys: single && tab.id === activeTabId ? commandKeys("close-tabs-left") : undefined, disabled: !left.length, action: () => closeTabs(left) }
  );
  if (tabs.some((t) => t.pinned)) items.push({ label: "Close all but pinned tabs", iconName: "pin", disabled: !unpinned.length, action: () => closeTabs(unpinned) });
  items.push("-", { label: "Reopen closed tab", iconName: "history", keys: commandKeys("reopen-closed-tab"), action: reopenClosed });
  return items;
}

// --- Pinned, muted and picked tabs ----------------------------------------------

// What an action on `tab` applies to: every picked tab (the active one
// included) when `tab` is one of them, otherwise just `tab`.
function targetsFor(tab) {
  if (!tab) return [];
  const group = new Set([...selectedTabs, activeTabId]);
  if (!selectedTabs.size || !group.has(tab.id)) return [tab];
  return tabs.filter((t) => group.has(t.id));
}

// Ctrl+click: picks or un-picks a tab (the active one stays as it is).
function toggleSelected(tab) {
  if (tab.id === activeTabId) return;
  if (selectedTabs.has(tab.id)) selectedTabs.delete(tab.id);
  else selectedTabs.add(tab.id);
  selectionAnchor = tab.id;
  renderTabs();
}

// Shift+click: picks every tab from the last one picked (or the active
// one) to this one.
function selectRange(tab) {
  const shown = tabs.filter((t) => !isHiddenInGroup(t));
  const anchor = findTab(selectionAnchor) && !isHiddenInGroup(findTab(selectionAnchor)) ? selectionAnchor : activeTabId;
  const from = shown.findIndex((t) => t.id === anchor);
  const to = shown.indexOf(tab);
  if (from < 0 || to < 0) return;
  selectedTabs.clear();
  for (const t of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) if (t.id !== activeTabId) selectedTabs.add(t.id);
  renderTabs();
}

function clearSelection() {
  selectedTabs.clear();
  selectionAnchor = null;
}

// Pins (to the end of the pinned tabs) or unpins (to just after them, or
// the front of the tab's account group) every tab in `list`.
function setPinned(list, on) {
  const moving = new Set(list);
  const rest = tabs.filter((t) => !moving.has(t));
  const ordered = on ? list : [...list].reverse();
  for (const t of ordered) {
    t.pinned = on;
    let at = rest.filter((x) => x.pinned).length;
    if (!on && t.account) {
      const group = rest.findIndex((x) => !x.pinned && x.account === t.account);
      if (group >= 0) at = group;
    }
    rest.splice(at, 0, t);
  }
  tabs = rest;
  normalizeGroups();
  clearSelection();
  syncTabOrder();
  renderTabs();
  persistSession();
}

// Mutes every tab in `list`, or unmutes them if they're all muted already.
async function toggleMute(list) {
  const live = list.filter((t) => t.id > 0 && !t.discarded);
  if (!live.length) return;
  const mute = !live.every((t) => t.muted);
  for (const t of live) {
    t.muted = mute; // the page confirms it with "tab-audio"
    await invoke("page_action", { id: t.id, action: mute ? "mute" : "unmute", value: null }).catch(() => {});
  }
  renderTabs();
  pushToolbarSnapshot();
}

async function reloadTabs(list) {
  for (const t of list) await invoke("page_action", { id: t.id, action: "reload", value: null }).catch(() => {});
}

// Each copy opens right after its original (pinned if that is); the last
// one is shown.
async function duplicateTabs(list) {
  for (const t of list.filter((x) => x.url)) await createTab(t.url, t.account ?? null, { after: t, pinned: !!t.pinned });
  clearSelection();
}

async function bookmarkTabs(list) {
  const known = new Set(bookmarks.map((b) => b.url));
  let added = 0;
  for (const t of list) {
    if (known.has(t.url)) continue;
    await invoke("add_bookmark", { url: t.url, title: t.title || t.url });
    known.add(t.url);
    added++;
  }
  await refreshBookmarks();
  if (list.length === 1) toast(added ? "Bookmarked" : "Already bookmarked");
  else toast(added ? `Bookmarked ${added} tab${added === 1 ? "" : "s"}` : "These tabs are already bookmarked");
}

async function copyTabLinks(list) {
  const text = list.map((t) => t.url).join("\n");
  await navigator.clipboard.writeText(text).then(
    () => toast(list.length === 1 ? "Link copied" : `${list.length} links copied`),
    () => toast("Couldn't copy -- clipboard unavailable")
  );
}

// Closes every tab in `list`; if the tab you're on is one of them, the
// nearest one that stays open (to its left, else its right) takes over
// first, so no tab that's about to close gets woken up on the way.
async function closeTabs(list) {
  if (!list.length) return;
  const closing = new Set(list);
  const active = findTab(activeTabId);
  if (active && closing.has(active)) {
    const at = tabs.indexOf(active);
    const next = tabs.slice(0, at).reverse().find((t) => !closing.has(t)) ?? tabs.slice(at + 1).find((t) => !closing.has(t));
    if (next) await activateTab(next.id);
  }
  clearSelection();
  // One at a time -- closeTab() changes the shared `tabs` array.
  for (const t of list) await closeTab(t.id);
}

// Several tabs into one new window: live ones keep their page, sleeping
// ones come along asleep.
async function moveTabsToNewWindow(list) {
  const live = list.filter((t) => t.id > 0 && !t.discarded);
  const sleeping = list.filter((t) => !(t.id > 0 && !t.discarded) && t.url);
  try {
    await invoke("move_tabs_to_new_window", {
      ids: live.map((t) => t.id),
      sleeping: sleeping.map((t) => ({ url: t.url, account: t.account ?? null, title: t.userTitled ? t.title : null, pinned: !!t.pinned })),
      pinned: live.filter((t) => t.pinned).map((t) => t.id),
    });
    for (const t of sleeping) await closeTab(t.id, { remember: false });
  } catch (err) {
    toast(`Couldn't move the tabs: ${err}`);
  }
  clearSelection();
}

async function sendTabsToWindow(list, target) {
  for (const t of list) await sendTabToWindow(t, target);
  clearSelection();
}

// A right-click menu, as a popup over the page (context.html) -- drawn in
// the toolbar it would be hidden behind the tab below it. `items`:
// { label, iconName, action, keys?, disabled?, danger?, checked?, swatch? },
// "-" for a separator or { header }. The popup sends back which one was
// picked ("context-pick", see the listener at startup).
let contextMenu = null; // { token, actions: Map<id, action> }
let contextTokens = 0;

// `dropdown`: a button's menu, which a second click on the button closes
// (a right-click menu reopens where you click instead).
function showContextMenu(items, x, y, { dropdown = false, width = 290 } = {}) {
  const token = ++contextTokens;
  const actions = new Map();
  const wire = items.filter(Boolean).map((item, i) => {
    if (item === "-" || item.header) return item;
    const id = String(i);
    actions.set(id, item.action);
    return { id, label: item.label, icon: item.iconName, keys: item.keys, disabled: item.disabled, danger: item.danger, checked: item.checked, swatch: item.swatch };
  });
  // No separator first, last or twice in a row.
  const tidy = [];
  for (const item of wire) if (item !== "-" || (tidy.length && tidy[tidy.length - 1] !== "-")) tidy.push(item);
  while (tidy[tidy.length - 1] === "-") tidy.pop();
  contextMenu = { token, actions };
  const height = 12 + tidy.reduce((h, item) => h + (item === "-" ? 11 : item.header ? 24 : 30), 0);
  invoke("toggle_popup", { kind: dropdown ? "dropdown" : "context", x: Math.round(x), y: Math.round(y), width, height, init: { items: tidy, opener: `toolbar-${WIN.number}`, token } }).catch(() => {});
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
    omnibox?.reset();
  }
  document.getElementById("share-btn").hidden = !(tab && /^(https?|file):/.test(tab.url || ""));
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
  clearSelection();
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
    tab.audible = false;
    // A muted tab stays muted when it wakes up.
    if (tab.muted) invoke("page_action", { id: newId, action: "mute", value: null }).catch(() => {});
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
// `account` says otherwise (null = Main). `after`: right after that tab
// instead of at the end; `pinned`: as a pinned tab.
async function createTab(url, account = activeAccount(), { after = null, pinned = false } = {}) {
  account = accountById(account)?.id ?? null;
  const id = await invoke("new_tab", { url: url ?? null, account });
  // Resolve what Rust will actually open this tab to, so the omnibox/star/
  // pin logic below has an accurate url immediately -- don't wait on a
  // possibly-unreliable navigation event for internal kessel:// pages.
  const resolvedUrl = url ?? (currentSettings()?.homepage || "kessel://newtab");
  const tab = { id, url: resolvedUrl, title: "New Tab", account, pinned, justCreated: true, loading: false, lastActiveAt: Date.now() };
  insertTab(tab);
  if (after) moveTabAfter(tab, after);
  else if (pinned) {
    normalizeGroups();
    syncTabOrder();
  }
  if (account) collapsedGroups.delete(account);
  clearSelection();
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
function addPlaceholderTab(url, account = null, title = null, pinned = false) {
  const id = nextPlaceholderId();
  tabs.push({
    id,
    url,
    account: accountById(account)?.id ?? null,
    title: title || internalTitle(url) || hostOf(url),
    userTitled: !!title,
    pinned: !!pinned,
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
      if (i === active) {
        const id = await createTab(saved[i].url, saved[i].account ?? null);
        findTab(id).pinned = !!saved[i].pinned;
      } else {
        addPlaceholderTab(saved[i].url, saved[i].account ?? null, saved[i].title, saved[i].pinned);
      }
    }
    normalizeGroups();
    syncTabOrder();
    renderTabs();
    return true;
  }
  // Tabs moved here from another window: the live ones with their pages,
  // sleeping ones still asleep.
  if (init.adopt?.length || init.sleeping?.length) {
    const pinnedIds = new Set(init.pinned || []);
    for (const info of init.adopt || []) {
      adoptTabInfo(info);
      if (pinnedIds.has(info.id)) findTab(info.id).pinned = true;
    }
    for (const t of init.sleeping || []) addPlaceholderTab(t.url, t.account ?? null, t.title, t.pinned);
    normalizeGroups();
    syncTabOrder();
    await activateTab((tabs.find((t) => !t.discarded) ?? tabs[0]).id);
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
      if (tab.audible) continue; // playing music or a video you're listening to
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
  // An address typed without http(s):// goes to https first, and to http
  // if the site has no https (like Chrome).
  const typedBare = looksLikeUrl(rawInput) && !/^[a-z][a-z0-9+.-]*:/i.test(rawInput.trim());
  await invoke("navigate", { id: tab.id, url, httpFallback: typedBare && url.startsWith("https://") });
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
  // The tab commands act on every picked tab (Ctrl/Shift+click), like the
  // tab menu; without any picked, on the active one.
  const picked = targetsFor(findTab(activeTabId));
  switch (id) {
    case "new-tab": return createTab();
    case "close-tab": return picked.length && closeTabs(picked);
    case "reopen-closed-tab": return reopenClosed();
    case "next-tab": return cycleTabs(1);
    case "prev-tab": return cycleTabs(-1);
    case "last-tab": return goToTab(-1);
    case "move-tab-left": return moveActiveTab(-1);
    case "move-tab-right": return moveActiveTab(1);
    case "duplicate-tab": return duplicateTabs(picked);
    case "close-other-tabs": return closeOtherTabs(picked);
    case "close-tabs-right": {
      const last = tabs.indexOf(picked[picked.length - 1]);
      return last >= 0 && closeTabs(tabs.slice(last + 1).filter((t) => !t.pinned));
    }
    case "close-tabs-left": {
      const first = tabs.indexOf(picked[0]);
      return first >= 0 && closeTabs(tabs.slice(0, first).filter((t) => !t.pinned));
    }
    case "pin-tab": return picked.length && setPinned(picked, !picked.every((t) => t.pinned));
    case "mute-tab": return toggleMute(picked);
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
    case "copy-link": {
      const tab = findTab(page) || findTab(activeTabId);
      if (!tab || !/^(https?|file):/.test(tab.url || "")) return toast("This page has no link to copy");
      await navigator.clipboard.writeText(tab.url).then(() => toast("Link copied"), () => toast("Couldn't copy -- clipboard unavailable"));
      return;
    }
    case "share-page": return toggleSharePopup();
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

// Closes every tab but `keep` -- and the pinned ones, which stay.
async function closeOtherTabs(keep) {
  const kept = new Set(keep);
  await closeTabs(tabs.filter((t) => !kept.has(t) && !t.pinned));
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

// Opens an address picked in the address bar: here, in a new tab, or in a
// new window.
async function openFromAddressBar(url, how = "here") {
  if (!url) return;
  urlInputEl().blur();
  if (how === "tab") await createTab(url);
  else if (how === "window") await invoke("new_window", { private: !!WIN.private, url });
  else await navigateActiveTab(url);
  if (how !== "window") focusPage();
}

let omnibox = null;

// Settings that change the toolbar itself.
function applyToolbarSettings() {
  document.getElementById("home-btn").hidden = currentSettings()?.show_home_button === false;
}

// The address bar's share button: copy the link, its QR code, or Windows'
// Share window (share.html).
async function toggleSharePopup() {
  const tab = findTab(activeTabId);
  if (!tab || !/^(https?|file):/.test(tab.url || "")) return;
  const rect = document.getElementById("share-btn").getBoundingClientRect();
  await invoke("toggle_popup", { kind: "share", x: rect.right + 60, y: rect.bottom, width: 300, height: 400, init: { url: tab.url, title: tab.title || "" } }).catch(() => {});
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
    const saved = kept.map((t) => ({ url: t.url, account: t.account ?? null, title: t.userTitled ? t.title : null, pinned: !!t.pinned }));
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
  if (!tab || tab.discarded) {
    await createTab(url);
    return;
  }
  // Settings, History... are one tab each: go to that one.
  if (SINGLETON_ROUTES.has(internalPageKey(url))) {
    await openSingleton(url);
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

// The address bar's engine button: which engine searches, as a dropdown
// under it (a popup, so the page doesn't cover it).
function toggleEngineMenu() {
  const current = currentSettings()?.search_engine || "google";
  const rect = document.getElementById("engine-btn").getBoundingClientRect();
  const items = [
    { header: "Search with" },
    ...Object.entries(ENGINES).map(([key, engine]) => ({ label: engine.name, checked: key === current, action: () => saveSettings({ search_engine: key }) })),
    "-",
    { label: "Manage search engines", iconName: "settings", action: () => openSingleton("kessel://settings/search") },
  ];
  showContextMenu(items, rect.left, rect.bottom + 6, { dropdown: true, width: 230 });
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
  document.getElementById("home-btn").addEventListener("click", () => runCommand("home"));
  document.getElementById("share-btn").addEventListener("click", toggleSharePopup);
  applyToolbarSettings();
  window.addEventListener("kessel-settings", applyToolbarSettings);
  document.getElementById("menu-btn").addEventListener("click", toggleMainMenu);
  document.getElementById("zoom-btn").addEventListener("click", () => runCommand("zoom-reset"));
  document.getElementById("shields-btn").addEventListener("click", toggleShieldsPopup);
  document.getElementById("account-btn").addEventListener("click", toggleAccountsPopup);
  document.getElementById("engine-btn").addEventListener("click", toggleEngineMenu);

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

  // Suggestions, answers and in-place completion as you type (omnibox.js).
  omnibox = setupOmnibox({
    input: urlInput,
    anchor: document.getElementById("address-wrap"),
    win: WIN,
    listen,
    getSettings: currentSettings,
    getBookmarks: () => bookmarks,
    getCommands: () => commandList,
    go: openFromAddressBar,
    runCommand: (id) => runCommand(id),
    copyText: (text) => navigator.clipboard.writeText(text).catch(() => toast("Couldn't copy -- clipboard unavailable")),
    toast,
    activeTabId: () => activeTabId,
  });

  // Every shortcut, menu item and palette entry ends up here.
  await listen("browser-command", (event) => runCommand(event.payload.command, event.payload));
  // A right-click menu's pick (see showContextMenu).
  await listen("context-pick", (event) => {
    if (contextMenu?.token !== event.payload.token) return;
    const action = contextMenu.actions.get(event.payload.id);
    contextMenu = null;
    action?.();
  });
  // A tab started or stopped playing sound, or was (un)muted.
  await listen("tab-audio", (event) => {
    const tab = findTab(event.payload.id);
    if (!tab) return;
    tab.audible = !!event.payload.playing;
    tab.muted = !!event.payload.muted;
    renderTabs();
  });
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
    renderBookmarksBar();
  });

  // Only now, with every listener above in place, does this window open its
  // tabs -- a fast page can report its title before an earlier listener
  // would even exist. A new window opens what it was made for -- your last
  // session's tabs, tabs moved in from another window, a link. A reload
  // after the toolbar's process died (the window's plan was used up the
  // first time) picks up the tabs that are still running instead. Otherwise:
  // the start page.
  let restored = await openWindowInit(await invoke("take_window_init").catch(() => null));
  if (!restored) restored = await restoreAfterToolbarReload();
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
