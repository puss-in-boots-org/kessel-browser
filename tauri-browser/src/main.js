// Toolbar webview: renders the left icon rail (Opera-GX style) and the top
// tab-strip/nav-bar chrome. Talks to Rust exclusively through invoke() --
// it never touches a content webview directly. Rail icons open a slide-out
// side panel (a real webview Rust positions beside the active tab) rather
// than a new tab -- see toggleSidePanel below and side_panel commands in
// src-tauri/src/main.rs.
import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { ENGINES, resolveInput, looksLikeUrl, toast, hostOf, listenHere, internalTitle, internalPageKey, escapeHtml, keyLabel, confirmDialog } from "./shared/api.js";
import { siteIcon, injectRefractionFilter, writeChromeGeometry, watchCustomWallpaper, rememberSiteFavicon, sharePageStorage } from "./shared/glass.js";
import { avatarHtml, accountName } from "./shared/accounts.js";
import { setupOmnibox } from "./omnibox.js";
import { resolveTyped, allEngines, engineById } from "./shared/search.js";
import { cleanLink } from "./shared/links.js";
import { playUiSound } from "./shared/sounds.js";
import { RAIL_ITEMS, DEFAULT_RAIL_ITEMS, aiTarget, aiPrompt, WORKSPACE_COLORS } from "./shared/sidebar-panels.js";

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
// lifecycleTick), or (neverCreated: true) they're a restored-session
// tab that was never actually opened yet, since eagerly recreating every
// webview from your last session on launch is exactly the kind of memory
// waste this whole thing is meant to avoid.
let tabs = [];
let activeTabId = null;
let bookmarks = [];
let bookmarkFolders = []; // [{ id, title, parent }] -- see bookmarks.rs
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
      group: groupOf(t)?.id ?? null,
      frozen: !!t.frozen,
      attention: !!t.attention,
      memory: t.memory ?? null,
      cpu: t.cpu ?? null,
    })),
  groups: () => [...tabGroups.values()],
  // Lifecycle: pretend tab `id` was last looked at `minutes` ago, then run
  // the check that freezes / puts tabs to sleep.
  age: (id, minutes) => {
    const tab = findTab(id);
    if (tab) tab.lastActiveAt = Date.now() - minutes * 60 * 1000;
  },
  tick: () => lifecycleTick(),
  pollResources: () => pollTabResources(),
  hover: (id) => {
    hoverTab = id;
    return showHoverCard(id);
  },
  unhover: () => hideHoverCard(),
  renameGroup: (id, name) => {
    groupEdit = null;
    const g = tabGroups.get(id);
    if (g) g.name = name;
    renderTabs();
    persistSession();
  },
  // The group whose name is being typed, and what's typed so far.
  groupEdit: () => groupEdit && { id: groupEdit.id, value: groupEdit.value },
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
// dragged tab can't leave its account's group, or split one: it can't
// change which account it's signed in as) -- and every tab group's tabs
// together (a group's tabs are all of one account).
function normalizeGroups() {
  for (const t of tabs) if (t.pinned) t.group = null; // pinned tabs aren't grouped
  const together = (list, key) => {
    const out = [];
    const seen = new Set();
    for (const t of list) {
      const k = key(t);
      if (!k) out.push(t);
      else if (!seen.has(k)) {
        seen.add(k);
        out.push(...list.filter((x) => key(x) === k));
      }
    }
    return out;
  };
  const rest = tabs.filter((t) => !t.pinned);
  tabs = [...tabs.filter((t) => t.pinned), ...together(together(rest, (t) => t.account), (t) => t.group)];
}

// --- Tab groups --------------------------------------------------------------------
// Named, coloured groups of tabs you make (right-click a tab): shown as a
// label in the strip, folded with a click, kept with the session, and --
// saved -- on the bookmarks bar to open again later. Separate from an
// account's tabs (see groupChip), though a group's tabs are all of one
// account.

// id -> { id, name, color, collapsed, site? } (`site`: made by grouping tabs
// by site, which new tabs of that site join).
const tabGroups = new Map();
let savedGroups = []; // [{ id, name, color, tabs: [{ url, title }] }] (store.rs)

const GROUP_COLORS = {
  grey: ["Grey", "#9aa0a6"],
  blue: ["Blue", "#5b8def"],
  red: ["Red", "#ef5b5b"],
  yellow: ["Yellow", "#f2c14e"],
  green: ["Green", "#4fbf7f"],
  pink: ["Pink", "#f06ab0"],
  purple: ["Purple", "#a878f0"],
  cyan: ["Cyan", "#3fc5d4"],
  orange: ["Orange", "#f59a42"],
};

function groupColor(group) {
  return (GROUP_COLORS[group?.color] || GROUP_COLORS.grey)[1];
}

function groupOf(tab) {
  return (tab?.group && tabGroups.get(tab.group)) || null;
}

// The first colour no open group uses (then round again) -- grey last.
function nextGroupColor() {
  const used = [...tabGroups.values()].map((g) => g.color);
  const names = [...Object.keys(GROUP_COLORS).filter((c) => c !== "grey"), "grey"];
  return names.find((c) => !used.includes(c)) || names[tabGroups.size % names.length];
}

function newGroupId() {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function groupLabel(group) {
  return group.name ? `“${group.name}”` : `${GROUP_COLORS[group.color]?.[0] || "Grey"} group`;
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

// A tab group's label in the strip: its name in its colour (a coloured dot
// when unnamed). Click folds or unfolds it, double-click renames it,
// right-click has everything else.
function userGroupChip(group) {
  const members = tabs.filter((t) => t.group === group.id);
  const chip = document.createElement("div");
  chip.className = "tab-group user-group" + (group.collapsed ? " collapsed" : "") + (group.name ? "" : " unnamed");
  chip.dataset.userGroup = group.id;
  chip.style.setProperty("--acct", groupColor(group));
  chip.textContent = group.collapsed ? `${group.name}${group.name ? " · " : ""}${members.length}` : group.name;
  const saved = savedGroups.some((g) => g.id === group.id);
  chip.title = `${group.name || "Unnamed group"}: ${members.length} tab${members.length === 1 ? "" : "s"}${saved ? " (saved)" : ""}.\nClick to ${group.collapsed ? "expand" : "collapse"}, double-click to rename, right-click for more.`;
  chip.addEventListener("click", (e) => {
    if (e.target.closest("input")) return;
    toggleGroupCollapsed(group);
  });
  chip.addEventListener("dblclick", (e) => {
    e.preventDefault();
    renameGroupInline(group.id);
  });
  chip.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (groupEdit) return;
    showContextMenu(groupMenuItems(group), e.clientX, e.clientY);
  });
  if (groupEdit?.id === group.id) groupNameEditor(chip);
  return chip;
}

// Folds or unfolds a group. Folding the group of the tab you're on moves
// you to the nearest tab outside it (if there is one), like Chrome.
async function toggleGroupCollapsed(group, collapsed = !group.collapsed) {
  group.collapsed = collapsed;
  const active = findTab(activeTabId);
  if (collapsed && active?.group === group.id) {
    const at = tabs.indexOf(active);
    const outside = (t) => t.group !== group.id && !isHiddenInGroup(t);
    const next = tabs.slice(at + 1).find(outside) ?? tabs.slice(0, at).reverse().find(outside);
    if (next) await activateTab(next.id);
  }
  renderTabs();
  persistSession();
}

function groupMenuItems(group) {
  const members = tabs.filter((t) => t.group === group.id);
  const saved = savedGroups.some((g) => g.id === group.id);
  return [
    { header: group.name || "Unnamed group" },
    { label: "Rename group", iconName: "edit", action: () => renameGroupInline(group.id) },
    ...Object.entries(GROUP_COLORS).map(([key, [name, color]]) => ({ label: name, swatch: color, checked: group.color === key, action: () => setGroupColor(group, key) })),
    "-",
    { label: "New tab in group", iconName: "plus", action: () => createTab(undefined, members[0]?.account ?? null, { after: members[members.length - 1], group: group.id }) },
    { label: group.collapsed ? "Expand group" : "Collapse group", iconName: group.collapsed ? "expand" : "minus", action: () => toggleGroupCollapsed(group) },
    { label: saved ? "Saved -- forget it" : "Save group", iconName: saved ? "trash" : "bookmark", disabled: !!WIN.private, action: () => (saved ? forgetSavedGroup(group.id) : saveGroup(group)) },
    { label: "Move group to new window", iconName: "popOut", disabled: members.length >= tabs.length, action: () => moveTabsToNewWindow(members) },
    "-",
    { label: "Ungroup", iconName: "ungroup", action: () => ungroup(group) },
    { label: "Close group", iconName: "close", danger: true, action: () => closeTabs(members) },
  ];
}

function setGroupColor(group, color) {
  group.color = color;
  renderTabs();
  persistSession();
}

// Puts `list` (all of one account; pinned tabs are left out) in a new group
// and lets you name it.
function createGroup(list, { name = "", site = null, rename = true } = {}) {
  const members = list.filter((t) => !t.pinned && (t.account ?? null) === (list[0].account ?? null));
  if (!members.length) return null;
  const group = { id: newGroupId(), name, color: nextGroupColor(), collapsed: false, ...(site ? { site } : {}) };
  tabGroups.set(group.id, group);
  for (const t of members) t.group = group.id;
  normalizeGroups();
  clearSelection();
  syncTabOrder();
  renderTabs();
  persistSession();
  if (rename) renameGroupInline(group.id);
  return group;
}

function addToGroup(list, group) {
  const account = tabs.find((t) => t.group === group.id)?.account ?? null;
  const members = list.filter((t) => !t.pinned && (t.account ?? null) === account);
  for (const t of members) t.group = group.id;
  // They join at the end of the group.
  const rest = tabs.filter((t) => !members.includes(t));
  const last = rest.map((t) => t.group).lastIndexOf(group.id);
  rest.splice(last + 1, 0, ...members);
  tabs = rest;
  normalizeGroups();
  clearSelection();
  syncTabOrder();
  renderTabs();
  persistSession();
}

// Takes `list` out of their groups: each goes just after its group.
function removeFromGroup(list) {
  for (const t of list) {
    const group = t.group;
    if (!group) continue;
    t.group = null;
    const rest = tabs.filter((x) => x !== t);
    const last = rest.map((x) => x.group).lastIndexOf(group);
    if (last >= 0) {
      rest.splice(last + 1, 0, t);
      tabs = rest;
    }
  }
  normalizeGroups();
  clearSelection();
  syncTabOrder();
  renderTabs();
  persistSession();
}

function ungroup(group) {
  for (const t of tabs) if (t.group === group.id) t.group = null;
  tabGroups.delete(group.id);
  renderTabs();
  persistSession();
}

// Types a new name for a group right in its label. The strip redraws often
// (a tab loading, a title changing), so what's typed so far -- and where
// the cursor is -- lives here and each redraw puts the box back as it was.
let groupEdit = null; // { id, value, start, end, fresh } while typing a name

function renameGroupInline(id) {
  const group = tabGroups.get(id);
  if (!group) return;
  group.collapsed = false;
  groupEdit = { id, value: group.name, start: 0, end: group.name.length, fresh: true };
  invoke("focus_webview").catch(() => {});
  renderTabs();
}

function finishGroupEdit(keep) {
  const edit = groupEdit;
  if (!edit) return;
  groupEdit = null;
  const group = tabGroups.get(edit.id);
  if (keep && group) group.name = edit.value.trim();
  renderTabs();
  persistSession();
}

// The name box inside group `group`'s label (see userGroupChip).
function groupNameEditor(chip) {
  const edit = groupEdit;
  chip.classList.add("editing");
  chip.textContent = "";
  const input = document.createElement("input");
  input.className = "group-name-input";
  input.value = edit.value;
  input.placeholder = "Name this group";
  input.maxLength = 40;
  input.spellcheck = false;
  const remember = () => {
    edit.value = input.value;
    edit.start = input.selectionStart ?? input.value.length;
    edit.end = input.selectionEnd ?? input.value.length;
  };
  input.addEventListener("input", remember);
  input.addEventListener("keyup", remember);
  input.addEventListener("mouseup", remember);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finishGroupEdit(true);
    else if (e.key === "Escape") finishGroupEdit(false);
  });
  // Clicked away: done. (A redraw replacing this box isn't that.)
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (groupEdit === edit && !document.querySelector(".group-name-input:focus")) finishGroupEdit(true);
    }, 0);
  });
  chip.appendChild(input);
  queueMicrotask(() => {
    if (!input.isConnected || groupEdit !== edit) return;
    input.focus();
    if (edit.fresh) {
      input.select();
      edit.fresh = false;
    } else {
      input.setSelectionRange(edit.start, edit.end);
    }
  });
}

// Groups tabs from the same site (at least two) -- joining a group made
// this way for that site if there is one.
function groupTabsBySite() {
  const bySite = new Map();
  for (const t of tabs) {
    if (t.pinned || t.group || !/^https?:/.test(t.url || "")) continue;
    const key = siteKey(t);
    if (!bySite.has(key)) bySite.set(key, []);
    bySite.get(key).push(t);
  }
  let made = 0;
  for (const [key, list] of bySite) {
    const existing = [...tabGroups.values()].find((g) => g.site === key);
    if (existing) addToGroup(list, existing);
    else if (list.length >= 2) {
      createGroup(list, { name: siteName(list[0].url), site: key, rename: false });
      made++;
    }
  }
  return made;
}

// The site a tab belongs to for grouping, per account.
function siteKey(tab) {
  return `${tab.account ?? ""}|${hostOf(tab.url).replace(/^m\./, "")}`;
}

// "github.com" -> "GitHub"-ish: the site's name without www. and the ending.
function siteName(url) {
  const host = hostOf(url).replace(/^m\./, "");
  const parts = host.split(".");
  const name = parts.length > 1 ? parts[parts.length - 2] : host;
  return /^\d+$/.test(name) ? host : name.charAt(0).toUpperCase() + name.slice(1);
}

// With "Group tabs from the same site" on: a tab that went to a site joins
// that site's group, or starts one with another tab of the site. One that
// left its site-group's site leaves the group.
function autoGroupTab(tab) {
  if (!currentSettings()?.auto_group_tabs || !tab || tab.pinned || !/^https?:/.test(tab.url || "")) return;
  const key = siteKey(tab);
  const own = groupOf(tab);
  if (own?.site && own.site !== key) removeFromGroup([tab]);
  if (tab.group) return;
  const existing = [...tabGroups.values()].find((g) => g.site === key);
  if (existing) return addToGroup([tab], existing);
  const partner = tabs.find((t) => t !== tab && !t.pinned && !t.group && /^https?:/.test(t.url || "") && siteKey(t) === key);
  if (partner) createGroup([partner, tab], { name: siteName(tab.url), site: key, rename: false });
}

// --- Saved groups -------------------------------------------------------------

async function saveGroup(group, { quiet = false } = {}) {
  const members = tabs.filter((t) => t.group === group.id && t.url);
  try {
    await invoke("save_tab_group", { group: { id: group.id, name: group.name, color: group.color, tabs: members.map((t) => ({ url: t.url, title: t.userTitled ? t.title : "" })) } });
    if (!quiet) toast(`Saved ${groupLabel(group)} -- it's on the bookmarks bar`);
  } catch (err) {
    if (!quiet) toast(String(err));
  }
}

async function forgetSavedGroup(id) {
  await invoke("delete_saved_group", { id }).catch((err) => toast(String(err)));
}

// A saved group whose tabs changed is saved again (debounced with the
// session), so the saved copy stays the group as it is.
function syncSavedGroups() {
  for (const group of tabGroups.values()) {
    const saved = savedGroups.find((g) => g.id === group.id);
    if (!saved) continue;
    const urls = tabs.filter((t) => t.group === group.id && t.url).map((t) => t.url);
    const changed = saved.name !== group.name || saved.color !== group.color || urls.join("\n") !== saved.tabs.map((t) => t.url).join("\n");
    if (changed && urls.length) saveGroup(group, { quiet: true });
  }
}

// Opens a saved group: shows it if it's open here already, else opens its
// tabs as a group (the first one shown, the rest asleep until clicked).
async function openSavedGroup(saved) {
  const open = tabGroups.get(saved.id);
  const first = tabs.find((t) => t.group === saved.id);
  if (open && first) {
    open.collapsed = false;
    await activateTab(first.id);
    return;
  }
  if (!saved.tabs.length) return;
  const group = { id: saved.id, name: saved.name, color: saved.color, collapsed: false };
  // The group once its first tab exists -- an empty group is dropped at the
  // next redraw, and one can come while the tab is being made.
  const id = await createTab(saved.tabs[0].url, null, { group: group.id });
  tabGroups.set(group.id, group);
  let anchor = findTab(id);
  for (const t of saved.tabs.slice(1)) {
    const placeholder = findTab(addPlaceholderTab(t.url, null, t.title || null, false, group.id));
    moveTabAfter(placeholder, anchor);
    anchor = placeholder;
  }
  normalizeGroups();
  syncTabOrder();
  renderTabs();
  persistSession();
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
  iconFor("tab-search-btn", icon("chevronDown", 15));
  iconFor("tabs-scroll-left", icon("chevronLeft", 14));
  iconFor("tabs-scroll-right", icon("chevronRight", 14));
  iconFor("engine-btn", icon("chevronDown", 13));
  iconFor("star-btn", icon("star", 16));
  iconFor("shields-btn", icon("shieldCheck", 16));
  iconFor("menu-btn", icon("dotsV", 18));
  iconFor("media-btn", icon("music", 17));
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
      // Double-click on the strip's empty space: maximize (as set in
      // Settings -> Tabs), or a new tab like Chrome.
      const action = currentSettings()?.strip_double_click || "maximize";
      if (action === "maximize") appWindow.toggleMaximize();
      else if (action === "new-tab") createTab();
      return;
    }
    appWindow.startDragging();
  });
  // Middle-click there: a new tab or the last closed one, if you want.
  tabBar.addEventListener("auxclick", (e) => {
    if (e.button !== 1 || !isDragSurface(e.target)) return;
    const action = currentSettings()?.strip_middle_click || "none";
    if (action === "new-tab") createTab();
    else if (action === "reopen") reopenClosed();
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
let reportedStrip = "";

function reportChromeInsets() {
  // Vertical tabs sit between the rail and the page.
  const vtabs = document.getElementById("vtabs");
  const left = Math.ceil((vtabs.hidden ? document.getElementById("rail") : vtabs).getBoundingClientRect().right);
  const bm = document.getElementById("bookmarks-bar");
  const lastChrome = bm.hidden ? document.getElementById("nav-bar") : bm;
  const top = Math.ceil(lastChrome.getBoundingClientRect().bottom);
  writeChromeGeometry({ left, top, w: window.innerWidth, h: window.innerHeight });
  // Where the tab strip is, for windows dragged onto it (tabdrag.rs).
  const strip = document.getElementById(vtabs.hidden ? "tab-bar" : "vtabs").getBoundingClientRect();
  const stripKey = `${strip.left}|${strip.top}|${strip.right}|${strip.bottom}`;
  if (stripKey !== reportedStrip) {
    reportedStrip = stripKey;
    invoke("set_tab_strip", { left: strip.left, top: strip.top, right: strip.right, bottom: strip.bottom }).catch(() => {});
  }
  layoutSplitDivider();
  if (left === reportedInsets.left && top === reportedInsets.top) return Promise.resolve();
  reportedInsets = { left, top };
  return invoke("set_chrome_insets", { left, top }).catch(() => {});
}

function wireChromeInsets() {
  const observer = new ResizeObserver(() => reportChromeInsets());
  for (const id of ["rail", "vtabs", "tab-bar", "nav-bar", "bookmarks-bar"]) {
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
      tabs: tabs.map(({ id, url, title, favicon, discarded, neverCreated, userTitled, account, pinned, muted, group, audible, frozen }) => ({ id, url, title, favicon, discarded, neverCreated, userTitled, account, pinned, muted, group: group ?? null, audible, frozen })),
      groups: [...tabGroups.values()],
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
  for (const g of snapshot?.groups || []) tabGroups.set(g.id, { ...g });
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

// --- The tab strip ------------------------------------------------------------------
// Redrawn by reconciling: each tab keeps its element from one redraw to the
// next and only what changed on it is touched, so a title, spinner or icon
// updating doesn't rebuild the strip -- hover states, animations and a drag
// in progress survive, and a strip of a hundred tabs redraws in well under a
// millisecond. Group labels are small and made afresh each time. Clicks,
// right-clicks and presses are handled once, on the strip (wireTabStrip).

const tabEls = new Map(); // tab id -> its element
let lastScrolledTo = null;

// The workspace buttons show how many tabs each has: redrawn when a count
// changes.
let workspaceCountsKey = "";
function noteWorkspaceCounts() {
  const key = `${currentWorkspace}|${tabs.length}|${[...parkedWorkspaces].map(([id, p]) => `${id}:${p.tabs.length}`).join()}`;
  if (key === workspaceCountsKey) return;
  workspaceCountsKey = key;
  renderWorkspaces();
}

function renderTabs() {
  pushToolbarSnapshot();
  noteWorkspaceCounts();
  updateMediaButton();
  // Mid-drag the strip belongs to the drag; it's redrawn when that ends.
  if (drag) {
    drag.redraw = true;
    return;
  }
  const container = document.getElementById("tabs");
  for (const id of selectedTabs) if (!findTab(id) || id === activeTabId) selectedTabs.delete(id);
  for (const id of [...tabGroups.keys()]) if (!tabs.some((t) => t.group === id)) tabGroups.delete(id); // emptied
  const wanted = [];
  const seen = new Set();
  let prevGroup = null;
  let prevUserGroup = null;
  tabs.forEach((tab, i) => {
    // An account's tabs: a labelled chip in front, its colour on each tab,
    // and (folded) only the chip -- plus the active tab if it's in there.
    // Pinned tabs sit in front of everything, small, without a chip.
    const account = accountById(tab.account);
    const grouped = account && !tab.pinned;
    if (grouped && account.id !== prevGroup) wanted.push(groupChip(account));
    prevGroup = grouped ? account.id : null;
    if (grouped && collapsedGroups.has(account.id) && tab.id !== activeTabId) return;
    // A tab group: its label first, a line in its colour under its tabs.
    const group = groupOf(tab);
    if (group && group.id !== prevUserGroup) wanted.push(userGroupChip(group));
    prevUserGroup = group?.id ?? null;
    if (group?.collapsed && tab.id !== activeTabId) return;
    seen.add(tab.id);
    wanted.push(tabElement(tab, account, group, !!group && tabs[i + 1]?.group !== group.id));
  });
  for (const [id, el] of tabEls) {
    if (!seen.has(id)) {
      tabEls.delete(id);
      retireTab(el);
    }
  }
  for (const el of [...container.children]) if (!el.dataset.tabId && !el.classList.contains("closing")) el.remove(); // the last redraw's labels
  // In order, moving only what's out of place (closing tabs keep theirs
  // until they've shrunk away).
  let cursor = container.firstElementChild;
  for (const el of wanted) {
    while (cursor && cursor.classList.contains("closing")) cursor = cursor.nextElementSibling;
    if (cursor === el) cursor = cursor.nextElementSibling;
    else container.insertBefore(el, cursor);
  }
  // The tab you're on stays in view in a strip too full to show every tab.
  const scrollKey = `${activeTabId}|${tabs.length}|${isVerticalTabs()}`;
  if (scrollKey !== lastScrolledTo) {
    lastScrolledTo = scrollKey;
    scrollActivePending = true;
  }
  markSplit();
  scheduleStripOverflow();
}

function setStyleVar(el, name, value) {
  if (!value) el.style.removeProperty(name);
  else if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

// Tab `tab`'s element, made the first time and brought up to date after.
function tabElement(tab, account, group, lastInGroup) {
  let el = tabEls.get(tab.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "tab";
    el.dataset.tabId = String(tab.id);
    el.innerHTML = `<span class="tab-favicon"></span><span class="tab-title"></span>`;
    wireHoverCard(el);
    tabEls.set(tab.id, el);
    if (tab.justCreated) {
      el.classList.add("tab-enter");
      el.addEventListener("animationend", () => el.classList.remove("tab-enter"), { once: true });
    }
  }
  tab.justCreated = false;
  const c = el.classList;
  c.toggle("active", tab.id === activeTabId);
  c.toggle("selected", selectedTabs.has(tab.id));
  c.toggle("pinned", !!tab.pinned);
  c.toggle("discarded", !!tab.discarded);
  c.toggle("frozen", !!tab.frozen);
  c.toggle("attention", !!tab.attention);
  c.toggle("heavy", isHeavy(tab));
  c.toggle("grouped", !!account);
  c.toggle("in-group", !!group);
  c.toggle("group-end", !!lastInGroup);
  setStyleVar(el, "--acct", account?.color);
  setStyleVar(el, "--group", group ? groupColor(group) : null);
  // The full title on hover -- the strip truncates it (hover cards say
  // more, when they're on).
  const tip = currentSettings()?.tab_hover_cards !== false ? null : tab.discarded ? `${tab.title || ""}\nSleeping to save memory -- click to wake it up`.trim() : tab.title || "";
  if (tip === null) el.removeAttribute("title");
  else if (el.title !== tip) el.title = tip;
  const iconKey = tab.loading ? "loading" : tab.favicon ? `img ${tab.favicon}` : `${tab.url || ""}`;
  if (el._icon !== iconKey) {
    el._icon = iconKey;
    const fav = el.firstElementChild;
    fav.classList.toggle("loading", !!tab.loading);
    fav.innerHTML = tab.loading ? icon("reload", 11) : faviconGlyph(tab);
  }
  const text = tab.title || (tab.url ? hostOf(tab.url) : "New Tab");
  const title = el.children[1];
  if (title.textContent !== text) title.textContent = text;
  // The rest -- group line, speaker, close button -- only redone when what
  // it holds changes.
  const tail = `${group ? "g" : ""}|${tab.muted ? "m" : tab.audible ? "a" : ""}|${tab.pinned ? "" : "x"}`;
  if (el._tail !== tail) {
    el._tail = tail;
    while (el.children.length > 2) el.lastElementChild.remove();
    if (group) el.insertAdjacentHTML("beforeend", `<span class="group-line"></span>`);
    if (tab.audible || tab.muted) {
      el.insertAdjacentHTML("beforeend", `<span class="tab-audio${tab.muted ? " muted" : ""}" title="${tab.muted ? "Unmute this tab" : "Mute this tab"}">${icon(tab.muted ? "volumeOff" : "volume", 13)}</span>`);
    }
    if (!tab.pinned) el.insertAdjacentHTML("beforeend", `<span class="close-tab">${icon("close", 12)}</span>`);
  }
  return el;
}

// A tab that left the strip shrinks away (a sideways strip only; it just
// goes when motion is reduced or the strip runs down the side).
function retireTab(el) {
  if (!el.isConnected || isVerticalTabs() || document.documentElement.classList.contains("reduce-motion") || drag) {
    el.remove();
    return;
  }
  el.style.maxWidth = `${el.getBoundingClientRect().width}px`;
  el.classList.add("closing");
  el.offsetWidth; // start from its width
  el.classList.add("shrink");
  const done = () => el.remove();
  el.addEventListener("transitionend", done, { once: true });
  setTimeout(done, 400);
}

// Scrolls the strip just enough to show tab element `el` -- from its layout
// position, not its box on screen, which a tab still popping in (scaled
// down) would get wrong.
function revealTab(el) {
  if (!el) return;
  const strip = document.getElementById("tabs");
  const vertical = isVerticalTabs();
  const start = vertical ? el.offsetTop : el.offsetLeft;
  const size = vertical ? el.offsetHeight : el.offsetWidth;
  const view = vertical ? strip.clientHeight : strip.clientWidth;
  const pos = vertical ? strip.scrollTop : strip.scrollLeft;
  const next = start < pos ? start : start + size > pos + view ? start + size - view : pos;
  if (next === pos) return;
  if (vertical) strip.scrollTop = next;
  else strip.scrollLeft = next;
}

let overflowFrame = 0;
let scrollActivePending = false;
function scheduleStripOverflow() {
  if (!overflowFrame) {
    overflowFrame = requestAnimationFrame(() => {
      overflowFrame = 0;
      updateStripOverflow();
      // After the tabs have their sizes: the one you're on in view.
      if (scrollActivePending) {
        scrollActivePending = false;
        revealTab(tabEls.get(activeTabId));
      }
    });
  }
}

function tabFromEvent(e) {
  const el = e.target.closest?.(".tab");
  return el && !el.classList.contains("closing") ? findTab(parseInt(el.dataset.tabId, 10)) : null;
}

function wireTabStrip() {
  const strip = document.getElementById("tabs");
  // A drag that just ended isn't a click.
  strip.addEventListener(
    "click",
    (e) => {
      if (performance.now() < suppressClickUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
  strip.addEventListener("click", (e) => {
    const tab = tabFromEvent(e);
    if (!tab) return;
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
    } else if (tab.id !== activeTabId) {
      activateTab(tab.id);
    }
  });
  strip.addEventListener("auxclick", (e) => {
    const tab = e.button === 1 && tabFromEvent(e);
    if (!tab) return;
    e.preventDefault();
    e.stopPropagation();
    closeTab(tab.id);
  });
  strip.addEventListener("contextmenu", (e) => {
    const tab = tabFromEvent(e);
    if (!tab) return;
    e.preventDefault();
    hideHoverCard();
    showTabContextMenu(tab, e.clientX, e.clientY);
  });
  strip.addEventListener("pointerdown", onStripPointerDown);
  wireExternalDrops();
  wireSplitDivider();
}

// --- Dragging tabs and groups ---------------------------------------------------------
// A tab (with any others picked alongside it), a group's label (the whole
// group) or an account's label (its tabs) follows the pointer, and the rest
// of the strip slides aside to show where it will land. Pulled out of the
// strip it leaves in a window of its own that keeps following the pointer --
// let go over another window's strip, it joins that one (tabdrag.rs). Held
// at the page's left or right edge, it opens beside the tab you're on
// (split view). Ctrl held when letting go copies instead of moving.

const DRAG_THRESHOLD = 5;
const DETACH_DISTANCE = 44;
let press = null; // a press that isn't a drag (yet)
let drag = null;
let suppressClickUntil = 0;

function onStripPointerDown(e) {
  if (e.button !== 0 || groupEdit || e.target.closest(".close-tab, .tab-audio, input")) return;
  const item = e.target.closest(".tab, .tab-group");
  if (!item || item.classList.contains("closing")) return;
  // Like Chrome: a tab comes up as you press it, not when you let go.
  if (item.classList.contains("tab") && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
    const id = parseInt(item.dataset.tabId, 10);
    if (id !== activeTabId && findTab(id)) activateTab(id);
  }
  press = { item, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  window.addEventListener("pointermove", onPressMove);
  window.addEventListener("pointerup", endPress);
  window.addEventListener("pointercancel", endPress);
}

function onPressMove(e) {
  if (!press) return;
  if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < DRAG_THRESHOLD) return;
  const p = press;
  endPress();
  startDrag(p, e);
}

function endPress() {
  press = null;
  window.removeEventListener("pointermove", onPressMove);
  window.removeEventListener("pointerup", endPress);
  window.removeEventListener("pointercancel", endPress);
}

// Several picked tabs travel together: gathered, in strip order, where the
// first of the rest after the one you hold was.
function gatherTabs(list, held) {
  const moving = new Set(list);
  const rest = tabs.filter((t) => !moving.has(t));
  let at = rest.indexOf(tabs.slice(tabs.indexOf(held)).find((t) => !moving.has(t)));
  if (at < 0) at = rest.length;
  rest.splice(at, 0, ...list);
  tabs = rest;
  normalizeGroups();
  renderTabs();
}

function startDrag(p, e) {
  const { item } = p;
  if (!item.isConnected) return;
  hideHoverCard();
  const strip = document.getElementById("tabs");
  let kind;
  let moving;
  let group = null;
  if (item.classList.contains("tab")) {
    const held = findTab(parseInt(item.dataset.tabId, 10));
    if (!held) return;
    kind = "tabs";
    moving = targetsFor(held).filter((t) => !!t.pinned === !!held.pinned && (t.account ?? null) === (held.account ?? null) && !isHiddenInGroup(t));
    if (!moving.includes(held)) moving = [held];
    if (moving.length > 1) gatherTabs(moving, held);
  } else if (item.dataset.userGroup) {
    group = tabGroups.get(item.dataset.userGroup);
    if (!group) return;
    kind = "group";
    moving = tabs.filter((t) => t.group === group.id);
  } else if (item.dataset.group) {
    kind = "account";
    moving = tabs.filter((t) => t.account === item.dataset.group && !t.pinned);
  } else {
    return;
  }
  if (!moving.length) return;
  const vertical = isVerticalTabs();
  const pinnedLane = kind === "tabs" && !!moving[0].pinned;
  const axis = vertical && !pinnedLane ? "y" : "x";
  const ids = new Set(moving.map((t) => t.id));
  const inBlock = (el) =>
    el.dataset.tabId ? ids.has(parseInt(el.dataset.tabId, 10)) : (kind === "group" && el.dataset.userGroup === group.id) || (kind === "account" && el.dataset.group === item.dataset.group);
  const scroll0 = axis === "x" ? strip.scrollLeft : strip.scrollTop;
  const items = [...strip.children]
    .filter((el) => !el.classList.contains("closing") && (!vertical || el.classList.contains("pinned") === pinnedLane))
    .map((el) => {
      const r = el.getBoundingClientRect();
      const tab = el.dataset.tabId ? findTab(parseInt(el.dataset.tabId, 10)) : null;
      const groupAccount = el.dataset.userGroup ? tabs.find((t) => t.group === el.dataset.userGroup)?.account ?? null : null;
      return {
        el,
        start: (axis === "x" ? r.left : r.top) + scroll0,
        size: axis === "x" ? r.width : r.height,
        block: inBlock(el),
        pinned: el.classList.contains("pinned"),
        acct: tab ? (tab.pinned ? null : tab.account ?? null) : el.dataset.group || groupAccount,
        accountChip: !!el.dataset.group,
        grp: tab ? tab.group ?? null : el.dataset.userGroup || null,
      };
    });
  const block = items.filter((m) => m.block);
  if (!block.length) return;
  const others = items.filter((m) => !m.block);
  const blockStart = Math.min(...block.map((m) => m.start));
  const blockEnd = Math.max(...block.map((m) => m.start + m.size));
  const gap = parseFloat(getComputedStyle(strip)[axis === "x" ? "columnGap" : "rowGap"]) || 0;
  const acct = kind === "account" ? item.dataset.group : pinnedLane ? null : moving[0].account ?? null;
  const rules = { kind, pinned: pinnedLane, acct, ownAcct: !!acct && others.some((o) => o.acct === acct && !o.pinned), pinnedBefore: others.filter((o) => o.pinned).length };
  const allowed = [];
  for (let k = 0; k <= others.length; k++) allowed.push(slotAllowed(k, others, rules));
  const first = block[0].el.getBoundingClientRect();
  const index0 = others.filter((o) => o.start < blockStart).length;
  drag = {
    kind,
    group,
    moving,
    ids,
    block,
    others,
    allowed,
    axis,
    vertical,
    index0,
    k: index0,
    blockStart,
    blockSize: blockEnd - blockStart,
    step: blockEnd - blockStart + gap,
    laneStart: Math.min(...items.map((m) => m.start)),
    laneEnd: Math.max(...items.map((m) => m.start + m.size)),
    origin: (axis === "x" ? p.x : p.y) + scroll0,
    // Where the pointer holds the first dragged element (for a new window).
    grab: { x: p.x - first.left, y: p.y - first.top, top: first.top, left: first.left },
    stripRect: strip.getBoundingClientRect(),
    barRect: document.getElementById(vertical ? "vtabs" : "tab-bar").getBoundingClientRect(),
    pointer: { x: e.clientX, y: e.clientY },
    pointerId: p.pointerId,
    frame: 0,
    redraw: false,
    splitSide: null,
    detaching: false,
  };
  try {
    strip.setPointerCapture(p.pointerId);
  } catch {}
  document.documentElement.classList.add("tab-dragging");
  for (const m of block) m.el.classList.add("dragging");
  for (const o of others) o.el.classList.add("drag-shift");
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragCancel);
  window.addEventListener("keydown", onDragKey, true);
  playSound("lift");
  applyDrag();
}

// Whether the dragged block may land before the k-th of the other items.
function slotAllowed(k, others, rules) {
  const left = others[k - 1];
  const right = others[k];
  // Pinned tabs stay among the pinned, the rest after them.
  if (rules.pinned ? k > rules.pinnedBefore : k < rules.pinnedBefore) return false;
  if (rules.pinned) return true;
  const la = left && !left.pinned ? left.acct : null;
  const ra = right ? right.acct : null;
  // An account's tabs stay together: nothing lands inside them, and theirs
  // land nowhere else (never in front of their label).
  if (rules.ownAcct) {
    if (la !== rules.acct && ra !== rules.acct) return false;
    if (right?.accountChip && la !== rules.acct) return false;
  } else if (la && la === ra) {
    return false;
  }
  // A whole group or account doesn't land inside a group.
  if (rules.kind !== "tabs" && left?.grp && left.grp === right?.grp) return false;
  return true;
}

function nearestSlot(d, k) {
  if (d.allowed[k]) return k;
  for (let i = 1; i <= d.others.length; i++) {
    if (d.allowed[k - i]) return k - i;
    if (d.allowed[k + i]) return k + i;
  }
  return d.index0;
}

function onDragMove(e) {
  if (!drag) return;
  drag.pointer = { x: e.clientX, y: e.clientY };
  if (!drag.frame) drag.frame = requestAnimationFrame(applyDrag);
}

function onDragKey(e) {
  if (e.key !== "Escape" || !drag) return;
  e.preventDefault();
  e.stopPropagation();
  cancelDrag();
}

function applyDrag() {
  const d = drag;
  if (!d || d.detaching) return;
  d.frame = 0;
  const strip = document.getElementById("tabs");
  const { x, y } = d.pointer;
  if (leaveStrip(d, x, y)) return;
  const scroll = d.axis === "x" ? strip.scrollLeft : strip.scrollTop;
  const p = (d.axis === "x" ? x : y) + scroll;
  const delta = Math.min(Math.max(p - d.origin, d.laneStart - d.blockStart), d.laneEnd - d.blockStart - d.blockSize);
  // Its leading edge passing a neighbour's middle swaps them (so it can
  // reach either end even though it can't go past the strip's ends).
  const lead = d.blockStart + delta;
  const trail = lead + d.blockSize;
  const mid = (o) => o.start + o.size / 2;
  let k = 0;
  while (k < d.index0 && mid(d.others[k]) <= lead) k++;
  if (k === d.index0) while (k < d.others.length && mid(d.others[k]) < trail) k++;
  k = nearestSlot(d, k);
  const move = d.axis === "x" ? "translateX" : "translateY";
  if (k !== d.k) {
    d.k = k;
    d.others.forEach((o, i) => {
      const shift = i >= k && i < d.index0 ? d.step : i >= d.index0 && i < k ? -d.step : 0;
      o.el.style.transform = shift ? `${move}(${shift}px)` : "";
    });
    previewGroupJoin(d);
  }
  for (const m of d.block) m.el.style.transform = `${move}(${delta}px)`;
  // Near an end of a strip too long to show: it scrolls along.
  const r = d.stripRect;
  const [lo, hi, pos, room] = d.axis === "x" ? [r.left, r.right, x, strip.scrollWidth - strip.clientWidth] : [r.top, r.bottom, y, strip.scrollHeight - strip.clientHeight];
  if (room > 0) {
    const speed = pos < lo + 30 ? -(lo + 30 - pos) * 0.5 : pos > hi - 30 ? (pos - hi + 30) * 0.5 : 0;
    if (speed) {
      if (d.axis === "x") strip.scrollLeft += speed;
      else strip.scrollTop += speed;
      d.frame = requestAnimationFrame(applyDrag);
    }
  }
}

// The group a dragged tab would join where it is now: it shows that group's
// line while held there.
function previewGroupJoin(d) {
  if (d.kind !== "tabs" || d.moving[0].pinned) return;
  const left = d.others[d.k - 1];
  const right = d.others[d.k];
  const joining = left?.grp && left.grp === right?.grp ? tabGroups.get(left.grp) : null;
  for (const m of d.block) {
    const own = groupOf(findTab(parseInt(m.el.dataset.tabId, 10)));
    const shown = joining || own;
    m.el.classList.toggle("in-group", !!shown);
    setStyleVar(m.el, "--group", shown ? groupColor(shown) : null);
  }
}

// Past the strip: beside the page (split view), or out into a window.
// Over the page, a moment's grace before leaving: long enough to carry a
// tab across to an edge -- pulled far down or out of the window, it goes
// at once.
function leaveStrip(d, x, y) {
  const side = splitSideAt(d, x, y);
  if (side !== d.splitSide) setSplitSide(d, side);
  if (side) {
    d.outSince = 0;
    return true;
  }
  const b = d.barRect;
  const outOfWindow = x < -DETACH_DISTANCE || y < -DETACH_DISTANCE || x > innerWidth + DETACH_DISTANCE || y > innerHeight + DETACH_DISTANCE;
  const past = d.vertical ? x - b.right : y - b.bottom;
  if (!outOfWindow && past <= DETACH_DISTANCE) {
    d.outSince = 0;
    return false;
  }
  // Heading sideways (toward an edge, for split view) keeps it in the
  // window; heading down, or stopping, lets it go.
  const dx = x - (d.lastX ?? x);
  const dy = y - (d.lastY ?? y);
  d.lastX = x;
  d.lastY = y;
  d.sideways = (d.sideways ?? 0) * 0.6 + (Math.abs(dx) - Math.abs(dy)) * 0.4;
  const now = performance.now();
  if (!d.outSince || (d.sideways > 1 && !d.vertical)) d.outSince = now;
  if (outOfWindow || past > Math.max(220, (innerHeight - b.bottom) * 0.45) || now - d.outSince > 260) {
    detachDrag(d);
  } else if (!d.frame) {
    d.frame = requestAnimationFrame(applyDrag); // decides again once the grace is up
  }
  return true;
}

// The tab the one you drag would open beside: the tab you're on -- or, when
// that's the one being dragged, the one you were on before.
function splitPartner(tab) {
  const live = (t) => t && t !== tab && t.id > 0 && !t.discarded;
  const active = findTab(activeTabId);
  if (live(active)) return active;
  return recentTabs.map(findTab).find(live) || null;
}

function splitSideAt(d, x, y) {
  if (d.kind !== "tabs" || d.moving.length !== 1 || currentSettings()?.tab_drag_split === false) return null;
  const tab = d.moving[0];
  if (!(tab.id > 0) || tab.discarded || !splitPartner(tab)) return null;
  const left = reportedInsets.left;
  const top = reportedInsets.top;
  if (y < top + 24 || y > innerHeight || x < left || x > innerWidth) return null;
  const zone = Math.max(90, (innerWidth - left) * 0.16);
  if (x > innerWidth - zone) return "right";
  if (!d.vertical && x < left + zone) return "left";
  return null;
}

// Shows (or takes away) where a tab held at a page edge will open: the page
// steps aside and the toolbar underneath shows the spot.
function setSplitSide(d, side) {
  d.splitSide = side;
  const hint = document.getElementById("split-hint");
  invoke("split_preview", { side }).catch(() => {});
  if (!side) {
    hint.hidden = true;
    return;
  }
  const left = reportedInsets.left;
  const half = Math.round((innerWidth - left - SPLIT_GAP) / 2);
  hint.style.top = `${reportedInsets.top}px`;
  hint.style.left = `${side === "right" ? left + half + SPLIT_GAP : left}px`;
  hint.style.width = `${half}px`;
  hint.querySelector(".split-hint-title").textContent = d.moving[0].title || hostOf(d.moving[0].url || "") || "This tab";
  hint.hidden = false;
  playSound("hover");
}

function onDragEnd(e) {
  const d = drag;
  if (!d) return;
  if (d.detaching) return;
  if (d.splitSide) {
    const side = d.splitSide;
    const tab = d.moving[0];
    setSplitSide(d, null);
    restoreDrag(d);
    finishDrag(d);
    openSplit(tab, side);
    return;
  }
  if (d.frame) {
    cancelAnimationFrame(d.frame);
    d.frame = 0;
    applyDrag();
  }
  if (drag === d) commitDrag(d, e.ctrlKey && d.kind === "tabs");
}

function onDragCancel() {
  if (drag && !drag.detaching) cancelDrag();
}

function cancelDrag() {
  const d = drag;
  if (!d) return;
  if (d.splitSide) setSplitSide(d, null);
  restoreDrag(d);
  finishDrag(d);
}

// Everything slides back to where it was.
function restoreDrag(d) {
  for (const m of [...d.others, ...d.block]) {
    m.el.classList.add("drag-shift");
    m.el.style.transform = "";
  }
}

function finishDrag(d) {
  if (d.frame) cancelAnimationFrame(d.frame);
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragCancel);
  window.removeEventListener("keydown", onDragKey, true);
  try {
    document.getElementById("tabs").releasePointerCapture(d.pointerId);
  } catch {}
  document.documentElement.classList.remove("tab-dragging");
  for (const m of d.block) m.el.classList.remove("dragging");
  setTimeout(() => {
    if (!drag) for (const m of [...d.others, ...d.block]) m.el.classList.remove("drag-shift");
  }, 320);
  suppressClickUntil = performance.now() + 60;
  if (drag === d) drag = null;
  if (d.redraw) renderTabs();
}

// Let go in the strip: the block takes its new place (gliding in from where
// it was let go), and the tab list follows.
function commitDrag(d, copy) {
  const strip = document.getElementById("tabs");
  const axisKey = d.axis === "x" ? "left" : "top";
  const move = d.axis === "x" ? "translateX" : "translateY";
  if (copy || d.k === d.index0) {
    restoreDrag(d);
    finishDrag(d);
    if (copy) copyTabsTo(d.moving, d.others[d.k - 1]?.el);
    else playSound("drop");
    return;
  }
  const from = d.block.map((m) => m.el.getBoundingClientRect()[axisKey]);
  const lastOther = d.others[d.others.length - 1]?.el;
  const anchor = d.others[d.k]?.el ?? lastOther?.nextSibling ?? null;
  const root = document.documentElement;
  root.classList.add("tab-settling");
  for (const m of d.block) strip.insertBefore(m.el, anchor);
  for (const m of [...d.others, ...d.block]) m.el.style.transform = "";
  const to = d.block.map((m) => m.el.getBoundingClientRect()[axisKey]);
  d.block.forEach((m, i) => {
    if (Math.abs(from[i] - to[i]) > 0.5) m.el.style.transform = `${move}(${from[i] - to[i]}px)`;
  });
  strip.offsetWidth;
  root.classList.remove("tab-settling");
  for (const m of d.block) m.el.classList.add("drag-shift");
  finishDrag(d);
  requestAnimationFrame(() => {
    for (const m of d.block) m.el.style.transform = "";
  });
  applyStripOrder(d);
  playSound("drop");
}

// The tab list takes the strip's order (a folded group's hidden tabs stay
// right behind its label); a dragged tab dropped between two tabs of a
// group joins it, one dropped away from its own group leaves it.
function applyStripOrder(d) {
  const children = [...document.getElementById("tabs").children].filter((c) => !c.classList.contains("closing"));
  const shown = new Set(children.filter((c) => c.dataset.tabId).map((c) => parseInt(c.dataset.tabId, 10)));
  const order = [];
  for (const c of children) {
    if (c.dataset.group) order.push(...tabs.filter((t) => t.account === c.dataset.group && !t.pinned && !shown.has(t.id)));
    else if (c.dataset.userGroup) order.push(...tabs.filter((t) => t.group === c.dataset.userGroup && !shown.has(t.id)));
    else if (c.dataset.tabId) order.push(findTab(parseInt(c.dataset.tabId, 10)));
  }
  if (d.kind === "tabs" && !d.moving[0].pinned) {
    const els = d.block.map((m) => m.el);
    const groupAt = (node) => node?.dataset.userGroup || (node?.dataset.tabId ? findTab(parseInt(node.dataset.tabId, 10))?.group : null) || null;
    const before = groupAt(els[0].previousElementSibling);
    const nextEl = els[els.length - 1].nextElementSibling;
    const after = nextEl?.dataset.tabId ? groupAt(nextEl) : null;
    const target = before && before === after ? tabGroups.get(before) : null;
    for (const tab of d.moving) {
      if (target && tabs.some((t) => t.group === target.id && !d.ids.has(t.id) && (t.account ?? null) === (tab.account ?? null))) tab.group = target.id;
      else if (tab.group && before !== tab.group && after !== tab.group) tab.group = null;
    }
  }
  tabs = [...order.filter(Boolean), ...tabs.filter((t) => !order.includes(t))];
  normalizeGroups();
  syncTabOrder();
  renderTabs();
  persistSession();
}

// Ctrl+drop: copies of the dragged tabs open where they were let go.
async function copyTabsTo(list, afterEl) {
  let anchor = afterEl?.dataset.tabId ? findTab(parseInt(afterEl.dataset.tabId, 10)) : null;
  for (const t of list.filter((x) => x.url)) {
    const id = await createTab(t.url, t.account ?? null, { after: anchor || undefined, pinned: !!t.pinned });
    anchor = findTab(id);
  }
  toast(list.length === 1 ? "Tab copied" : `${list.length} tabs copied`);
}

// Out of the strip: the dragged tabs leave in a window of their own that
// follows the pointer (or, when they're all this window has, the window
// itself does).
async function detachDrag(d) {
  d.detaching = true;
  if (d.splitSide) setSplitSide(d, null);
  const everything = d.moving.length === tabs.length;
  const s = d.stripRect;
  // The new window's point under the pointer: the first dragged element
  // sits at the start of its strip there, at the same height as here.
  const grabX = d.vertical ? d.grab.left + d.grab.x : s.left + d.grab.x;
  const grabY = d.vertical ? s.top + d.grab.y : d.grab.top + d.grab.y;
  for (const o of d.others) {
    o.el.classList.add("drag-shift");
    o.el.style.transform = "";
  }
  for (const m of d.block) {
    m.el.style.transform = "";
    if (!everything) m.el.style.visibility = "hidden";
  }
  finishDrag(d);
  playSound("detach");
  const live = d.moving.filter((t) => t.id > 0 && !t.discarded);
  const sleeping = d.moving.filter((t) => !(t.id > 0 && !t.discarded) && t.url);
  const groupIds = new Set(d.moving.map((t) => t.group).filter(Boolean));
  try {
    if (everything) {
      await invoke("drag_window");
    } else {
      await invoke("detach_tabs", {
        ids: live.map((t) => t.id),
        sleeping: sleeping.map((t) => ({ url: t.url, account: t.account ?? null, title: t.userTitled ? t.title : null, pinned: !!t.pinned, group: t.group ?? null })),
        pinned: live.filter((t) => t.pinned).map((t) => t.id),
        tabGroups: Object.fromEntries(live.filter((t) => t.group).map((t) => [String(t.id), t.group])),
        groups: [...groupIds].map((id) => tabGroups.get(id)).filter(Boolean),
        grabX,
        grabY,
      });
      for (const t of sleeping) await closeTab(t.id, { remember: false });
    }
  } catch (err) {
    for (const m of d.block) m.el.style.visibility = "";
    toast(`Couldn't move ${tabCount(d.moving.length, "the tab")}: ${err}`);
  }
}

// Tabs moved into this window from another (a window dropped on the strip),
// put in before `beforeTab`: {tabs: [{info} | {sleep}], pinned, tabGroups,
// groups, active}.
function insertMovedTabs(got, beforeTab) {
  const pinnedIds = new Set(got.pinned || []);
  const groupOfId = new Map(Object.entries(got.tabGroups || {}).map(([id, g]) => [Number(id), g]));
  for (const g of got.groups || []) if (g?.id && !tabGroups.has(g.id)) tabGroups.set(g.id, { ...g });
  const incoming = [];
  for (const entry of got.tabs || []) {
    if (entry.info && !findTab(entry.info.id)) {
      const info = entry.info;
      incoming.push({
        id: info.id,
        url: info.url,
        title: info.title || internalTitle(info.url) || hostOf(info.url),
        userTitled: !!info.title,
        favicon: info.favicon ?? null,
        account: info.account ?? null,
        pinned: pinnedIds.has(info.id),
        group: pinnedIds.has(info.id) ? null : groupOfId.get(info.id) ?? null,
        justCreated: true,
        loading: false,
        lastActiveAt: Date.now(),
      });
    } else if (entry.sleep?.url) {
      const s = entry.sleep;
      incoming.push(makePlaceholder(s.url, s.account ?? null, s.title ?? null, !!s.pinned, s.group ?? null));
    }
  }
  if (!incoming.length) return;
  let at = beforeTab ? tabs.indexOf(beforeTab) : -1;
  if (at < 0) at = tabs.length;
  tabs.splice(at, 0, ...incoming);
  normalizeGroups();
  syncTabOrder();
  const show = incoming.find((t) => t.id === got.active) ?? incoming.find((t) => !t.discarded) ?? incoming[0];
  activateTab(show.id);
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

// --- Dropping onto the strip ------------------------------------------------------------
// A window dragged over this strip (another Kessel window, or another
// browser's), or a link, address or text dragged from anywhere: the strip
// opens a gap where it will land.

let dropGap = null; // { k, els, before, shown }

function stripItems() {
  const vertical = isVerticalTabs();
  return [...document.getElementById("tabs").children].filter((el) => !el.classList.contains("closing") && (!vertical || !el.classList.contains("pinned")));
}

// Where in the strip (x, y) falls: the index of the item it's in front of,
// and the strip's items.
function gapAt(x, y) {
  const vertical = isVerticalTabs();
  const els = stripItems();
  const pos = vertical ? y : x;
  let k = els.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return pos < (vertical ? r.top + r.height / 2 : r.left + r.width / 2);
  });
  if (k < 0) k = els.length;
  return { k, els };
}

// The first tab (or group) at or after strip item `k`.
function gapItem(els, k) {
  return els.slice(k).find((el) => el.dataset.tabId || el.dataset.userGroup || el.dataset.group) || null;
}

function showDropGap(x, y, label) {
  const vertical = isVerticalTabs();
  const { k, els } = gapAt(x, y);
  const marker = document.getElementById("drop-marker");
  marker.textContent = label || "";
  marker.hidden = !label;
  document.getElementById(vertical ? "vtabs" : "tab-bar").classList.add("drop-target");
  if (dropGap?.k === k && dropGap.els.length === els.length) return;
  const size = vertical ? 36 : 110;
  els.forEach((el, i) => {
    el.classList.add("drag-shift");
    el.style.transform = i >= k ? `translate${vertical ? "Y" : "X"}(${size}px)` : "";
  });
  const shown = !!dropGap?.shown;
  dropGap = { k, els, before: gapItem(els, k), shown: true };
  const at = els[k - 1]?.getBoundingClientRect();
  const strip = document.getElementById("tabs").getBoundingClientRect();
  marker.style.left = `${vertical ? strip.left + 8 : (at ? at.right : strip.left) + 8}px`;
  marker.style.top = `${vertical ? (at ? at.bottom : strip.top) + 4 : strip.top + 2}px`;
  if (!shown) playSound("hover");
}

function hideDropGap() {
  document.getElementById("drop-marker").hidden = true;
  document.getElementById("tab-bar").classList.remove("drop-target");
  document.getElementById("vtabs").classList.remove("drop-target");
  if (!dropGap) return;
  const els = dropGap.els;
  for (const el of els) el.style.transform = "";
  setTimeout(() => els.forEach((el) => !drag && el.classList.remove("drag-shift")), 320);
  dropGap = null;
}

// The tab something dropped at the gap goes in front of.
function dropGapTab() {
  return stripItemTab(dropGap?.before);
}

// The tab strip item `el` stands for (a group: its first tab).
function stripItemTab(el) {
  if (!el) return null;
  if (el.dataset.tabId) return findTab(parseInt(el.dataset.tabId, 10));
  if (el.dataset.userGroup) return tabs.find((t) => t.group === el.dataset.userGroup) || null;
  if (el.dataset.group) return tabs.find((t) => t.account === el.dataset.group && !t.pinned) || null;
  return null;
}

// Links, addresses and text dragged in from a page, another app or another
// browser's address bar. Onto a tab: that tab goes there. Between tabs: new
// tabs open there (text that isn't an address is searched for).
function wireExternalDrops() {
  const readDrop = (dt) => {
    const list = (dt.getData("text/uri-list") || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    if (list.length) return list;
    const moz = (dt.getData("text/x-moz-url") || "").split(/\r?\n/)[0]?.trim();
    if (moz) return [moz];
    const text = (dt.getData("text/plain") || "").trim();
    return text ? [resolveTyped(text, currentSettings())] : [];
  };
  const accepts = (e) => !drag && [...(e.dataTransfer?.types || [])].some((t) => t === "text/uri-list" || t === "text/plain" || t === "text/x-moz-url");
  let overTab = null;
  const markTab = (el) => {
    if (overTab === el) return;
    overTab?.classList.remove("drop-into");
    overTab = el;
    el?.classList.add("drop-into");
  };
  for (const zone of [document.getElementById("tab-bar"), document.getElementById("vtabs")]) {
    zone.addEventListener("dragover", (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      // Over the middle of a tab: into that tab. Otherwise a gap.
      const el = e.target.closest?.(".tab");
      const r = el?.getBoundingClientRect();
      const middle = el && (isVerticalTabs() ? Math.abs(e.clientY - (r.top + r.height / 2)) < r.height * 0.3 : Math.abs(e.clientX - (r.left + r.width / 2)) < r.width * 0.3);
      if (middle && !el.classList.contains("closing")) {
        hideDropGap();
        markTab(el);
      } else {
        markTab(null);
        showDropGap(e.clientX, e.clientY, "Open here");
      }
    });
    zone.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
      markTab(null);
      hideDropGap();
    });
    zone.addEventListener("drop", async (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      const urls = readDrop(e.dataTransfer).slice(0, 20);
      const into = overTab && findTab(parseInt(overTab.dataset.tabId, 10));
      const before = dropGapTab();
      markTab(null);
      hideDropGap();
      if (!urls.length) return;
      playSound("drop");
      if (into && into.id > 0 && !into.discarded) {
        invoke("navigate", { id: into.id, url: urls[0] }).catch((err) => toast(String(err)));
        if (into.id !== activeTabId) activateTab(into.id);
        urls.shift();
      }
      for (const url of urls) {
        const id = await createTab(url);
        placeBefore(findTab(id), before);
      }
    });
  }
}

// Moves `tab` in front of `before` (or leaves it where it is).
function placeBefore(tab, before) {
  if (!tab || !before || tab === before || !tabs.includes(before)) return;
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.splice(tabs.indexOf(before), 0, tab);
  normalizeGroups();
  syncTabOrder();
  renderTabs();
  persistSession();
}

// Another browser's window, let go over this strip (tabdrag.rs): its tabs
// open here -- the first one live, the rest asleep until you look at them.
// `kept`: some tab couldn't be read, so that window was left as it was.
async function openForeignTabs({ urls, browser, x, y, missed, kept }) {
  let before = dropGap ? dropGapTab() : null;
  if (!dropGap && Number.isFinite(x)) {
    const { k, els } = gapAt(x, y);
    before = stripItemTab(gapItem(els, k));
  }
  hideDropGap();
  if (!urls?.length) {
    toast(missed ? `Couldn't read that ${browser} window's tabs` : `That ${browser} window only had its own pages open`);
    return;
  }
  playSound("attach");
  const id = await createTab(urls[0], null);
  const first = findTab(id);
  placeBefore(first, before);
  let at = tabs.indexOf(first) + 1;
  for (const url of urls.slice(1)) tabs.splice(at++, 0, makePlaceholder(url));
  normalizeGroups();
  syncTabOrder();
  renderTabs();
  persistSession();
  const what = urls.length === 1 ? "the tab" : `${urls.length} tabs`;
  if (!kept) toast(`Moved ${what} over from ${browser}`);
  else if (missed) toast(`Copied ${what} from ${browser} -- ${missed === 1 ? "one tab" : `${missed} tabs`} couldn't be read, so its window stays open`);
  else toast(`Copied ${what} from ${browser} -- its window stays open`);
}

// --- Split view ------------------------------------------------------------------------
// Two tabs side by side (split.rs). Rust places the pages; the toolbar draws
// the divider in the gap between them and keeps the pair side by side in
// the strip.

const SPLIT_GAP = 6;
let split = null; // { left, right, ratio } while there is one

function splitShown() {
  return !!split && (activeTabId === split.left || activeTabId === split.right);
}

function markSplit() {
  for (const [id, el] of tabEls) {
    el.classList.toggle("split-left", split?.left === id);
    el.classList.toggle("split-right", split?.right === id);
  }
  layoutSplitDivider();
}

function layoutSplitDivider() {
  const divider = document.getElementById("split-divider");
  if (!splitShown() || document.documentElement.classList.contains("fullscreen")) {
    divider.hidden = true;
    return;
  }
  const left = reportedInsets.left;
  const usable = innerWidth - left - SPLIT_GAP;
  divider.style.left = `${left + Math.round(usable * split.ratio)}px`;
  divider.style.top = `${reportedInsets.top}px`;
  divider.hidden = false;
}

// Tab `tab` opens beside the one you're on, on `side`.
async function openSplit(tab, side = "right") {
  const partner = splitPartner(tab);
  if (!partner || !tab || !(tab.id > 0) || tab.discarded) return;
  // Side by side in the strip too.
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.splice(tabs.indexOf(partner) + (side === "right" ? 1 : 0), 0, tab);
  if (tab.group !== partner.group) tab.group = partner.pinned ? null : partner.group ?? null;
  normalizeGroups();
  syncTabOrder();
  const [left, right] = side === "right" ? [partner, tab] : [tab, partner];
  split = { left: left.id, right: right.id, ratio: 0.5 };
  activeTabId = tab.id;
  renderTabs();
  updateAddressBarForActiveTab();
  persistSession();
  playSound("attach");
  await invoke("split_tabs", { left: left.id, right: right.id, focus: tab.id }).catch((err) => toast(String(err)));
}

function wireSplitDivider() {
  const divider = document.getElementById("split-divider");
  divider.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !split || e.target.closest("button")) return;
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dragging");
    let sending = false;
    let again = false;
    const send = (done) => {
      if (sending && !done) {
        again = true;
        return;
      }
      sending = true;
      invoke("set_split_ratio", { ratio: split.ratio, done }).finally(() => {
        sending = false;
        if (again && !done) {
          again = false;
          send(false);
        }
      });
    };
    const move = (ev) => {
      if (!split) return;
      const left = reportedInsets.left;
      const usable = innerWidth - left - SPLIT_GAP;
      split.ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - left - SPLIT_GAP / 2) / usable));
      layoutSplitDivider();
      send(false);
    };
    const up = () => {
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      divider.removeEventListener("pointercancel", up);
      if (split) send(true);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
    divider.addEventListener("pointercancel", up);
  });
  divider.querySelector(".split-swap").addEventListener("click", () => invoke("swap_split").catch(() => {}));
  divider.querySelector(".split-close").addEventListener("click", () => invoke("unsplit").catch(() => {}));
  divider.addEventListener("dblclick", () => {
    if (!split) return;
    split.ratio = 0.5;
    layoutSplitDivider();
    invoke("set_split_ratio", { ratio: 0.5, done: true }).catch(() => {});
  });
}

// --- Sounds ---------------------------------------------------------------------------------

function playSound(name) {
  playUiSound(name, window.__kesselStyle?.values);
}


// Using a lot of memory or CPU (see pollTabResources): a warning ring on
// its icon, and the hover card says how much.
function isHeavy(tab) {
  return !tab.discarded && ((tab.memory ?? 0) > 1.5 * 1024 ** 3 || (tab.cpuHigh ?? 0) >= 2);
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
  const sleepable = live.filter((t) => t.id !== activeTabId && !t.audible);
  // Tabs join groups of their own account; pinned ones join none.
  const account = list.find((t) => !t.pinned)?.account ?? null;
  const groupable = list.filter((t) => !t.pinned && (t.account ?? null) === account);
  const otherGroups = [...tabGroups.values()].filter(
    (g) => groupable.length && tabs.some((t) => t.group === g.id && (t.account ?? null) === account) && !groupable.every((t) => t.group === g.id)
  );
  const otherWindows = (await invoke("get_windows").catch(() => [])).filter((w) => !w.current && w.private === !!WIN.private);

  const items = [
    { label: "New tab to the right", iconName: "plus", action: () => createTab(undefined, list[n - 1].account ?? null, { after: list[n - 1] }) },
    "-",
    { label: single ? "Reload" : `Reload ${tabCount(n)}`, iconName: "reload", keys: single && tab.id === activeTabId ? commandKeys("reload") : undefined, disabled: !live.length, action: () => reloadTabs(live) },
    { label: single ? "Duplicate" : `Duplicate ${tabCount(n)}`, iconName: "copy", keys: single && tab.id === activeTabId ? commandKeys("duplicate-tab") : undefined, disabled: !list.some((t) => t.url), action: () => duplicateTabs(list) },
    { label: `${allPinned ? "Unpin" : "Pin"} ${tabCount(n)}`, iconName: "pin", keys: single && tab.id === activeTabId ? commandKeys("pin-tab") : undefined, action: () => setPinned(list, !allPinned) },
    { label: `${allMuted ? "Unmute" : "Mute"} ${tabCount(n)}`, iconName: allMuted ? "volume" : "volumeOff", keys: single && tab.id === activeTabId ? commandKeys("mute-tab") : undefined, disabled: !live.length, action: () => toggleMute(live) },
    { label: single ? "Put to sleep" : `Put ${tabCount(n)} to sleep`, iconName: "moon2", disabled: !sleepable.length, action: () => sleepTabs(sleepable) },
    "-",
    { label: single ? "Add tab to new group" : `Add ${tabCount(n)} to new group`, iconName: "layers", keys: single && tab.id === activeTabId ? commandKeys("add-tab-to-group") : undefined, disabled: !groupable.length, action: () => createGroup(groupable) },
    ...otherGroups.map((g) => ({ label: `Add to group ${groupLabel(g)}`, swatch: groupColor(g), action: () => addToGroup(groupable, g) })),
    ...(list.some((t) => t.group) ? [{ label: single ? "Remove from group" : "Remove from their groups", iconName: "ungroup", action: () => removeFromGroup(list) }] : []),
    { label: "Group tabs by site", iconName: "grid", keys: commandKeys("group-tabs-by-site"), action: () => runCommand("group-tabs-by-site") },
    "-",
    { label: single ? "Bookmark tab" : `Bookmark ${tabCount(n)}`, iconName: "star", disabled: !web.length, action: () => bookmarkTabs(web) },
    { label: single ? "Copy link" : `Copy ${n} links`, iconName: "link", disabled: !web.length, action: () => copyTabLinks(web) },
    "-",
    { label: single ? "Move to new window" : `Move ${tabCount(n)} to new window`, iconName: "popOut", disabled: n >= tabs.length, action: () => moveTabsToNewWindow(list) },
  ];
  // Split view: beside the tab you're on, or out of it.
  const inSplit = split && (tab.id === split.left || tab.id === split.right);
  if (inSplit) {
    items.push({ label: "Swap sides", iconName: "arrowRight", action: () => invoke("swap_split").catch(() => {}) }, { label: "Exit split view", iconName: "window", action: () => invoke("unsplit").catch(() => {}) });
  } else if (single && tab.id > 0 && !tab.discarded && splitPartner(tab)) {
    items.push({ label: tab.id === activeTabId ? "Split view with the previous tab" : "Open side by side with this tab", iconName: "sidebar", action: () => openSplit(tab, "right") });
  }
  // Tidying up: the same page open twice, and the strip in order.
  const seenUrls = new Set();
  const duplicates = tabs.filter((t) => {
    if (!t.url || t.pinned || t.url.startsWith("kessel://")) return false;
    if (seenUrls.has(t.url)) return t.id !== activeTabId;
    seenUrls.add(t.url);
    return false;
  });
  items.push(
    { label: duplicates.length ? `Close ${tabCount(duplicates.length, "duplicate tab")}` : "Close duplicate tabs", iconName: "copy", disabled: !duplicates.length, action: () => closeTabs(duplicates) },
    { label: "Sort tabs by site", iconName: "grid", disabled: tabs.filter((t) => !t.pinned).length < 2, action: () => sortTabs() }
  );
  // Into another workspace (asleep there till you go to it).
  if (!WIN.private) {
    for (const w of workspaceList().filter((w) => w.id !== currentWorkspace)) {
      items.push({ label: `Move to workspace “${w.name}”`, iconName: "layers", action: () => moveTabsToWorkspace(list, w.id) });
    }
  }
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

// The strip's unpinned tabs by site, then title -- within their account and
// group, which stay together where they are.
function sortTabs() {
  const key = (t) => `${hostOf(t.url || "").replace(/^www\./, "")}\u0000${(t.title || "").toLowerCase()}`;
  const blocks = [];
  for (const t of tabs) {
    const id = t.pinned ? "pinned" : `${t.account ?? ""}|${t.group ?? ""}`;
    const last = blocks[blocks.length - 1];
    if (last?.id === id) last.tabs.push(t);
    else blocks.push({ id, tabs: [t] });
  }
  tabs = blocks.flatMap((b) => (b.id === "pinned" ? b.tabs : [...b.tabs].sort((a, c) => key(a).localeCompare(key(c)))));
  normalizeGroups();
  syncTabOrder();
  renderTabs();
  persistSession();
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
// Settings -> Tabs: only the tab you're on plays sound. Tabs muted this
// way (not by you) get their sound back when you go to them.
function muteBackgroundTabs(activeId) {
  if (!currentSettings()?.features?.mute_background) return;
  for (const t of tabs) {
    if (!(t.id > 0) || t.discarded) continue;
    if (t.id === activeId) {
      if (t.autoMuted) {
        t.autoMuted = false;
        t.muted = false;
        invoke("page_action", { id: t.id, action: "unmute", value: null }).catch(() => {});
      }
    } else if (t.audible && !t.muted && !t.keepSound) {
      t.autoMuted = true;
      t.muted = true;
      invoke("page_action", { id: t.id, action: "mute", value: null }).catch(() => {});
    }
  }
}

async function toggleMute(list) {
  const live = list.filter((t) => t.id > 0 && !t.discarded);
  if (!live.length) return;
  const mute = !live.every((t) => t.muted);
  for (const t of live) {
    t.muted = mute; // the page confirms it with "tab-audio"
    // Unmuted by you: background muting leaves it alone from now on.
    t.autoMuted = false;
    t.keepSound = !mute;
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
    await invoke("add_bookmark", { url: t.url, title: t.title || t.url, tab: t.discarded ? null : t.id });
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
  const groupIds = new Set(list.map((t) => t.group).filter(Boolean));
  try {
    await invoke("move_tabs_to_new_window", {
      ids: live.map((t) => t.id),
      sleeping: sleeping.map((t) => ({ url: t.url, account: t.account ?? null, title: t.userTitled ? t.title : null, pinned: !!t.pinned, group: t.group ?? null })),
      pinned: live.filter((t) => t.pinned).map((t) => t.id),
      tabGroups: Object.fromEntries(live.filter((t) => t.group).map((t) => [String(t.id), t.group])),
      groups: [...groupIds].map((id) => tabGroups.get(id)).filter(Boolean),
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
    // new-tab/settings pages do -- there's nothing useful to type over. A
    // warning page shows the address it stands in for.
    input.value = tab && tab.url && !tab.url.startsWith("kessel://") ? tab.url : warnedUrl(tab?.url || "") || "";
    input.classList.remove("search-mode");
    omnibox?.reset();
  }
  document.getElementById("share-btn").hidden = !(tab && /^(https?|file):/.test(tab.url || ""));
  updateSiteButton();
  updateStarButton();
  updateNavButtons();
  updateShieldsButton();
  updateAccountButton();
  updateZoomIndicator();
  updateExtensionButtons();
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

  // Stamp the tab we're leaving as "went idle now" -- lifecycleTick
  // measures elapsed time from this, not from when it was created.
  const prev = findTab(activeTabId);
  if (prev && prev.id !== id) prev.lastActiveAt = Date.now();

  // The strip and address bar show it straight away; the page follows as
  // soon as Rust has swapped it in (no waiting on the round trip to look
  // like it switched).
  activeTabId = id;
  noteRecent(id);
  muteBackgroundTabs(id);
  // Looked at: no news dot, and showing it unfroze it.
  tab.attention = false;
  tab.frozen = false;
  tab.lastActiveAt = Date.now();
  const group = groupOf(tab);
  if (group?.collapsed) group.collapsed = false;
  renderTabs();
  updateAddressBarForActiveTab();
  playSound("switch");
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
    if (activeTabId === id) activeTabId = newId;
    noteRecent(newId);
    renderTabs();
  } else {
    await invoke("switch_tab", { id }).catch(() => {});
  }
  persistSession();
  enforceAwakeLimit();
  closeForgottenTabs(Date.now());
}

// Settings -> Tabs: tabs you haven't looked at in so many days close by
// themselves (pinned ones, and ones playing sound, stay). They're in
// recently closed and history if you want one back.
function closeForgottenTabs(now) {
  const days = Number(currentSettings()?.features?.auto_close_days) || 0;
  if (days <= 0) return;
  const old = tabs.filter((t) => t.id !== activeTabId && !t.pinned && !t.audible && t.url && !t.url.startsWith("kessel://") && now - (t.lastActiveAt ?? now) >= days * 86400000);
  if (old.length) closeTabs(old);
}

// Settings -> Privacy: sites whose cookies and data go when you close the
// last tab showing them.
async function forgetSiteIfLast(url) {
  const list = currentSettings()?.features?.forget_sites;
  if (WIN.private || !Array.isArray(list) || !list.length || !/^https?:/.test(url || "")) return;
  const host = hostOf(url).replace(/^www\./, "");
  const site = list.find((s) => host === s || host.endsWith(`.${s}`));
  if (!site) return;
  const open = await invoke("all_tabs").catch(() => null);
  if (!open || open.some((t) => /^https?:/.test(t.url || "") && (hostOf(t.url).replace(/^www\./, "") === site || hostOf(t.url).endsWith(`.${site}`)))) return;
  const removed = await invoke("clear_site_data", { site, tab: null }).catch(() => null);
  if (removed != null && currentSettings()?.features?.forget_sites_notice !== false) toast(`Forgot ${site}'s cookies and data`);
}

// Tabs by when you last looked at them, most recent first (split view's
// partner, Ctrl+Tab in "recently used" order).
let recentTabs = [];
function noteRecent(id) {
  recentTabs = [id, ...recentTabs.filter((x) => x !== id && findTab(x))].slice(0, 50);
}

// A new tab opens in the same account as the tab you're on (so "+" and
// Ctrl+T inside an account's group stay signed in as that account), unless
// `account` says otherwise (null = Main). `after`: right after that tab
// instead of at the end; `pinned`: as a pinned tab; `group`: in that tab
// group.
async function createTab(url, account = activeAccount(), { after = null, pinned = false, group = null } = {}) {
  account = accountById(account)?.id ?? null;
  const id = await invoke("new_tab", { url: url ?? null, account });
  // Resolve what Rust will actually open this tab to, so the omnibox/star/
  // pin logic below has an accurate url immediately -- don't wait on a
  // possibly-unreliable navigation event for internal kessel:// pages.
  const resolvedUrl = url ?? (currentSettings()?.homepage || "kessel://newtab");
  const tab = { id, url: resolvedUrl, title: "New Tab", account, pinned, group: pinned ? null : group, justCreated: true, loading: false, lastActiveAt: Date.now() };
  insertTab(tab);
  if (after) moveTabAfter(tab, after);
  else if (pinned || group) {
    normalizeGroups();
    syncTabOrder();
  }
  if (account) collapsedGroups.delete(account);
  if (tabGroups.get(tab.group)?.collapsed) tabGroups.get(tab.group).collapsed = false;
  if (!group && !pinned) autoGroupTab(tab);
  clearSelection();
  activeTabId = id;
  renderTabs();
  updateAddressBarForActiveTab();
  persistSession();
  catchUpTab(id);
  playSound("open");
  // Once more a little later, in case its reports crossed with this one.
  setTimeout(() => findTab(id) && !findTab(id).userTitled && catchUpTab(id), 1500);
  enforceAwakeLimit();
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
  const url = info.url && keepViewSource(tab, info.url);
  if (url && /^(https?|file):/.test(url) && url !== tab.url) {
    tab.url = url;
    changed = true;
    if (id === activeTabId) updateAddressBarForActiveTab();
  }
  if (changed) {
    renderTabs();
    persistSession();
  }
}

// WebView2 reports a view-source: tab by the address it shows the source
// of; the tab (and its address bar) keep saying view-source:.
function keepViewSource(tab, url) {
  return tab?.url?.startsWith("view-source:") && tab.url.slice("view-source:".length) === url ? tab.url : url;
}

// Adds a tab entry with NO webview behind it yet -- used for session-restore
// tabs you aren't looking at right now. Costs nothing until you click it.
function addPlaceholderTab(url, account = null, title = null, pinned = false, group = null) {
  const tab = makePlaceholder(url, account, title, pinned, group);
  tabs.push(tab);
  return tab.id;
}

function makePlaceholder(url, account = null, title = null, pinned = false, group = null) {
  return {
    id: nextPlaceholderId(),
    url,
    account: accountById(account)?.id ?? null,
    title: title || internalTitle(url) || hostOf(url),
    userTitled: !!title,
    pinned: !!pinned,
    group: pinned ? null : group,
    discarded: true,
    neverCreated: true,
    loading: false,
    lastActiveAt: Date.now(),
  };
}

// What this window opens first (see take_window_init in main.rs): the tabs
// of a restored window -- only the one you were looking at gets a real
// webview, the rest come back as sleeping placeholders that cost nothing
// until clicked -- tabs moved in from another window, or links (Shift+click
// opens one in a new window). Returns whether it opened anything.
async function openWindowInit(init) {
  if (!init) return false;
  if (init.session?.tabs?.length) {
    // The workspace the window was in (tabs of one that's gone join the
    // first one); the others' tabs wait asleep.
    const known = new Set(workspaceList().map((w) => w.id));
    const workspaceOf = (t) => (known.has(t.workspace || "") ? t.workspace || "" : "");
    currentWorkspace = WIN.private || !known.has(init.session.workspace || "") ? "" : init.session.workspace || "";
    const saved = init.session.tabs.filter((t) => workspaceOf(t) === currentWorkspace);
    for (const t of init.session.tabs) {
      const workspace = workspaceOf(t);
      if (workspace === currentWorkspace) continue;
      const parked = parkedWorkspaces.get(workspace) || { tabs: [], active: 0, groups: [] };
      if (t.current) parked.active = parked.tabs.length;
      parked.tabs.push(makePlaceholder(t.url, t.account ?? null, t.title, t.pinned, t.group ?? null));
      parkedWorkspaces.set(workspace, parked);
    }
    for (const g of init.session.groups || []) {
      if (!g?.id) continue;
      const parked = [...parkedWorkspaces.values()].find((p) => p.tabs.some((t) => t.group === g.id));
      if (parked && !saved.some((t) => t.group === g.id)) parked.groups.push({ ...g });
    }
    if (!saved.length) {
      await createTab();
      for (const g of init.session.groups || []) if (g?.id && !([...parkedWorkspaces.values()].some((p) => p.groups.some((x) => x.id === g.id)))) tabGroups.set(g.id, { ...g });
      normalizeGroups();
      renderWorkspaces();
      return true;
    }
    const current = saved.findIndex((t) => t.current);
    const active = current >= 0 ? current : Math.min(Math.max(init.session.active || 0, 0), saved.length - 1);
    for (let i = 0; i < saved.length; i++) {
      if (i === active) {
        const id = await createTab(saved[i].url, saved[i].account ?? null);
        findTab(id).pinned = !!saved[i].pinned;
        findTab(id).group = saved[i].pinned ? null : saved[i].group ?? null;
      } else {
        addPlaceholderTab(saved[i].url, saved[i].account ?? null, saved[i].title, saved[i].pinned, saved[i].group ?? null);
      }
    }
    // Their groups, once every tab is back (an empty group is dropped;
    // another workspace's wait with its tabs).
    for (const g of init.session.groups || []) if (g?.id && saved.some((t) => t.group === g.id)) tabGroups.set(g.id, { ...g });
    normalizeGroups();
    syncTabOrder();
    renderTabs();
    renderWorkspaces();
    return true;
  }
  // Tabs moved here from another window: the live ones with their pages,
  // sleeping ones still asleep; pinned and grouped as they were.
  if (init.adopt?.length || init.sleeping?.length) {
    const pinnedIds = new Set(init.pinned || []);
    const groupOfId = new Map(Object.entries(init.tabGroups || {}).map(([id, g]) => [Number(id), g]));
    for (const info of init.adopt || []) {
      adoptTabInfo(info);
      if (pinnedIds.has(info.id)) findTab(info.id).pinned = true;
      else if (groupOfId.has(info.id)) findTab(info.id).group = groupOfId.get(info.id);
    }
    for (const t of init.sleeping || []) addPlaceholderTab(t.url, t.account ?? null, t.title, t.pinned, t.group ?? null);
    for (const g of init.groups || []) if (g?.id) tabGroups.set(g.id, { ...g });
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
  if (hoverTab === id || hoverShown) hideHoverCard();
  // Gone from the strip at once, and the next tab shown before this one's
  // page is torn down -- never a frame without a page.
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  recentTabs = recentTabs.filter((x) => x !== id);
  playSound("close");
  const last = tabs.length === 0;
  if (!last && activeTabId === id) activateTab(tabs[Math.max(0, idx - 1)].id);
  else if (!last) renderTabs();
  if (!tab.neverCreated) {
    // A discarded-but-previously-real tab's id is still a valid u32 Rust
    // once knew (close_tab just no-ops if it's already gone) -- only a
    // never-created placeholder's negative synthetic id can't be sent to a
    // u32-typed command at all.
    const closedUrl = tab.discarded || !remember ? null : tab.url;
    await invoke("close_tab", { id, url: closedUrl || null }).catch(() => {});
  }
  if (remember) forgetSiteIfLast(tab.url);
  if (last) {
    await createTab();
    return;
  }
  persistSession();
}

// --- Idle tab discarding (destroys a background tab's webview to free
// memory; reviving it in activateTab() above just reloads the page) -------

async function discardTab(tab) {
  if (tab.discarded || tab.id === activeTabId) return;
  try {
    await invoke("close_tab", { id: tab.id, url: null });
  } catch {
    // Already gone somehow -- fine, we're marking it discarded either way.
  }
  tab.discarded = true;
  tab.loading = false;
  tab.audible = false;
  tab.frozen = false;
  tab.memory = null;
  tab.cpu = null;
  renderTabs();
}

// --- A background tab's life -----------------------------------------------------
// Hidden (throttled by the engine) as soon as you leave it -- see
// lifecycle.rs -- then, as set in Settings -> Performance: frozen after a
// while (scripts stop), asleep after longer (webview closed, reloads when
// you come back), and no more than so many tabs awake at once. Never the
// tab you're on, one playing sound, Kessel's own single pages, or a site
// you listed as never to sleep.

function neverSleeps(tab) {
  if (tab.audible || SINGLETON_ROUTES.has(internalPageKey(tab.url))) return true;
  const host = hostOf(tab.url || "");
  return (currentSettings()?.never_sleep_sites || []).some((site) => {
    const s = String(site).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    return s && (host === s || host.endsWith(`.${s}`));
  });
}

function lifecycleTick() {
  const settings = currentSettings() || {};
  const now = Date.now();
  const sleepAfter = (settings.discard_tabs_after_minutes ?? 0) * 60 * 1000;
  const freezeAfter = (settings.freeze_tabs_after_minutes ?? 0) * 60 * 1000;
  for (const tab of tabs) {
    if (tab.discarded || tab.id <= 0 || tab.id === activeTabId || neverSleeps(tab)) continue;
    const idle = now - (tab.lastActiveAt ?? now);
    if (sleepAfter && idle >= sleepAfter) discardTab(tab);
    else if (freezeAfter && idle >= freezeAfter && !tab.frozen && !tab.freezing) {
      tab.freezing = true;
      invoke("freeze_tab", { id: tab.id }).catch(() => {}).finally(() => (tab.freezing = false));
    }
  }
  enforceAwakeLimit();
}

// "Keep at most N tabs awake": the ones you looked at longest ago go to
// sleep first.
function enforceAwakeLimit() {
  const max = currentSettings()?.max_awake_tabs ?? 0;
  if (!max) return;
  const awake = tabs.filter((t) => !t.discarded && t.id > 0);
  if (awake.length <= max) return;
  const candidates = awake.filter((t) => t.id !== activeTabId && !neverSleeps(t)).sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
  for (const t of candidates.slice(0, awake.length - max)) discardTab(t);
}

function wireTabLifecycle() {
  setInterval(lifecycleTick, 30 * 1000);
}

// Puts `list` to sleep now (the tab menu, "Put other tabs to sleep").
async function sleepTabs(list) {
  let count = 0;
  for (const t of list) {
    if (t.discarded || t.id <= 0 || t.id === activeTabId || t.audible) continue;
    await discardTab(t);
    count++;
  }
  clearSelection();
  renderTabs();
  toast(count ? `${count} tab${count === 1 ? "" : "s"} asleep -- ${count === 1 ? "it wakes" : "they wake"} up when you click ${count === 1 ? "it" : "them"}` : "Nothing to put to sleep");
}

// Settings and Passwords can still be reached as full tabs (e.g. typing
// kessel://settings into the omnibox) -- opening them again focuses the
// one already-open tab instead of spawning another full webview. The rail
// icons themselves go through the side panel instead (see below).
const SINGLETON_ROUTES = new Set(["kessel://settings", "kessel://passwords", "kessel://history", "kessel://downloads", "kessel://help", "kessel://gpu", "kessel://feeds", "kessel://bookmarks"]);

async function openSingleton(route) {
  await invoke("open_singleton_tab", { route });
  // No local state mutation here -- Rust emits "tab-focused" (existing tab)
  // or "tab-created" (new one) either way, and the listeners below handle both.
}

async function navigateActiveTab(rawInput) {
  const tab = findTab(activeTabId);
  if (!tab) return;
  const url = resolveTyped(rawInput, currentSettings());
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
    case "search-tabs": return toggleTabSearch();
    case "add-tab-to-group": return picked.length && createGroup(picked);
    case "group-tabs-by-site": {
      const made = groupTabsBySite();
      return toast(made ? `Made ${made} group${made === 1 ? "" : "s"} of tabs from the same site` : "No two ungrouped tabs are from the same site");
    }
    case "sleep-other-tabs": return sleepTabs(tabs.filter((t) => t.id !== activeTabId));
    case "toggle-vertical-tabs": return saveSettings({ tab_layout: currentSettings()?.tab_layout === "vertical" ? "horizontal" : "vertical" });
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
    case "bookmark-manager": return openBookmarkManager();
    case "toggle-bookmarks-bar": return saveSettings({ bookmarks_bar: currentSettings()?.bookmarks_bar === false });
    case "history": return openSingleton("kessel://history");
    case "downloads": return openSingleton("kessel://downloads");
    case "clear-browsing-data": return openSingleton("kessel://settings/clear");
    case "settings": return openSingleton("kessel://settings");
    case "help": return openSingleton("kessel://help");
    case "gpu": return openSingleton("kessel://gpu");
    case "media-controls": return toggleMediaPopup();
    case "command-palette": return toggleCommandPalette();
    case "screenshot-visible":
    case "screenshot-full":
      return page && takeScreenshot(page, id === "screenshot-full");
    case "reader-mode": return page && openReader(page);
    case "zap-element":
      if (!page) return;
      await invoke("page_tool", { id: page, tool: "zap-start" }).catch((err) => toast(String(err)));
      return toast("Click what to hide on this site (Esc to stop). Undo it in Settings -> Page tools.");
    case "link-hints": return page && invoke("page_tool", { id: page, tool: "link-hints" }).catch((err) => toast(String(err)));
    case "site-tweaks": {
      const tab = findTab(page) || findTab(activeTabId);
      const site = /^https?:/.test(tab?.url || "") ? hostOf(tab.url).replace(/^www\./, "") : "";
      try {
        if (site) localStorage.setItem("kessel-edit-site", site);
      } catch {}
      return openSingleton("kessel://settings/tools");
    }
    case "auto-reload": return autoReloadMenu(findTab(page) || findTab(activeTabId));
    case "copy-clean-link": {
      const tab = findTab(page) || findTab(activeTabId);
      if (!tab || !/^https?:/.test(tab.url || "")) return toast("This page has no link to copy");
      const clean = cleanLink(tab.url);
      await navigator.clipboard.writeText(clean).then(() => toast(clean === tab.url ? "Link copied (it had no tracking)" : "Link copied without tracking"), () => toast("Couldn't copy -- clipboard unavailable"));
      return;
    }
    case "paste-and-go": {
      const text = await navigator.clipboard.readText().catch(() => "");
      if (!text.trim()) return toast("Nothing to paste");
      return navigateActiveTab(text.trim().slice(0, 4000));
    }
    case "close-duplicate-tabs": return closeDuplicateTabs();
    case "screenshot-area":
      if (!page) return;
      return invoke("page_tool", { id: page, tool: "shot-area-start" }).catch((err) => toast(String(err)));
    case "save-pdf": return page && savePdf(page);
    case "highlight": return page && invoke("page_tool", { id: page, tool: "highlight" }).catch((err) => toast(String(err)));
    case "feeds": return openSingleton("kessel://feeds");
    case "follow-feed": return followFeed(findTab(page) || findTab(activeTabId));
    case "break-mode": return toggleBreakMode();
    case "wayback": {
      const tab = findTab(page) || findTab(activeTabId);
      if (!tab || !/^https?:/.test(tab.url || "")) return toast("This page has no address to look up");
      return createTab(`https://web.archive.org/web/2/${tab.url}`, tab.account ?? null, { after: tab.id });
    }
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
// With "recently used order" on (Settings -> Tabs), Ctrl+Tab goes back to
// the tab you were on before, and pressing it again soon after goes further
// back through the ones before that.
let cycleWalk = null; // { list, at, until }
async function cycleTabs(direction) {
  if (currentSettings()?.tab_cycle_mru) {
    const now = Date.now();
    if (!cycleWalk || now > cycleWalk.until) {
      const list = recentTabs.filter((id) => findTab(id) && !isHiddenInGroup(findTab(id)));
      for (const t of tabs) if (!list.includes(t.id) && !isHiddenInGroup(t)) list.push(t.id);
      cycleWalk = { list, at: 0 };
    }
    cycleWalk.until = now + 1100;
    const n = cycleWalk.list.length;
    if (n < 2) return;
    cycleWalk.at = (cycleWalk.at + (direction > 0 ? 1 : -1) + n) % n;
    const target = cycleWalk.list[cycleWalk.at];
    const walk = cycleWalk;
    await activateTab(target);
    // activateTab put it first in recentTabs; the walk keeps its own order.
    cycleWalk = walk;
    return;
  }
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
  if (tab.id === activeTabId) return false;
  return !!((tab.account && !tab.pinned && collapsedGroups.has(tab.account)) || groupOf(tab)?.collapsed);
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
    await invoke("add_bookmark", { url: t.url, title: t.title || t.url, tab: t.discarded ? null : t.id });
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
  const url = resolveTyped(text, currentSettings());
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

// --- Site info (the address bar's lock) ---------------------------------------
// How the page is connected -- a lock, or "Not secure" for a website on plain
// http (security.rs's HTTPS-only can refuse those) -- and, on click, the site
// info popup (siteinfo.html): the certificate, the site's cookies and data.

// Like shields.rs's is_local_host: an address or a name on your own network.
function isLocalHost(host) {
  return host === "localhost" || /\.(localhost|local|lan|internal)$/.test(host) || /^[\d.]+$/.test(host) || host.startsWith("[") || !host.includes(".");
}

// The page a warning page (kessel://warning) stands in for.
function warnedUrl(url) {
  if (!url.startsWith("kessel://warning")) return null;
  try {
    return new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("url") || "";
  } catch {
    return "";
  }
}

function siteState(url) {
  if (warnedUrl(url) !== null) return "danger";
  if (/^https:/i.test(url)) return "secure";
  if (/^http:/i.test(url)) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {}
    return isLocalHost(host) ? "local" : "insecure";
  }
  if (/^file:/i.test(url)) return "file";
  return "none";
}

function updateSiteButton() {
  const button = document.getElementById("lock-icon");
  const state = siteState(findTab(activeTabId)?.url || "");
  if (button.dataset.state === state) return;
  button.dataset.state = state;
  const glyph = { secure: "lock", insecure: "unlock", danger: "warning", local: "globe", file: "file" }[state] || "search";
  const label = { insecure: "Not secure", danger: "Warning" }[state];
  button.innerHTML = `${icon(glyph, 13)}${label ? `<span>${label}</span>` : ""}`;
  button.title = { secure: "Connection is secure -- site info", insecure: "Not secure -- site info", local: "Site info", file: "Site info" }[state] || "";
  button.disabled = !["secure", "insecure", "local", "file"].includes(state);
}

async function toggleSiteInfo() {
  const tab = findTab(activeTabId);
  if (!tab || !/^(https?|file):/.test(tab.url || "")) return;
  const rect = document.getElementById("lock-icon").getBoundingClientRect();
  await invoke("toggle_popup", { kind: "siteinfo", x: Math.round(rect.left - 6), y: Math.round(rect.bottom), width: 320, height: 330, init: { tab: tab.id, url: tab.url } }).catch(() => {});
}

// --- Risky downloads ---------------------------------------------------------------
// A download security.rs holds back until you decide: one prompt at a time
// (download-warning.html), the rest wait their turn.

// --- Site permission requests (permissions.rs) --------------------------------------
// One prompt at a time under the address bar (permission.html); the rest
// wait their turn.

const permissionRequests = [];

function showPermissionRequest() {
  const next = permissionRequests[0];
  if (!next) return;
  const rect = document.getElementById("lock-icon").getBoundingClientRect();
  invoke("toggle_popup", { kind: "permission", x: Math.round(rect.left - 6), y: Math.round(rect.bottom), width: 340, height: 150, init: next }).catch(() => {});
}

const downloadWarnings = [];

function showDownloadWarning() {
  const next = downloadWarnings[0];
  if (!next) return;
  const rect = document.getElementById("menu-btn").getBoundingClientRect();
  invoke("toggle_popup", { kind: "download", x: Math.round(rect.right + 4), y: Math.round(rect.bottom), width: 360, height: 220, init: next }).catch(() => {});
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
    const keepable = (t) => t.url && (/^(https?|file):/.test(t.url) || t.url.startsWith("kessel://")) && !SINGLETON_ROUTES.has(internalPageKey(t.url));
    const entry = (t, workspace, current, group) => ({ url: t.url, account: t.account ?? null, title: t.userTitled ? t.title : null, pinned: !!t.pinned, group, workspace: workspace || null, current });
    const kept = tabs.filter(keepable);
    const saved = kept.map((t) => entry(t, currentWorkspace, t.id === activeTabId, groupOf(t)?.id ?? null));
    const active = Math.max(0, kept.findIndex((t) => t.id === activeTabId));
    const groups = [...tabGroups.values()].filter((g) => kept.some((t) => t.group === g.id));
    // The other workspaces' tabs too, asleep as they are.
    for (const [workspace, parked] of parkedWorkspaces) {
      parked.tabs.forEach((t, i) => keepable(t) && saved.push(entry(t, workspace, i === parked.active, t.group ?? null)));
      groups.push(...parked.groups);
    }
    invoke("save_window_session", { tabs: saved, active, groups, workspace: currentWorkspace || null }).catch(() => {});
    syncSavedGroups();
  }, 300);
}

// --- Bookmarks --------------------------------------------------------

async function refreshBookmarks() {
  const tree = await invoke("bookmark_tree").catch(() => null);
  bookmarks = tree?.bookmarks ?? (await invoke("get_bookmarks"));
  bookmarkFolders = tree?.folders ?? [];
  updateStarButton();
  renderBookmarksBar();
}

const openBookmarkManager = (folder = "") => openSingleton(`kessel://bookmarks${folder ? `/${encodeURIComponent(folder)}` : ""}`);

// Everything under folder `id` (its folders' too), for "Open all".
function bookmarksUnder(id) {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of bookmarkFolders) {
      if (ids.has(f.parent) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return bookmarks.filter((b) => ids.has(b.folder));
}

async function openAllBookmarks(list) {
  if (list.length > 15 && !(await confirmDialog(`Open ${list.length} tabs?`, "Open them"))) return;
  for (const b of list) await createTab(b.url);
}

// A folder on the bookmarks bar opens as a dropdown of what's in it; a
// folder in there opens its own in the same place (a menu has no
// submenus). Its right-click menu comes with "Open all".
function showBookmarkFolder(folderId, x, y, dropdown = true) {
  const folder = bookmarkFolders.find((f) => f.id === folderId);
  if (!folder) return;
  const folders = bookmarkFolders.filter((f) => f.parent === folderId);
  const inside = bookmarks.filter((b) => b.folder === folderId);
  const all = bookmarksUnder(folderId);
  // After this menu has closed (its pick closes it), or the new one would be
  // this one, closing.
  const reopen = (id) => setTimeout(() => showBookmarkFolder(id, x, y, false), 120);
  const items = [
    ...(folder.parent ? [{ label: "‹ Back", iconName: "chevronLeft", action: () => reopen(folder.parent) }, "-"] : []),
    ...folders.map((f) => ({ label: f.title, iconName: "folder", action: () => reopen(f.id) })),
    ...(folders.length && inside.length ? ["-"] : []),
    ...inside.slice(0, 60).map((b) => ({ label: b.title || hostOf(b.url), iconName: "globe", action: () => openInActiveTab(b.url) })),
    ...(!folders.length && !inside.length ? [{ label: "(empty)", disabled: true }] : []),
    "-",
    { label: `Open all ${all.length} in new tabs`, iconName: "tabs", disabled: !all.length, action: () => openAllBookmarks(all) },
    { label: "Show in bookmark manager", iconName: "bookmark", action: () => openBookmarkManager(folderId) },
  ];
  showContextMenu(items, x, y, { dropdown });
}

function bookmarkChipMenu(b, x, y) {
  showContextMenu(
    [
      { label: "Open in new tab", iconName: "plus", action: () => createTab(b.url) },
      { label: "Open in new window", iconName: "window", action: () => invoke("new_window", { private: false, url: b.url }) },
      { label: "Open in private window", iconName: "incognito", action: () => invoke("new_window", { private: true, url: b.url }) },
      "-",
      { label: "Edit…", iconName: "edit", action: () => showBookmarkPopup(b, false) },
      { label: "Copy link", iconName: "copy", action: () => navigator.clipboard.writeText(b.url).then(() => toast("Link copied")) },
      { label: "Delete", iconName: "trash", danger: true, action: () => invoke("remove_bookmark", { url: b.url }) },
      "-",
      { label: "Bookmark manager", iconName: "bookmark", keys: commandKeys("bookmark-manager"), action: () => openBookmarkManager(b.folder) },
    ],
    x,
    y
  );
}

// Opera-style bookmarks bar under the omnibox. Click opens in the current
// tab, middle-click (or Ctrl-click) in a new one.
function renderBookmarksBar() {
  const bar = document.getElementById("bookmarks-bar");
  bar.hidden = currentSettings()?.bookmarks_bar === false;
  bar.innerHTML = "";
  // Saved tab groups first: click opens the group (or shows it, if open).
  for (const g of WIN.private ? [] : savedGroups) {
    const chip = document.createElement("div");
    chip.className = "bm-chip saved-group";
    chip.dataset.savedGroup = g.id;
    chip.style.setProperty("--group", (GROUP_COLORS[g.color] || GROUP_COLORS.grey)[1]);
    chip.title = `Saved tab group${g.name ? ` “${g.name}”` : ""}: ${g.tabs.length} tab${g.tabs.length === 1 ? "" : "s"}\n${g.tabs.slice(0, 8).map((t) => t.title || hostOf(t.url)).join("\n")}`;
    const dot = document.createElement("span");
    dot.className = "saved-group-dot";
    const title = document.createElement("span");
    title.className = "bm-title";
    title.textContent = g.name || `${g.tabs.length} tab${g.tabs.length === 1 ? "" : "s"}`;
    chip.append(dot, title);
    chip.addEventListener("click", () => openSavedGroup(g));
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(
        [
          { header: g.name || "Saved group" },
          ...g.tabs.slice(0, 12).map((t) => ({ label: t.title || hostOf(t.url), iconName: "globe", action: () => createTab(t.url) })),
          "-",
          { label: "Open group", iconName: "layers", action: () => openSavedGroup(g) },
          { label: "Delete saved group", iconName: "trash", danger: true, action: () => forgetSavedGroup(g.id) },
        ],
        e.clientX,
        e.clientY
      );
    });
    bar.appendChild(chip);
  }
  if (!bookmarks.length && !bookmarkFolders.length) {
    if (!bar.children.length) bar.innerHTML = `<span class="bm-empty">Bookmarks you star show up here</span>`;
    return;
  }
  // Its folders, then the bookmarks right on it (not in a folder).
  for (const f of bookmarkFolders.filter((f) => !f.parent)) {
    const chip = document.createElement("div");
    chip.className = "bm-chip bm-folder";
    chip.dataset.folder = f.id;
    chip.title = f.title;
    const title = document.createElement("span");
    title.className = "bm-title";
    title.textContent = f.title;
    chip.insertAdjacentHTML("beforeend", icon("folder", 14));
    chip.append(title);
    const open = (dropdown) => {
      const r = chip.getBoundingClientRect();
      showBookmarkFolder(f.id, r.left, r.bottom + 2, dropdown);
    };
    chip.addEventListener("click", () => open(true));
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const all = bookmarksUnder(f.id);
      showContextMenu(
        [
          { header: f.title },
          { label: `Open all ${all.length} in new tabs`, iconName: "tabs", disabled: !all.length, action: () => openAllBookmarks(all) },
          { label: "Show in bookmark manager", iconName: "bookmark", action: () => openBookmarkManager(f.id) },
        ],
        e.clientX,
        e.clientY
      );
    });
    bar.appendChild(chip);
  }
  for (const b of bookmarks.filter((b) => !b.folder)) {
    const chip = document.createElement("div");
    chip.className = "bm-chip";
    chip.dataset.bookmark = b.id || "";
    chip.title = `${b.title}\n${b.url}`;
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      bookmarkChipMenu(b, e.clientX, e.clientY);
    });
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

// The star (Ctrl+D): bookmarks the page -- with a small picture of it, for
// the manager's cards -- and opens its popup to name it, file it in a
// folder, tag it (bookmark.html). On a page that's bookmarked already it
// just opens the popup, which can remove it.
async function toggleBookmark() {
  const tab = findTab(activeTabId);
  if (!tab || !tab.url || tab.url.startsWith("kessel://")) return;
  const existing = bookmarks.find((b) => b.url === tab.url);
  if (existing) return showBookmarkPopup(existing, false);
  const id = await invoke("add_bookmark", { url: tab.url, title: tab.title || tab.url, tab: tab.id });
  await refreshBookmarks();
  const added = bookmarks.find((b) => b.id === id) || bookmarks.find((b) => b.url === tab.url);
  if (added) showBookmarkPopup(added, true);
  else toast("Bookmarked");
}

async function showBookmarkPopup(b, added) {
  const rect = document.getElementById("star-btn").getBoundingClientRect();
  await invoke("toggle_popup", { kind: "bookmark", x: rect.right + 8, y: rect.bottom, width: 340, height: 290, init: { id: b.id || "", url: b.url, title: b.title, added } }).catch(() => toast(added ? "Bookmarked" : "Already bookmarked"));
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
  renderRailPanels();
}

// --- The side panel's own pages, and the AI assistant -----------------------------------
// The rail has a button for each page of sidebar.html picked in Settings ->
// Side panel; they all open that page in the side panel, and while it's
// open another of them only turns its page (no new webview). The AI
// assistant opens its website there instead -- with a question typed in,
// for "Ask AI about this" (right-click on a page).

const isAiKind = (kind) => /^ai(-ask)?(:|$)/.test(kind || "");

function renderRailPanels() {
  const box = document.getElementById("rail-panels");
  const ids = currentSettings()?.sidebar_items ?? DEFAULT_RAIL_ITEMS;
  const items = ids.map((id) => RAIL_ITEMS.find((i) => i.id === id)).filter(Boolean);
  const key = `${ids.join()}|${openPanelKind}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    ...items.map((item) => {
      const b = document.createElement("button");
      b.className = "rail-btn";
      b.dataset.panel = item.id;
      b.title = item.id === "ai" ? `AI assistant (${aiTarget(currentSettings()).name})` : item.label;
      b.innerHTML = icon(item.icon, 18);
      b.classList.toggle("panel-open", item.id === "ai" ? isAiKind(openPanelKind) : openPanelKind === `sidebar:${item.id}`);
      b.addEventListener("click", () => (item.id === "ai" ? openAiPanel() : openSidebarPanel(item.id)));
      return b;
    })
  );
}

// Shows side panel page `panel` (sidebar.html). `extra`: what else it's to
// show (a note: noteId); `keep`: don't close it if it's the one showing.
async function openSidebarPanel(panel, { keep = false, ...extra } = {}) {
  const kind = `sidebar:${panel}`;
  if (openPanelKind === kind && !keep && !extra.noteId) return toggleSidePanel(kind, `kessel://sidebar/${panel}`);
  if (openPanelKind?.startsWith("sidebar:")) {
    await invoke("tell_side_panel", { message: { type: "show", panel, ...extra } }).catch(() => {});
    await invoke("set_side_panel_kind", { kind }).catch(() => {});
    return;
  }
  const query = extra.noteId ? `?note=${encodeURIComponent(extra.noteId)}` : "";
  await toggleSidePanel(kind, `kessel://sidebar/${panel}${query}`);
}

// The AI assistant in the side panel -- asked `prompt`, if given. A second
// click on its button closes it.
async function openAiPanel(prompt = "") {
  const target = aiTarget(currentSettings(), prompt);
  if (!prompt && isAiKind(openPanelKind)) return toggleSidePanel(openPanelKind, target.url);
  if (prompt && !target.typed) {
    const copied = await navigator.clipboard.writeText(prompt).then(
      () => true,
      () => false
    );
    toast(copied ? `Your question is copied -- paste it into ${target.name} (Ctrl+V)` : `${target.name} doesn't take a question in its address -- ask it there`);
  }
  await toggleSidePanel(prompt ? `ai-ask:${Date.now()}` : "ai", target.url);
}

// Kessel's items in a page's right-click menu (sidebar.rs).
async function onPageMenu({ action, value, page, title, tab }) {
  const pageTitle = findTab(tab)?.title || "";
  const fail = (err) => toast(String(err));
  switch (action) {
    case "reading-link":
    case "reading-page":
      await invoke("add_to_reading_list", { url: value, title: (action === "reading-link" ? title : pageTitle) || value })
        .then(() => toast("Added to your reading list"))
        .catch(fail);
      break;
    case "note-selection": {
      const note = await invoke("save_note", { note: { id: "", text: value, url: page, title: pageTitle, pinned: false } }).catch(fail);
      if (note) {
        toast("Saved to your notes");
        openSidebarPanel("notes", { keep: true, noteId: note.id });
      }
      break;
    }
    case "ai-selection":
      openAiPanel(aiPrompt({ page, title: pageTitle, selection: value }));
      break;
    case "ai-page":
      openAiPanel(aiPrompt({ page: value, title: pageTitle }));
      break;
    case "highlight-selection":
      await invoke("page_tool", { id: tab, tool: "highlight" }).catch(fail);
      break;
    case "search-selection": {
      const t = findTab(tab);
      await createTab(searchUrlFor(value), t?.account ?? activeAccount(), { after: tab });
      break;
    }
    case "search-image": {
      const which = currentSettings()?.features?.image_search || "google";
      const template = IMAGE_SEARCH[which] || IMAGE_SEARCH.google;
      await createTab(template.replace("%s", encodeURIComponent(value)), findTab(tab)?.account ?? activeAccount(), { after: tab });
      break;
    }
    case "peek-link": {
      // A small window over the page; "Back to tabs" in it makes it a tab.
      const w = window.innerWidth, h = window.innerHeight;
      await invoke("pop_out", { url: value, title, account: findTab(tab)?.account ?? null, x: Math.round(window.screenX + w * 0.2), y: Math.round(window.screenY + h * 0.12) }).catch(fail);
      break;
    }
  }
}

// What the side panel's page asks of this window (sidebar.js).
function onSidePanelMessage(m) {
  switch (m?.type) {
    case "workspaces-get":
      tellWorkspaces(true);
      break;
    case "workspace-switch":
      switchWorkspace(m.id);
      break;
    case "workspace-new":
      addWorkspace(m);
      break;
    case "workspace-edit":
      editWorkspace(m);
      break;
    case "workspace-delete":
      deleteWorkspace(m.id);
      break;
    case "workspace-move-tab":
      if (findTab(activeTabId)) moveTabsToWorkspace([findTab(activeTabId)], m.id);
      break;
    case "web-search":
      if (/^https?:\/\//i.test(m.url || "")) toggleSidePanel(`search-web:${Date.now()}`, m.url);
      break;
    case "ai-open":
      openAiPanel();
      break;
  }
}

// --- Workspaces ------------------------------------------------------------------------
// Named sets of tabs. Settings keeps the list for every window --
// workspaces [{ id, name, icon, color }] -- and the first one, id "", is
// always there (it's where tabs are when you've made none). A window shows
// one workspace's tabs at a time; the other workspaces' tabs sleep (no
// webview, nothing running, no memory) and wake as you come back, and
// their tab groups go with them. The window's session keeps them all. A
// workspace's colour tints its window.

let currentWorkspace = "";
const parkedWorkspaces = new Map(); // workspace id -> { tabs, active (index), groups }
let switchingWorkspace = false;

function workspaceList() {
  const stored = Array.isArray(currentSettings()?.workspaces) ? currentSettings().workspaces.filter((w) => w && typeof w.id === "string") : [];
  const first = stored.find((w) => w.id === "") || { id: "", name: "Home", icon: "🏠", color: WORKSPACE_COLORS[0] };
  return [first, ...stored.filter((w) => w.id !== "")];
}

function workspaceTabCount(id) {
  return id === currentWorkspace ? tabs.length : parkedWorkspaces.get(id)?.tabs.length || 0;
}

function renderWorkspaces() {
  const box = document.getElementById("rail-workspaces");
  const list = workspaceList();
  box.hidden = !!WIN.private || list.length < 2;
  if (!box.hidden) {
    box.replaceChildren(
      ...list.map((w) => {
        const b = document.createElement("button");
        b.className = "ws-btn" + (w.id === currentWorkspace ? " current" : "");
        b.style.setProperty("--ws", w.color || "var(--accent)");
        b.textContent = w.icon || (w.name || "?")[0];
        const n = workspaceTabCount(w.id);
        b.title = `${w.name} -- ${tabCount(n)}${w.id === currentWorkspace ? " (you're here)" : ""}`;
        if (w.id !== currentWorkspace && n) b.insertAdjacentHTML("beforeend", `<span class="ws-count">${n > 99 ? "99+" : n}</span>`);
        b.addEventListener("click", () => switchWorkspace(w.id));
        b.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const here = w.id === currentWorkspace;
          showContextMenu(
            [
              { header: w.name },
              { label: "Switch to it", iconName: "layers", disabled: here, action: () => switchWorkspace(w.id) },
              { label: "Move the tab you're on here", iconName: "arrowRight", disabled: here || !findTab(activeTabId), action: () => moveTabsToWorkspace([findTab(activeTabId)], w.id) },
              "-",
              { label: "Manage workspaces…", iconName: "edit", action: () => openSidebarPanel("workspaces", { keep: true }) },
              { label: "Delete workspace", iconName: "trash", danger: true, disabled: !w.id, action: () => deleteWorkspace(w.id) },
            ],
            e.clientX,
            e.clientY
          );
        });
        return b;
      })
    );
  }
  applyWorkspaceTint();
  tellWorkspaces();
}

// The side panel's Workspaces page, if it's up (or `asked`).
function tellWorkspaces(asked = false) {
  if (!asked && !openPanelKind?.startsWith("sidebar:")) return;
  const list = workspaceList().map((w) => ({ ...w, tabs: workspaceTabCount(w.id) }));
  invoke("tell_side_panel", { message: { type: "workspaces", current: currentWorkspace, list } }).catch(() => {});
}

// A workspace's colour is its window's accent while you're in it.
let styleAccent = null;
function applyWorkspaceTint() {
  const root = document.documentElement;
  const w = workspaceList().find((x) => x.id === currentWorkspace);
  if (currentWorkspace && w?.color) {
    if (styleAccent === null) styleAccent = root.style.getPropertyValue("--accent");
    root.style.setProperty("--accent", w.color);
  } else if (styleAccent !== null) {
    root.style.setProperty("--accent", styleAccent);
    styleAccent = null;
  }
}

// A sleeping copy of `t`, to wait in another workspace.
function parkedCopy(t) {
  return { ...t, id: t.id > 0 && !t.discarded ? nextPlaceholderId() : t.id, discarded: true, neverCreated: true, loading: false, audible: false, frozen: false, memory: null, cpu: null };
}

async function switchWorkspace(id) {
  if (id === currentWorkspace || switchingWorkspace || WIN.private || !workspaceList().some((w) => w.id === id)) return;
  switchingWorkspace = true;
  try {
    const leaving = currentWorkspace;
    const outgoing = tabs;
    const outgoingActive = outgoing.findIndex((t) => t.id === activeTabId);
    const outgoingGroups = [...tabGroups.values()].filter((g) => outgoing.some((t) => t.group === g.id));
    if (split) await invoke("unsplit").catch(() => {});
    // The other workspace's tabs, in the strip at once...
    const incoming = parkedWorkspaces.get(id);
    parkedWorkspaces.delete(id);
    for (const g of outgoingGroups) tabGroups.delete(g.id);
    for (const g of incoming?.groups || []) tabGroups.set(g.id, g);
    tabs = incoming?.tabs || [];
    currentWorkspace = id;
    recentTabs = [];
    clearSelection();
    if (tabs.length) await activateTab(tabs[Math.min(Math.max(incoming.active ?? 0, 0), tabs.length - 1)].id);
    else await createTab();
    // ...and the ones left behind go to sleep.
    const parked = outgoing.map(parkedCopy);
    for (const t of outgoing) if (t.id > 0 && !t.discarded) invoke("close_tab", { id: t.id, url: null }).catch(() => {});
    parkedWorkspaces.set(leaving, { tabs: parked, active: outgoingActive, groups: outgoingGroups });
    normalizeGroups();
    syncTabOrder();
    renderTabs();
    renderWorkspaces();
    persistSession();
    playSound("switch");
  } finally {
    switchingWorkspace = false;
  }
}

async function saveWorkspaces(list) {
  // The first one only needs keeping once it's been changed.
  const home = list[0];
  const stored = home.name === "Home" && home.icon === "🏠" && home.color === WORKSPACE_COLORS[0] ? list.slice(1) : list;
  await saveSettings({ workspaces: stored });
}

async function addWorkspace({ name, icon: glyph, color }) {
  if (WIN.private) return toast("Private windows have no workspaces");
  const id = `ws-${Date.now().toString(36)}`;
  await saveWorkspaces([...workspaceList(), { id, name: name || "Workspace", icon: glyph || "💼", color: color || WORKSPACE_COLORS[1] }]);
  await switchWorkspace(id);
}

async function editWorkspace({ id, name, icon: glyph, color }) {
  await saveWorkspaces(workspaceList().map((w) => (w.id === id ? { ...w, name: name || w.name, icon: glyph || w.icon, color: color || w.color } : w)));
}

async function deleteWorkspace(id) {
  if (!id) return;
  await saveWorkspaces(workspaceList().filter((w) => w.id !== id));
  reconcileWorkspaces();
}

// Workspaces that are gone (deleted here or in another window): their tabs
// join the first one.
function reconcileWorkspaces() {
  const known = new Set(workspaceList().map((w) => w.id));
  const adopt = (parked) => {
    if (!parked) return;
    if (currentWorkspace === "") {
      tabs.push(...parked.tabs);
      for (const g of parked.groups) tabGroups.set(g.id, g);
    } else {
      const home = parkedWorkspaces.get("") || { tabs: [], active: 0, groups: [] };
      home.tabs.push(...parked.tabs);
      home.groups.push(...parked.groups);
      parkedWorkspaces.set("", home);
    }
  };
  if (!known.has(currentWorkspace)) {
    currentWorkspace = "";
    const home = parkedWorkspaces.get("");
    parkedWorkspaces.delete("");
    adopt(home);
  }
  for (const [id, parked] of [...parkedWorkspaces]) {
    if (!known.has(id)) {
      parkedWorkspaces.delete(id);
      adopt(parked);
    }
  }
  normalizeGroups();
  syncTabOrder();
  renderTabs();
  renderWorkspaces();
  persistSession();
}

// Tabs `list` of this workspace move to workspace `id` (asleep there).
async function moveTabsToWorkspace(list, id) {
  list = list.filter((t) => t && tabs.includes(t));
  if (!list.length || id === currentWorkspace) return;
  const w = workspaceList().find((x) => x.id === id);
  if (!w) return;
  if (list.length === tabs.length) await createTab();
  if (list.some((t) => t.id === activeTabId)) {
    const stay = tabs.find((t) => !list.includes(t));
    if (stay) await activateTab(stay.id);
  }
  const target = parkedWorkspaces.get(id) || { tabs: [], active: 0, groups: [] };
  for (const t of list) {
    tabs.splice(tabs.indexOf(t), 1);
    if (t.id > 0 && !t.discarded) invoke("close_tab", { id: t.id, url: null }).catch(() => {});
    target.tabs.push({ ...parkedCopy(t), group: null });
  }
  parkedWorkspaces.set(id, target);
  clearSelection();
  normalizeGroups();
  syncTabOrder();
  renderTabs();
  renderWorkspaces();
  persistSession();
  toast(`${list.length === 1 ? "Moved the tab" : `Moved ${list.length} tabs`} to “${w.name}”`);
}

// --- Extensions in the address bar -----------------------------------------------------
// The puzzle button (once there's an extension that runs, and not in a
// private window, where they don't) opens extensions.html: each one's
// popup is a click away. On an extension's page in the Chrome Web Store or
// Edge Add-ons, "Add to Kessel" installs it.

let installedExtensions = [];

// A store's page for an extension: { store, id }.
function extensionStorePage(url) {
  try {
    const u = new URL(url);
    const store = /^(chromewebstore\.google\.com|chrome\.google\.com)$/i.test(u.hostname) ? "chrome" : /^microsoftedge\.microsoft\.com$/i.test(u.hostname) ? "edge" : null;
    if (!store || (store === "chrome" && u.hostname.startsWith("chrome.") && !u.pathname.startsWith("/webstore/"))) return null;
    const id = u.pathname.split("/").reverse().find((s) => /^[a-p]{32}$/.test(s));
    return id ? { store, id } : null;
  } catch {
    return null;
  }
}

function updateExtensionButtons() {
  const ext = document.getElementById("ext-btn");
  ext.hidden = !!WIN.private || !installedExtensions.some((e) => e.enabled && !e.theme);
  const add = document.getElementById("store-add-btn");
  const page = WIN.private ? null : extensionStorePage(findTab(activeTabId)?.url || "");
  add.hidden = !page;
  if (page) {
    const have = installedExtensions.find((e) => e.id === page.id);
    add.classList.toggle("installed", !!have);
    add.innerHTML = `${icon(have ? "check" : "plus", 12)}<span>${have ? "In Kessel" : "Add to Kessel"}</span>`;
    add.title = have ? `${have.name} is in Kessel -- click to manage it` : "Add this extension to Kessel";
  }
}

async function toggleExtensionsPopup(init = { mode: "list" }) {
  const btn = document.getElementById(init.mode === "install" ? "store-add-btn" : "ext-btn");
  const r = btn.getBoundingClientRect();
  // The extensions' own popups open under the puzzle button.
  const anchor = document.getElementById("ext-btn").getBoundingClientRect();
  const at = { x: Math.round((anchor.width ? anchor : r).right), y: Math.round((anchor.width ? anchor : r).bottom) };
  await invoke("toggle_popup", { kind: "extensions", x: r.right, y: r.bottom, width: 340, height: init.mode === "install" ? 460 : 380, init: { ...init, ...at } }).catch((err) => toast(String(err)));
}

function onStoreAddClick() {
  const page = extensionStorePage(findTab(activeTabId)?.url || "");
  if (!page) return;
  if (installedExtensions.some((e) => e.id === page.id)) {
    invoke("open_singleton_tab", { route: "kessel://settings/extensions" }).catch(() => {});
    return;
  }
  toggleExtensionsPopup({ mode: "install", ...page });
}

async function refreshExtensions(list) {
  installedExtensions = list || (await invoke("list_extensions").catch(() => [])) || [];
  updateExtensionButtons();
}

// --- A full tab strip -------------------------------------------------------------
// Tabs shrink toward their icons as the strip fills (or, set to scroll, keep
// their titles). Once they can't shrink any more the strip scrolls: with
// the mouse wheel, or the arrows that appear at its ends; the tab you're
// on is always scrolled into view, and tab search lists every tab.

function updateStripOverflow() {
  const strip = document.getElementById("tabs");
  // Too narrow for a title: just the icon (and the close button, on the
  // tab you're on).
  const vertical = isVerticalTabs();
  for (const el of strip.querySelectorAll(".tab:not(.pinned)")) el.classList.toggle("narrow", !vertical && el.getBoundingClientRect().width < 84);
  const over = !vertical && strip.scrollWidth > strip.clientWidth + 1;
  document.getElementById("tab-bar").classList.toggle("overflowing", over);
  document.getElementById("tabs-scroll-left").hidden = !over || strip.scrollLeft <= 1;
  document.getElementById("tabs-scroll-right").hidden = !over || strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
  const keys = commandKeys("search-tabs");
  document.getElementById("tab-search-btn").title = `Search tabs${keys ? ` (${keys})` : ""} -- ${tabs.length} open`;
}

let lastWheelSwitch = 0;

// Through the strip in its order (the wheel), whatever Ctrl+Tab is set to.
function cycleTabsInOrder(direction) {
  const shown = tabs.filter((t) => !isHiddenInGroup(t));
  if (shown.length < 2) return;
  const at = shown.findIndex((t) => t.id === activeTabId);
  activateTab(shown[(at + direction + shown.length) % shown.length].id);
}

function wireStripScrolling() {
  const strip = document.getElementById("tabs");
  strip.addEventListener(
    "wheel",
    (e) => {
      // The wheel switches tabs, if you want it to (Settings -> Tabs).
      if (currentSettings()?.tab_wheel_switch && !e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        const now = performance.now();
        if (now - lastWheelSwitch > 60) {
          lastWheelSwitch = now;
          cycleTabsInOrder(e.deltaY > 0 ? 1 : -1);
        }
        return;
      }
      if (isVerticalTabs() || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    },
    { passive: false }
  );
  strip.addEventListener("scroll", () => {
    hideHoverCard();
    updateStripOverflow();
  });
  document.getElementById("tabs-scroll-left").addEventListener("click", () => strip.scrollBy({ left: -strip.clientWidth * 0.75, behavior: "smooth" }));
  document.getElementById("tabs-scroll-right").addEventListener("click", () => strip.scrollBy({ left: strip.clientWidth * 0.75, behavior: "smooth" }));
  new ResizeObserver(updateStripOverflow).observe(strip);
}

// --- Media controls (media.html) ------------------------------------------------------
// The music-note button beside the menu: every tab in this window that has
// played sound, with play/pause, seeking, speed, captions, audio tracks and
// picture-in-picture (see media.rs). Chrome's "global media controls".

function mediaTabs() {
  return tabs.filter((t) => t.mediaSeen && !t.discarded && t.id > 0);
}

function updateMediaButton() {
  const button = document.getElementById("media-btn");
  if (!button) return;
  const list = mediaTabs();
  button.hidden = !list.length;
  button.classList.toggle("playing", list.some((t) => t.audible && !t.muted));
}

async function toggleMediaPopup() {
  const list = mediaTabs();
  const button = document.getElementById("media-btn");
  if (!list.length || button.hidden) return toast("Nothing has played in this window yet");
  const rect = button.getBoundingClientRect();
  const init = {
    toolbar: `toolbar-${WIN.number}`,
    active: activeTabId,
    tabs: list.map(({ id, title, url, favicon }) => ({ id, title: title || "", url: url || "", favicon: favicon || "" })),
  };
  const height = Math.min(620, 70 + list.length * 214);
  await invoke("toggle_popup", { kind: "media", x: rect.right, y: rect.bottom, width: 380, height, init }).catch(() => {});
}

// --- Command palette (palette.html) ---------------------------------------------------
// F2: every command, searchable; runs the one you pick in this window.

async function toggleCommandPalette() {
  hideHoverCard();
  const width = Math.min(560, Math.max(320, window.innerWidth - 40));
  const x = Math.round(window.innerWidth / 2 + width / 2);
  const y = Math.round(document.getElementById("nav-bar")?.getBoundingClientRect().bottom || 80);
  await invoke("toggle_popup", { kind: "palette", x, y, width, height: 460, init: {} }).catch(() => {});
}

// --- Screenshots (tools.rs, take_screenshot) -------------------------------------------
// What's in view, or the whole page; saved to your pictures, copied, or both
// (Settings -> Page tools).

async function takeScreenshot(page, full, area = null) {
  const shot = await invoke("take_screenshot", { id: page, full, area }).catch((err) => {
    toast(`Couldn't take a screenshot -- ${err}`);
    return null;
  });
  if (!shot) return;
  // Settings -> Page tools -> "Open it in the editor".
  if (shot.edit) {
    await createTab(`kessel://shot?k=${encodeURIComponent(shot.edit)}`, null, { after: page });
    return;
  }
  let copied = false;
  if (shot.data) {
    try {
      let blob = await (await fetch(`data:${shot.mime};base64,${shot.data}`)).blob();
      // The clipboard takes PNG only.
      if (shot.mime !== "image/png") {
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        blob = await canvas.convertToBlob({ type: "image/png" });
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      copied = true;
    } catch {}
  }
  const saved = shot.path ? `Saved to ${shot.path}` : "";
  if (saved && copied) toast(`${saved} and copied`);
  else if (saved) toast(saved);
  else toast(copied ? "Screenshot copied" : "Couldn't copy the screenshot");
}

// --- Reader view (reader.html) ---------------------------------------------------------
// The article on the page, on its own: your font, size, width and colours.

async function openReader(page) {
  const tab = findTab(page);
  if (tab?.url?.startsWith("kessel://reader")) return invoke("page_action", { id: page, action: "back", value: null }).catch(() => {});
  if (!tab || !/^(https?|file):/.test(tab.url || "")) return toast("Reader view works on web pages");
  const key = await invoke("reader_open", { id: page }).catch(() => null);
  if (!key) return toast("No article found on this page");
  await invoke("navigate", { id: page, url: `kessel://reader?k=${encodeURIComponent(key)}`, httpFallback: false }).catch((err) => toast(String(err)));
}

// --- Save as PDF (tools.rs, save_pdf) --------------------------------------------------

async function savePdf(page) {
  const tab = findTab(page);
  if (!tab || !/^(https?|file):/.test(tab.url || "")) return toast("Only web pages can be saved as PDF");
  const path = await invoke("save_pdf", { id: page, title: tab.title || hostOf(tab.url) }).catch((err) => {
    toast(`Couldn't save the PDF -- ${err}`);
    return null;
  });
  if (path) toast(`Saved to ${path}`);
}

// --- Feeds (feeds.html) ----------------------------------------------------------------
// Follows the feed the page offers (its RSS / Atom link); kessel://feeds
// shows what's new, fetched by Kessel itself -- no account anywhere.

async function followFeed(tab) {
  if (!tab || !/^https?:/.test(tab.url || "")) return toast("Open a site first");
  const found = await invoke("page_feeds", { id: tab.id }).catch(() => []);
  if (!found?.length) return toast("This page doesn't offer a feed");
  const add = async (feed) => {
    const features = currentSettings()?.features || {};
    const list = Array.isArray(features.feeds) ? features.feeds : [];
    if (list.some((f) => f.url === feed.url)) return toast("You already follow it -- see Feeds in the command palette");
    await saveSettings({ features: { ...features, feeds: [...list, { url: feed.url, title: feed.title || tab.title || hostOf(tab.url), site: tab.url }] } });
    toast(`Following ${feed.title || hostOf(tab.url)}. Feeds are in the command palette (F2).`);
  };
  if (found.length === 1) return add(found[0]);
  const rect = document.getElementById("address-wrap")?.getBoundingClientRect() || { right: window.innerWidth / 2, bottom: 80 };
  showContextMenu([{ header: "Follow which feed?" }, ...found.map((f) => ({ label: f.title || f.url, action: () => add(f) }))], rect.right - 300, rect.bottom, { dropdown: true, width: 300 });
}

// --- Pause everything ---------------------------------------------------------------
// Every tab in this window stops its videos and goes quiet; again to bring
// the sound back (the videos stay paused, for you to start).

let breakMuted = null;
async function toggleBreakMode() {
  if (breakMuted) {
    for (const id of breakMuted) {
      const t = findTab(id);
      if (!t || t.discarded) continue;
      t.muted = false;
      await invoke("page_action", { id, action: "unmute", value: null }).catch(() => {});
    }
    breakMuted = null;
    document.documentElement.classList.remove("break-mode");
    renderTabs();
    return toast("Back from your break");
  }
  breakMuted = [];
  for (const t of tabs) {
    if (!(t.id > 0) || t.discarded) continue;
    invoke("page_tool", { id: t.id, tool: "pause-media" }).catch(() => {});
    if (!t.muted) {
      t.muted = true;
      breakMuted.push(t.id);
      await invoke("page_action", { id: t.id, action: "mute", value: null }).catch(() => {});
    }
  }
  document.documentElement.classList.add("break-mode");
  renderTabs();
  toast("Everything's paused. Run “Pause everything” again to carry on.");
}

// A part of the page picked for a screenshot (page-tools.js).
function onAreaPicked({ id, area }) {
  if (findTab(id)) takeScreenshot(id, false, area);
}

// --- Page right-click menu extras ----------------------------------------------------

// Searching the web for a picture: which service (Settings -> Page tools).
// Your default search engine's results for `text`.
function searchUrlFor(text) {
  const s = currentSettings();
  return engineById(s, s?.search_engine).url(String(text).trim());
}

const IMAGE_SEARCH = {
  google: "https://lens.google.com/uploadbyurl?url=%s",
  bing: "https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:%s",
  yandex: "https://yandex.com/images/search?rpt=imageview&url=%s",
  tineye: "https://tineye.com/search?url=%s",
};

// --- Auto-reload ---------------------------------------------------------------------
// Reloads this site's pages every so often (kept per site, in its tweaks).

function siteKeyOf(url) {
  return /^https?:/.test(url || "") ? hostOf(url).replace(/^www\./, "") : "";
}

function autoReloadMenu(tab) {
  const site = siteKeyOf(tab?.url);
  if (!site) return toast("Auto-reload works on web pages");
  const features = currentSettings()?.features || {};
  const current = Number(features.site_tweaks?.[site]?.reload) || 0;
  const choices = (Array.isArray(features.reload_intervals) ? features.reload_intervals : [15, 30, 60, 300, 900, 1800]).map(Number).filter((n) => n >= 5);
  const label = (sec) => (sec < 60 ? `${sec} seconds` : sec < 3600 ? `${Math.round(sec / 60)} minute${sec >= 120 ? "s" : ""}` : `${Math.round(sec / 3600)} hour${sec >= 7200 ? "s" : ""}`);
  const set = (sec) => {
    const tweaks = { ...(features.site_tweaks || {}) };
    tweaks[site] = { ...(tweaks[site] || {}), reload: sec };
    if (!sec) delete tweaks[site].reload;
    saveSettings({ features: { ...features, site_tweaks: tweaks } });
    toast(sec ? `${site} reloads every ${label(sec)}` : `Auto-reload off for ${site}`);
  };
  const items = [
    { header: `Auto-reload ${site}` },
    ...choices.map((sec) => ({ label: `Every ${label(sec)}`, checked: current === sec, action: () => set(sec) })),
    "-",
    { label: "Off", checked: !current, action: () => set(0) },
  ];
  const rect = document.getElementById("address-wrap")?.getBoundingClientRect() || { right: window.innerWidth / 2, bottom: 80 };
  showContextMenu(items, rect.right - 240, rect.bottom, { dropdown: true, width: 240 });
}

// Closes the tabs showing the same address as another one (not pinned ones,
// and not the one you're on).
function closeDuplicateTabs() {
  const seenUrls = new Set();
  const active = findTab(activeTabId);
  if (active?.url) seenUrls.add(active.url);
  const duplicates = tabs.filter((t) => {
    if (!t.url || t.pinned || t.id === activeTabId || t.url.startsWith("kessel://")) return false;
    if (seenUrls.has(t.url)) return true;
    seenUrls.add(t.url);
    return false;
  });
  if (!duplicates.length) return toast("No duplicate tabs");
  closeTabs(duplicates);
  toast(`Closed ${duplicates.length} duplicate tab${duplicates.length > 1 ? "s" : ""}`);
}

// --- Tab search (tabsearch.html) -----------------------------------------------------
// Every tab of every window, sleeping ones too, plus recently closed ones:
// type to find one, Enter to go there.

async function toggleTabSearch() {
  hideHoverCard();
  const rect = document.getElementById("tab-search-btn").getBoundingClientRect();
  const width = 420;
  // Under its button -- in a vertical strip, starting at it.
  const x = isVerticalTabs() ? rect.left + width : rect.right;
  await invoke("toggle_popup", { kind: "tabsearch", x, y: rect.bottom, width, height: 520, init: { window: WIN.label, toolbar: `toolbar-${WIN.number}` } }).catch(() => {});
}

// --- Vertical tabs ---------------------------------------------------------------------
// The strip as a column between the rail and the page (Settings -> Tabs):
// wide with titles, or collapsed to icons; its right edge drags wider.

function isVerticalTabs() {
  return document.documentElement.classList.contains("vertical-tabs");
}

function applyTabLayout() {
  const s = currentSettings() || {};
  const vertical = s.tab_layout === "vertical";
  const collapsed = vertical && !!s.vertical_tabs_collapsed;
  const root = document.documentElement;
  const changed = root.classList.contains("vertical-tabs") !== vertical || root.classList.contains("vtabs-collapsed") !== collapsed;
  root.classList.toggle("vertical-tabs", vertical);
  root.classList.toggle("vtabs-collapsed", collapsed);
  root.classList.toggle("tabs-scroll", s.tab_overflow === "scroll");
  const vtabs = document.getElementById("vtabs");
  vtabs.hidden = !vertical;
  vtabs.style.width = collapsed ? "" : `${Math.round(Math.min(480, Math.max(160, s.vertical_tabs_width ?? 240)))}px`;
  const strip = document.getElementById("tabs");
  const newBtn = document.getElementById("new-tab-btn");
  const searchBtn = document.getElementById("tab-search-btn");
  if (vertical) {
    document.getElementById("vtabs-list").appendChild(strip);
    document.getElementById("vtabs-head").insertBefore(searchBtn, document.getElementById("vtabs-collapse"));
    document.getElementById("vtabs-foot").appendChild(newBtn);
  } else {
    const bar = document.getElementById("tab-bar");
    bar.insertBefore(strip, document.getElementById("tabs-scroll-right"));
    bar.insertBefore(newBtn, document.getElementById("drag-space"));
    bar.insertBefore(searchBtn, document.getElementById("drag-space"));
  }
  const collapse = document.getElementById("vtabs-collapse");
  collapse.innerHTML = icon(collapsed ? "chevronRight" : "chevronLeft", 15);
  collapse.title = collapsed ? "Show tab titles" : "Just icons";
  if (changed) renderTabs();
  reportChromeInsets();
  updateStripOverflow();
}

function wireVerticalTabs() {
  document.getElementById("vtabs-collapse").addEventListener("click", () => saveSettings({ vertical_tabs_collapsed: !currentSettings()?.vertical_tabs_collapsed }));
  const vtabs = document.getElementById("vtabs");
  const grip = document.getElementById("vtabs-resize");
  grip.addEventListener("pointerdown", (e) => {
    if (document.documentElement.classList.contains("vtabs-collapsed")) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = vtabs.getBoundingClientRect().width;
    let width = startWidth;
    const move = (ev) => {
      width = Math.round(Math.min(480, Math.max(160, startWidth + ev.clientX - startX)));
      vtabs.style.width = `${width}px`;
      reportChromeInsets();
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      if (width !== startWidth) saveSettings({ vertical_tabs_width: width });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
}

// --- Hover cards (hovercard.html) --------------------------------------------------
// Resting the mouse on a tab shows a card with its title, site, state and --
// as set in Settings -> Tabs -- a preview of the page and its memory use.
// The first takes a moment; moving along the strip, the next ones come at
// once.

let hoverTimer = null;
let hoverTab = null; // the tab a card is (about to be) shown for
let hoverShown = false;
let hoverHiddenAt = 0;

function wireHoverCard(el) {
  el.addEventListener("mouseenter", () => {
    if (drag || press || currentSettings()?.tab_hover_cards === false) return;
    const id = parseInt(el.dataset.tabId, 10);
    clearTimeout(hoverTimer);
    hoverTab = id;
    const warm = hoverShown || Date.now() - hoverHiddenAt < 900;
    hoverTimer = setTimeout(() => showHoverCard(id), warm ? 40 : 550);
  });
  el.addEventListener("mouseleave", hideHoverCard);
  el.addEventListener("mousedown", hideHoverCard);
}

function hoverInfo(tab, preview) {
  const s = currentSettings() || {};
  const group = groupOf(tab);
  const internal = !tab.url || tab.url.startsWith("kessel://");
  return {
    id: tab.id,
    title: tab.title || (tab.url ? hostOf(tab.url) : "New Tab"),
    host: internal ? "Kessel" : tab.url.startsWith("file:") ? "File on this PC" : hostOf(tab.url),
    secure: /^https:/.test(tab.url || ""),
    state: tab.discarded ? "sleeping" : tab.frozen ? "frozen" : null,
    audible: !!tab.audible,
    muted: !!tab.muted,
    pinned: !!tab.pinned,
    attention: !!tab.attention,
    group: group ? { name: group.name, color: groupColor(group) } : null,
    account: accountById(tab.account) ? { name: accountById(tab.account).name, color: accountById(tab.account).color } : null,
    showMemory: s.hover_card_memory !== false && !tab.discarded && tab.id > 0,
    memory: tab.memory ?? null,
    cpu: tab.cpu ?? null,
    heavy: isHeavy(tab),
    preview,
    thumbnail: null,
  };
}

// The card's height for what it shows (hovercard.html lays it out to fit).
function hoverCardHeight(info) {
  let h = 24 + (info.title.length > 40 ? 38 : 20) + 20;
  if (info.state || info.audible || info.muted || info.group || info.account || info.attention) h += 22;
  if (info.showMemory) h += 20;
  if (info.preview) h += 164;
  return h;
}

async function showHoverCard(id) {
  const tab = findTab(id);
  const el = document.querySelector(`.tab[data-tab-id="${id}"]`);
  if (!tab || !el || hoverTab !== id || drag || currentSettings()?.tab_hover_cards === false) return;
  // Not measured yet (just opened, or the last reading was a while ago).
  if (tab.memory == null && tab.id > 0 && !tab.discarded && currentSettings()?.hover_card_memory !== false) await pollTabResources();
  if (hoverTab !== id) return;
  const preview = currentSettings()?.hover_card_preview !== false && tab.id > 0 && !tab.discarded;
  const info = hoverInfo(tab, preview);
  const width = 300;
  const height = hoverCardHeight(info);
  const rect = el.getBoundingClientRect();
  let x;
  let y;
  if (isVerticalTabs()) {
    x = document.getElementById("vtabs").getBoundingClientRect().right + 6;
    y = Math.max(4, Math.min(rect.top, window.innerHeight - height - 8));
  } else {
    x = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4));
    y = rect.bottom + 4;
  }
  hoverShown = true;
  await invoke("hover_card", { show: true, x, y, width, height, info }).catch(() => {});
  if (!preview) return;
  const thumbnail = await invoke("tab_thumbnail", { id: tab.id, fresh: tab.id === activeTabId }).catch(() => null);
  if (hoverTab === id && hoverShown) {
    await invoke("hover_card", { show: true, x, y, width, height, info: { ...hoverInfo(tab, preview), thumbnail: thumbnail || "none" } }).catch(() => {});
  }
}

function hideHoverCard() {
  clearTimeout(hoverTimer);
  hoverTab = null;
  if (!hoverShown) return;
  hoverShown = false;
  hoverHiddenAt = Date.now();
  invoke("hover_card", { show: false, x: 0, y: 0, width: 0, height: 0, info: null }).catch(() => {});
}

// --- Memory and CPU -----------------------------------------------------------------------
// Every few seconds, how much each awake tab's page uses (lifecycle.rs):
// for hover cards, tab search, and a warning on tabs using a lot -- over
// 1.5 GB, or most of a CPU core for 10 seconds.

async function pollTabResources() {
  const live = tabs.filter((t) => t.id > 0 && !t.discarded);
  if (!live.length || document.hidden) return;
  const usage = await invoke("tab_resources", { ids: live.map((t) => t.id) }).catch(() => null);
  if (!usage) return;
  let changed = false;
  for (const t of live) {
    const u = usage[String(t.id)];
    if (!u) continue;
    const wasHeavy = isHeavy(t);
    t.memory = u.memory;
    t.cpu = u.cpu;
    t.cpuHigh = (u.cpu ?? 0) >= 60 ? (t.cpuHigh ?? 0) + 1 : 0;
    if (isHeavy(t) !== wasHeavy) changed = true;
  }
  if (changed) renderTabs();
}

// --- Search engine menu ---------------------------------------------------

// The address bar's engine button: which engine searches, as a dropdown
// under it (a popup, so the page doesn't cover it).
function toggleEngineMenu() {
  const current = currentSettings()?.search_engine || "google";
  const rect = document.getElementById("engine-btn").getBoundingClientRect();
  const items = [
    { header: "Search with" },
    ...allEngines(currentSettings()).map((engine) => ({ label: engine.name, keys: engine.keyword || undefined, checked: engine.id === current, action: () => saveSettings({ search_engine: engine.id }) })),
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
  savedGroups = (await invoke("get_saved_groups").catch(() => [])) || [];
  renderBookmarksBar();

  // Before the first tab exists, so Rust places it below the real chrome
  // (and beside vertical tabs).
  wireVerticalTabs();
  applyTabLayout();
  await wireChromeInsets();

  wireTabLifecycle();
  wireTabStrip();
  wireStripScrolling();
  setInterval(pollTabResources, 5000);
  document.getElementById("tab-search-btn").addEventListener("click", toggleTabSearch);
  window.addEventListener("kessel-settings", () => {
    applyTabLayout();
    renderTabs();
  });
  // The mouse left the window, or it lost the focus: no card left behind.
  document.documentElement.addEventListener("mouseleave", hideHoverCard);
  window.addEventListener("blur", hideHoverCard);

  document.getElementById("rail-home").addEventListener("click", () => createTab());
  document.getElementById("rail-add-pin").addEventListener("click", pinCurrentTab);
  document.getElementById("rail-shield").addEventListener("click", toggleShield);
  document.getElementById("rail-downloads").addEventListener("click", () => toggleSidePanel("downloads", "kessel://downloads"));
  document.getElementById("rail-passwords").addEventListener("click", () => toggleSidePanel("passwords", "kessel://passwords"));
  document.getElementById("rail-settings").addEventListener("click", () => toggleSidePanel("settings", "kessel://settings"));

  // The side panel's pages, workspaces and extensions (see above).
  renderRailPanels();
  renderWorkspaces();
  document.getElementById("ext-btn").innerHTML = icon("puzzle", 16);
  document.getElementById("ext-btn").addEventListener("click", () => toggleExtensionsPopup());
  document.getElementById("store-add-btn").addEventListener("click", onStoreAddClick);
  refreshExtensions();
  listen("extensions-changed", (event) => refreshExtensions(event.payload));
  listen("side-panel-message", (event) => onSidePanelMessage(event.payload));
  listen("page-menu", (event) => onPageMenu(event.payload || {}));
  listen("area-picked", (event) => onAreaPicked(event.payload || {}));
  listen("permission-request", (event) => {
    permissionRequests.push(event.payload || {});
    if (permissionRequests.length === 1) showPermissionRequest();
  });
  listen("permission-resolved", (event) => {
    const n = event.payload?.n;
    const at = permissionRequests.findIndex((r) => r.n === n);
    if (at < 0) return;
    const wasShown = at === 0;
    permissionRequests.splice(at, 1);
    if (wasShown) setTimeout(showPermissionRequest, 150);
  });
  window.addEventListener("kessel-settings", () => {
    // The style's colours were just put back: the workspace's go on again.
    styleAccent = null;
    renderRailPanels();
    const known = new Set(workspaceList().map((w) => w.id));
    if (!known.has(currentWorkspace) || [...parkedWorkspaces.keys()].some((id) => !known.has(id))) reconcileWorkspaces();
    else renderWorkspaces();
  });

  document.getElementById("new-tab-btn").addEventListener("click", () => createTab());
  document.getElementById("back-btn").addEventListener("click", () => runCommand("back"));
  document.getElementById("forward-btn").addEventListener("click", () => runCommand("forward"));
  // Reload, or stop while the page is still loading (like Chrome's button).
  document.getElementById("reload-btn").addEventListener("click", () => runCommand(findTab(activeTabId)?.loading ? "stop" : "reload"));
  document.getElementById("star-btn").addEventListener("click", toggleBookmark);
  document.getElementById("home-btn").addEventListener("click", () => runCommand("home"));
  document.getElementById("share-btn").addEventListener("click", toggleSharePopup);
  document.getElementById("media-btn").addEventListener("click", toggleMediaPopup);
  applyToolbarSettings();
  window.addEventListener("kessel-settings", applyToolbarSettings);
  document.getElementById("menu-btn").addEventListener("click", toggleMainMenu);
  document.getElementById("zoom-btn").addEventListener("click", () => runCommand("zoom-reset"));
  document.getElementById("shields-btn").addEventListener("click", toggleShieldsPopup);
  document.getElementById("lock-icon").addEventListener("click", toggleSiteInfo);
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
  // A background tab was frozen (or couldn't be -- see freeze_tab).
  await listen("tab-frozen", (event) => {
    const tab = findTab(event.payload.id);
    if (!tab || tab.id === activeTabId) return;
    tab.frozen = !!event.payload.frozen;
    renderTabs();
  });
  // Saved tab groups changed (here or in another window).
  await listen("saved-groups-changed", (event) => {
    savedGroups = event.payload || [];
    renderBookmarksBar();
    renderTabs();
  });
  // Tab search (tabsearch.html) picked or closed one of this window's tabs.
  await listen("tab-search-activate", (event) => activateTab(event.payload.id));
  await listen("tab-search-close", (event) => closeTab(event.payload.id));
  // The media controls' "go to this tab".
  await listen("media-activate", (event) => activateTab(event.payload.id));
  // A tab started or stopped playing sound, or was (un)muted.
  await listen("tab-audio", (event) => {
    const tab = findTab(event.payload.id);
    if (!tab) return;
    tab.audible = !!event.payload.playing;
    tab.muted = !!event.payload.muted;
    // It has something to play: the media button lists it from now on.
    if (tab.audible) tab.mediaSeen = true;
    if (tab.audible && !tab.muted && tab.id !== activeTabId) muteBackgroundTabs(activeTabId);
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
    const next = tab && keepViewSource(tab, url);
    if (tab && next !== tab.url) {
      tab.url = next;
      // Stale from whatever page this tab was on before -- the new page's
      // own title and icon follow from Rust as it loads (watch_page).
      tab.favicon = null;
      tab.title = hostOf(url);
      tab.userTitled = false;
      autoGroupTab(tab);
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
    // A tab in the background whose (loaded) page changes its title -- a
    // new message, a finished upload -- gets a dot until you look at it.
    const news = tab.userTitled && id !== activeTabId && tab.loadedAt && Date.now() - tab.loadedAt > 1500 && currentSettings()?.tab_attention_dots !== false;
    tab.title = title;
    tab.userTitled = true;
    const el = document.querySelector(`.tab[data-tab-id="${id}"]`);
    if (el) {
      el.querySelector(".tab-title").textContent = title;
      if (!tab.discarded && el.hasAttribute("title")) el.title = title;
    }
    if (news && !tab.attention) {
      tab.attention = true;
      el?.classList.add("attention");
    }
    pushToolbarSnapshot();
  });

  // The page changed its address without loading a new one (YouTube,
  // Gmail...), or a navigation ended somewhere else than it started.
  await listen("tab-url-changed", (event) => {
    const { id } = event.payload;
    const tab = findTab(id);
    const url = tab && keepViewSource(tab, event.payload.url);
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
    if (tab) {
      tab.loading = false;
      tab.loadedAt = Date.now();
      // A picture of the page you're looking at, once it's drawn -- for its
      // hover card and tab search (another is taken as you leave it).
      const id = tab.id;
      setTimeout(() => {
        if (id === activeTabId && currentSettings()?.hover_card_preview !== false) invoke("tab_thumbnail", { id, fresh: true }).catch(() => {});
      }, 1000);
    }
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
      autoGroupTab(findTab(id));
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

  // Another Kessel window being dragged over this strip (tabdrag.rs): a gap
  // opens where its tabs would land; let go there, they move in.
  await listen("tab-drag-over", (event) => showDropGap(event.payload.x, event.payload.y, "Drop to move here"));
  await listen("tab-drag-leave", hideDropGap);
  await listen("absorb-window", async (event) => {
    const before = dropGap ? dropGapTab() : null;
    hideDropGap();
    try {
      const got = await invoke("absorb_window", { source: event.payload.source });
      insertMovedTabs(got, before);
      playSound("attach");
    } catch (err) {
      toast(String(err));
    }
  });
  // Another browser's window held over this strip, then let go.
  await listen("foreign-drag-over", (event) => {
    const { x, y, browser, reading } = event.payload;
    showDropGap(x, y, reading ? `Moving tabs from ${browser}…` : `Let go to move this ${browser} window here`);
  });
  await listen("foreign-drag-leave", hideDropGap);
  await listen("foreign-tabs", (event) => openForeignTabs(event.payload));
  // Split view started, ended or changed (split.rs); a click into the
  // other half makes that tab the active one.
  await listen("split-changed", (event) => {
    split = event.payload || null;
    markSplit();
  });
  await listen("split-focus", (event) => {
    if (!findTab(event.payload.id)) return;
    activeTabId = event.payload.id;
    noteRecent(activeTabId);
    renderTabs();
    updateAddressBarForActiveTab();
  });
  window.addEventListener("resize", layoutSplitDivider);
  // Typing sounds, when the style has them.
  document.getElementById("url-input").addEventListener("keydown", (e) => {
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Enter") playSound(e.key === "Enter" ? "enter" : "key");
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
  await listen("bookmark-folders-changed", (event) => {
    bookmarkFolders = event.payload;
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

  // A risky download waits for you (security.rs).
  listenHere("download-warning", (event) => {
    downloadWarnings.push(event.payload);
    if (downloadWarnings.length === 1) showDownloadWarning();
  });
  await listen("download-resolved", (event) => {
    const at = downloadWarnings.findIndex((w) => w.id === event.payload.id);
    if (at < 0) return;
    downloadWarnings.splice(at, 1);
    if (at === 0) setTimeout(showDownloadWarning, 350);
  });
  await listen("download-discarded", () => {
    activeDownloads = Math.max(0, activeDownloads - 1);
    updateDownloadsBadge();
    toast("Download discarded");
  });
  // An extension its store took down as malware was turned off (extensions.rs).
  await listen("extensions-flagged", (event) => toast(`Turned off ${(event.payload || []).join(", ")}: its store took it down as malware`, { duration: 6000 }));

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
