// Toolbar webview: renders the left icon rail (Opera-GX style) and the top
// tab-strip/nav-bar chrome. Talks to Rust exclusively through invoke() --
// it never touches a content webview directly. Rail icons open a slide-out
// side panel (a real webview Rust positions beside the active tab) rather
// than a new tab -- see toggleSidePanel below and side_panel commands in
// src-tauri/src/main.rs.
import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { ENGINES, resolveInput, toast, hostOf } from "./shared/api.js";
import { siteIcon, injectRefractionFilter, writeChromeGeometry, watchCustomWallpaper, rememberSiteFavicon, sharePageStorage } from "./shared/glass.js";
import { avatarHtml, accountName } from "./shared/accounts.js";

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

// Rust's tab order (what a reloaded toolbar rebuilds its strip from) follows
// the strip's. Sleeping placeholders have no real (u32) id to send.
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
  iconFor("autofill-btn", icon("key", 15));
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
    const title = tab.title || INTERNAL_TITLES[tab.url] || hostOf(tab.url);
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

function showTabContextMenu(tab, x, y) {
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
  updateAccountButton();
  updateAutofillButton();
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

// --- Saved login offer (address bar key) ------------------------------------
// When a page shows a login form and the vault has a login for its site,
// Rust says so ("autofill-offer", with just the username). Clicking the key
// has Rust fill the form in -- the password never passes through here, and a
// page can't press this button.

const autofillOffers = new Map(); // tab id -> username

function updateAutofillButton() {
  const btn = document.getElementById("autofill-btn");
  const username = autofillOffers.get(activeTabId);
  btn.hidden = username === undefined;
  btn.title = `Fill in your saved login${username ? ` (${username})` : ""}`;
}

async function fillSavedLogin() {
  const id = activeTabId;
  try {
    await invoke("autofill_tab", { id });
    toast("Filled in your saved login");
  } catch (err) {
    toast(String(err));
  }
}

// --- Keyboard shortcuts -------------------------------------------------------

// The shortcut a key press in the toolbar means. Ctrl without Alt only
// (AltGr is Ctrl+Alt); the same set Rust catches in pages (page_shortcut).
function shortcutFor(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "t") return e.shiftKey ? "reopen-tab" : "new-tab";
  if (key === "l") return e.shiftKey ? "passwords" : "focus-address";
  if (e.key === "Tab") return e.shiftKey ? "prev-tab" : "next-tab";
  if (e.shiftKey) return null;
  if (key === "w") return "close-tab";
  if (key === "d") return "bookmark";
  if (/^[1-8]$/.test(e.key)) return `tab-${e.key}`;
  if (e.key === "9") return "last-tab";
  return null;
}

// Tab switching goes by the strip itself -- sleeping tabs and folded groups
// included -- like in any browser.
function runShortcut(action) {
  const index = tabs.findIndex((t) => t.id === activeTabId);
  const nth = /^tab-(\d)$/.exec(action);
  if (nth) {
    const tab = tabs[Number(nth[1]) - 1];
    if (tab) activateTab(tab.id);
    return;
  }
  switch (action) {
    case "new-tab":
      createTab();
      break;
    case "close-tab":
      if (activeTabId) closeTab(activeTabId);
      break;
    case "reopen-tab":
      invoke("reopen_closed_tab").then((id) => { if (id != null) toast("Reopened closed tab"); });
      break;
    case "focus-address": {
      const input = document.getElementById("url-input");
      input.focus();
      input.select();
      break;
    }
    case "bookmark":
      toggleBookmark();
      break;
    case "passwords":
      toggleSidePanel("passwords", "kessel://passwords");
      break;
    case "next-tab":
    case "prev-tab":
      if (tabs.length) {
        const step = action === "next-tab" ? 1 : -1;
        activateTab(tabs[(index + step + tabs.length) % tabs.length].id);
      }
      break;
    case "last-tab":
      if (tabs.length) activateTab(tabs[tabs.length - 1].id);
      break;
  }
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
  return id;
}

// Adds a tab entry with NO webview behind it yet -- used for session-restore
// tabs you aren't looking at right now. Costs nothing until you click it.
function addPlaceholderTab(url, account = null) {
  const id = nextPlaceholderId();
  tabs.push({
    id,
    url,
    account: accountById(account)?.id ?? null,
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
  autofillOffers.delete(id);
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
  const saved = tabs
    .filter((t) => t.url && (t.url.startsWith("http") || t.url.startsWith("kessel://")) && !SINGLETON_ROUTES.has(t.url))
    .map((t) => ({ url: t.url, account: t.account ?? null }));
  invoke("save_session", { tabs: saved }).catch(() => {});
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
    const saved = await invoke("get_session").catch(() => []);
    if (saved && saved.length) {
      await createTab(saved[0].url, saved[0].account);
      for (let i = 1; i < saved.length; i++) addPlaceholderTab(saved[i].url, saved[i].account);
      normalizeGroups();
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
  document.getElementById("account-btn").addEventListener("click", toggleAccountsPopup);
  document.getElementById("autofill-btn").addEventListener("click", fillSavedLogin);
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

  // Keyboard shortcuts while focus is inside this toolbar webview. From
  // inside a page, Rust catches the same keys (WebView2's accelerator keys)
  // and forwards them as "page-shortcut".
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const action = shortcutFor(e);
    if (action) {
      e.preventDefault();
      runShortcut(action);
      return;
    }
    if (e.key === "F5" || (mod && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      if (activeTabId) invoke("reload", { id: activeTabId });
      return;
    }
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); if (activeTabId) invoke("go_back", { id: activeTabId }); return; }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); if (activeTabId) invoke("go_forward", { id: activeTabId }); return; }
    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      invoke("close_side_panel").then(() => {
        openPanelKind = null;
        updatePanelHighlights();
      });
      return;
    }
  });
  await listen("page-shortcut", (event) => runShortcut(event.payload));

  await listen("autofill-offer", (event) => {
    const { id, username } = event.payload;
    autofillOffers.set(id, username);
    if (id === activeTabId) updateAutofillButton();
  });

  // --- Backend events ----------------------------------------------------

  await listen("tab-navigated", (event) => {
    // Rust only emits this for genuine external http(s) navigation --
    // internal kessel://... pages are filtered out on the Rust side (see
    // on_navigation in main.rs), so whatever we track here is real.
    const { id, url } = event.payload;
    shieldsStats.delete(id); // a new page starts counting from zero
    autofillOffers.delete(id); // ...and has its own login form, if any
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
    const { id, url, activate, account = null } = event.payload;
    if (!findTab(id)) {
      insertTab({ id, url, title: INTERNAL_TITLES[url] || hostOf(url), account, justCreated: true, loading: false, lastActiveAt: Date.now() });
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
