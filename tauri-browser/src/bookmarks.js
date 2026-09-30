// The bookmark manager (kessel://bookmarks): folders inside folders, search
// (words, or #tag), editing -- name, address, folder, tags, a note --
// moving by dragging or "Move to", sorting, a list or cards with each page's
// preview, HTML import and export, and tidying up: duplicates, links that
// stopped working, and the daily backups (bookmarks.rs).

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { toast, hostOf, debounce, confirmDialog, escapeHtml, formatRelativeTime } from "./shared/api.js";
import { siteIcon } from "./shared/glass.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

const state = {
  tree: { folders: [], bookmarks: [] },
  folder: "",
  view: "folder", // "folder" | "duplicates" | "links" | "backups"
  q: "",
  selected: new Set(), // "b:<id>" / "f:<id>"
  open: new Set(),
  cards: false,
  previews: new Map(),
  links: null,
  checking: false,
};

try {
  state.cards = localStorage.getItem("kessel.bookmarks.cards") === "1";
  state.open = new Set(JSON.parse(localStorage.getItem("kessel.bookmarks.open") || "[]"));
} catch {}

const folderById = (id) => state.tree.folders.find((f) => f.id === id);
const childFolders = (id) => state.tree.folders.filter((f) => f.parent === id);
const childBookmarks = (id) => state.tree.bookmarks.filter((b) => b.folder === id);

// "Bookmarks bar › Work › Docs" for a folder.
function pathOf(id) {
  const parts = [];
  for (let f = folderById(id), n = 0; f && n < 50; f = folderById(f.parent), n++) parts.unshift(f.title);
  return ["Bookmarks bar", ...parts].join(" › ");
}

// Every bookmark under a folder, its subfolders' too.
function allUnder(id) {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of state.tree.folders) {
      if (ids.has(f.parent) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return state.tree.bookmarks.filter((b) => ids.has(b.folder));
}

async function load() {
  state.tree = await invoke("bookmark_tree");
  if (state.folder && !folderById(state.folder)) state.folder = "";
  const known = new Set(state.tree.bookmarks.map((b) => `b:${b.id}`).concat(state.tree.folders.map((f) => `f:${f.id}`)));
  for (const key of state.selected) if (!known.has(key)) state.selected.delete(key);
  render();
}

function remember() {
  try {
    localStorage.setItem("kessel.bookmarks.cards", state.cards ? "1" : "0");
    localStorage.setItem("kessel.bookmarks.open", JSON.stringify([...state.open]));
  } catch {}
}

// --- Menus and dialogs ----------------------------------------------------

let openMenuEl = null;
function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}

// Items: [label, icon, action, className?] or null (a separator). `at` is an
// element (the menu opens under it) or {x, y}.
function openMenu(at, items) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  for (const item of items) {
    if (!item) {
      menu.appendChild(document.createElement("hr"));
      continue;
    }
    const [label, iconName, action, cls] = item;
    const button = document.createElement("button");
    if (cls) button.className = cls;
    button.innerHTML = `${icon(iconName, 15)}<span></span>`;
    button.querySelector("span").textContent = label;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      Promise.resolve()
        .then(action)
        .catch((err) => toast(String(err)));
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, top: at.y, bottom: at.y };
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  openMenuEl = menu;
}

// Every folder, indented, for a <select> (leaving out `exclude` and what's
// inside it: a folder can't go into itself).
function folderOptions(selected, exclude = null) {
  const out = [`<option value="">Bookmarks bar</option>`];
  const walk = (parent, depth) => {
    for (const f of childFolders(parent)) {
      if (f.id === exclude) continue;
      out.push(`<option value="${escapeHtml(f.id)}"${f.id === selected ? " selected" : ""}>${" ".repeat(depth)}${escapeHtml(f.title)}</option>`);
      walk(f.id, depth + 1);
    }
  };
  walk("", 1);
  return out.join("");
}

function dialog(title, bodyHtml, okLabel = "Save") {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop open";
    backdrop.innerHTML = `<div class="modal" style="padding:20px 22px;width:480px;max-width:92vw">
      <h3 style="margin:0 0 14px;font-size:15px"></h3>
      <div class="form">${bodyHtml}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <button class="btn ghost" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="ok"></button>
      </div></div>`;
    backdrop.querySelector("h3").textContent = title;
    backdrop.querySelector("[data-act=ok]").textContent = okLabel;
    document.body.appendChild(backdrop);
    const done = (ok) => {
      const values = {};
      for (const el of backdrop.querySelectorAll("[name]")) values[el.name] = el.value;
      backdrop.remove();
      resolve(ok ? values : null);
    };
    backdrop.querySelector("[data-act=cancel]").addEventListener("click", () => done(false));
    backdrop.querySelector("[data-act=ok]").addEventListener("click", () => done(true));
    backdrop.addEventListener("click", (e) => e.target === backdrop && done(false));
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(false);
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") done(true);
    });
    backdrop.querySelector("input, select, textarea")?.focus();
  });
}

async function editBookmark(b = null) {
  const v = await dialog(
    b ? "Edit bookmark" : "Add a bookmark",
    `<label>Name</label><input class="field" name="title" value="${escapeHtml(b?.title || "")}" />
     <label>Address</label><input class="field" name="url" value="${escapeHtml(b?.url || "https://")}" spellcheck="false" />
     <label>Folder</label><select class="field" name="folder">${folderOptions(b ? b.folder : state.folder)}</select>
     <label>Tags</label><input class="field" name="tags" value="${escapeHtml((b?.tags || []).join(", "))}" placeholder="news, daily" />
     <label>Note</label><textarea class="field" name="description" rows="3">${escapeHtml(b?.description || "")}</textarea>`
  );
  if (!v) return;
  const typed = v.url.trim();
  if (!typed || typed === "https://") return toast("A bookmark needs an address");
  const url = /^[a-z][\w+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  await invoke("save_bookmark", {
    bookmark: { ...(b || {}), id: b?.id || "", url, title: v.title.trim() || hostOf(url), folder: v.folder, tags: v.tags.split(","), description: v.description },
  });
  toast(b ? "Saved" : "Bookmarked");
}

async function editFolder(f = null, parent = state.folder) {
  const v = await dialog(
    f ? "Rename folder" : "New folder",
    `<label>Name</label><input class="field" name="title" value="${escapeHtml(f?.title || "")}" />
     <label>In</label><select class="field" name="parent">${folderOptions(f ? f.parent : parent, f?.id)}</select>`,
    f ? "Save" : "Create"
  );
  if (!v) return null;
  return invoke("save_bookmark_folder", { folder: { id: f?.id || "", title: v.title, parent: v.parent, added: f?.added || 0 } });
}

function moveTo(at, bookmarks, folders) {
  const items = [["Bookmarks bar", "star", () => move(bookmarks, folders, "")]];
  const walk = (parent, depth) => {
    for (const f of childFolders(parent)) {
      if (folders.includes(f.id)) continue;
      items.push([`${" ".repeat(depth)}${f.title}`, "folder", () => move(bookmarks, folders, f.id)]);
      walk(f.id, depth + 1);
    }
  };
  walk("", 1);
  openMenu(at, items);
}

async function move(bookmarks, folders, to, before = null) {
  await invoke("move_bookmarks", { bookmarks, folders, to, before });
  clearSelection();
}

async function deleteItems(bookmarkIds, folderIds, { ask = true } = {}) {
  const inside = folderIds.flatMap((id) => allUnder(id)).length;
  const what = [
    bookmarkIds.length && `${bookmarkIds.length} bookmark${bookmarkIds.length === 1 ? "" : "s"}`,
    folderIds.length && `${folderIds.length} folder${folderIds.length === 1 ? "" : "s"}${inside ? ` (with ${inside} bookmark${inside === 1 ? "" : "s"} in them)` : ""}`,
  ]
    .filter(Boolean)
    .join(" and ");
  if (!what) return false;
  if (ask && !(await confirmDialog(`Delete ${what}?`, "Delete"))) return false;
  if (bookmarkIds.length) await invoke("delete_bookmarks", { ids: bookmarkIds });
  for (const id of folderIds) await invoke("delete_bookmark_folder", { id });
  clearSelection();
  toast(`Deleted ${what}`);
  return true;
}

const openUrl = (url, how = "tab") => invoke("open_url", { url, how }).catch((err) => toast(String(err)));

async function openAll(list) {
  if (!list.length) return;
  if (list.length > 15 && !(await confirmDialog(`Open ${list.length} tabs?`, "Open them"))) return;
  for (const b of list) await openUrl(b.url, "background");
}

// Where "Move to…" in a row's menu opens its own menu.
let menuAnchor = null;

function bookmarkMenu(b) {
  return [
    ["Open in new tab", "plus", () => openUrl(b.url)],
    ["Open in new window", "window", () => openUrl(b.url, "window")],
    ["Open in private window", "incognito", () => openUrl(b.url, "private-window")],
    null,
    ["Edit…", "edit", () => editBookmark(b)],
    ["Move to…", "folder", () => moveTo(menuAnchor, [b.id], [])],
    ["Copy link", "copy", () => navigator.clipboard.writeText(b.url).then(() => toast("Link copied"))],
    null,
    ["Delete", "trash", () => deleteItems([b.id], [], { ask: false }), "danger"],
  ];
}

function folderMenu(f) {
  const inside = allUnder(f.id);
  return [
    [`Open all ${inside.length} in new tabs`, "tabs", () => openAll(inside)],
    ["New folder inside…", "folder", () => editFolder(null, f.id)],
    ["Rename…", "edit", () => editFolder(f)],
    ["Move to…", "folder", () => moveTo(menuAnchor, [], [f.id])],
    ["Sort by name", "arrowRight", () => invoke("sort_bookmark_folder", { id: f.id, by: "name" })],
    null,
    ["Delete folder", "trash", () => deleteItems([], [f.id]), "danger"],
  ];
}

function menuOn(el, items, e) {
  e.preventDefault();
  e.stopPropagation();
  menuAnchor = e.type === "contextmenu" ? { x: e.clientX, y: e.clientY } : el;
  openMenu(menuAnchor, items());
}

// --- Selection ------------------------------------------------------------

let lastPicked = null;
function pick(key, e) {
  const keys = [...document.querySelectorAll("#list .row[data-key]")].map((r) => r.dataset.key);
  if (e.shiftKey && lastPicked && keys.includes(lastPicked)) {
    const [a, b] = [keys.indexOf(lastPicked), keys.indexOf(key)].sort((x, y) => x - y);
    for (const k of keys.slice(a, b + 1)) state.selected.add(k);
  } else if (e.ctrlKey || e.metaKey) {
    if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.add(key);
  } else {
    state.selected = new Set([key]);
  }
  lastPicked = key;
  syncSelection();
}

function selectedIds() {
  const bookmarks = [];
  const folders = [];
  for (const key of state.selected) (key.startsWith("b:") ? bookmarks : folders).push(key.slice(2));
  return [bookmarks, folders];
}

function syncSelection() {
  for (const row of document.querySelectorAll("#list .row[data-key]")) row.classList.toggle("selected", state.selected.has(row.dataset.key));
  const n = state.selected.size;
  $("selection").hidden = n < 2;
  $("selection-text").textContent = `${n} selected`;
}

function clearSelection() {
  state.selected.clear();
  syncSelection();
}

// --- Drag and drop --------------------------------------------------------

let dragging = null; // { bookmarks, folders }

function draggable(row, key) {
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    if (!state.selected.has(key)) {
      state.selected = new Set([key]);
      syncSelection();
    }
    const [bookmarks, folders] = selectedIds();
    dragging = { bookmarks, folders };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", key);
  });
  row.addEventListener("dragend", () => {
    dragging = null;
    for (const el of document.querySelectorAll(".drop, .drop-into, .drop-before")) el.classList.remove("drop", "drop-into", "drop-before");
  });
}

// A folder (tree item or row) takes what's dragged onto it.
function dropInto(el, folderId, cls = "drop") {
  el.addEventListener("dragover", (e) => {
    if (!dragging || dragging.folders.includes(folderId)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add(cls);
  });
  el.addEventListener("dragleave", () => el.classList.remove(cls));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove(cls);
    if (dragging) move(dragging.bookmarks, dragging.folders, folderId).catch((err) => toast(String(err)));
  });
}

// A bookmark row takes dragged bookmarks in front of it (reordering).
function dropBefore(row, b) {
  row.addEventListener("dragover", (e) => {
    if (!dragging || dragging.folders.length || state.q) return;
    e.preventDefault();
    row.classList.add("drop-before");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("drop-before");
    if (dragging && !dragging.bookmarks.includes(b.id)) move(dragging.bookmarks, [], b.folder, b.id).catch((err) => toast(String(err)));
  });
}

// --- Rendering ------------------------------------------------------------

function renderTree() {
  const tree = $("tree");
  tree.innerHTML = "";
  const item = (id, title, depth) => {
    const kids = childFolders(id);
    const open = id === "" || state.open.has(id);
    const b = document.createElement("button");
    b.className = `nav-item${state.view === "folder" && !state.q && state.folder === id ? " active" : ""}`;
    b.dataset.folder = id;
    b.style.paddingLeft = `${9 + depth * 14}px`;
    b.innerHTML = `<span class="twist${kids.length && id ? "" : " none"}${open ? " open" : ""}">${icon("chevronRight", 11)}</span>${icon(id ? "folder" : "star", 14)}<span class="label"></span><span class="count">${childBookmarks(id).length || ""}</span>`;
    b.querySelector(".label").textContent = title;
    b.querySelector(".twist").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!id) return;
      if (state.open.has(id)) state.open.delete(id);
      else state.open.add(id);
      remember();
      renderTree();
    });
    b.addEventListener("click", () => showFolder(id));
    if (id) b.addEventListener("contextmenu", (e) => menuOn(b, () => folderMenu(folderById(id)), e));
    dropInto(b, id);
    tree.appendChild(b);
    if (open) for (const f of kids) item(f.id, f.title, depth + 1);
  };
  item("", "Bookmarks bar", 0);
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("active", !state.q && state.view === b.dataset.view);
}

function renderCrumbs() {
  const c = $("crumbs");
  c.innerHTML = "";
  if (state.q) {
    c.textContent = `Search results for “${state.q}”`;
    return;
  }
  if (state.view !== "folder") {
    c.textContent = {
      duplicates: "Pages bookmarked more than once",
      links: "Links that don't work any more",
      backups: "Backups: one a day, the last two weeks",
    }[state.view];
    return;
  }
  const chain = [];
  for (let f = folderById(state.folder), n = 0; f && n < 50; f = folderById(f.parent), n++) chain.unshift(f);
  const crumb = (label, id, here) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (here) b.className = "here";
    b.addEventListener("click", () => showFolder(id));
    dropInto(b, id);
    return b;
  };
  c.appendChild(crumb("Bookmarks bar", "", !chain.length));
  chain.forEach((f, i) => c.append("›", crumb(f.title, f.id, i === chain.length - 1)));
}

function emptyState(text, iconName = "star") {
  const d = document.createElement("div");
  d.className = "empty-state";
  d.innerHTML = `${icon(iconName, 30)}<span></span>`;
  d.querySelector("span").textContent = text;
  return d;
}

function folderRow(f, { where = false } = {}) {
  const row = document.createElement("div");
  row.className = "row folder";
  row.dataset.key = `f:${f.id}`;
  const n = allUnder(f.id).length;
  row.innerHTML = `<div class="preview">${icon("folder", 40)}</div><div class="line"><span class="folder-icon">${icon("folder", 18)}</span>
    <span class="text"><span class="title"></span><span class="sub"></span></span>
    <button class="btn ghost icon-only sm row-btn" title="More">${icon("dots", 14)}</button></div>`;
  row.querySelector(".title").textContent = f.title;
  row.querySelector(".sub").textContent = `${n} bookmark${n === 1 ? "" : "s"}${where ? ` · in ${pathOf(f.parent)}` : ""}`;
  row.addEventListener("click", (e) => (e.ctrlKey || e.shiftKey || e.metaKey ? pick(row.dataset.key, e) : showFolder(f.id)));
  row.querySelector(".row-btn").addEventListener("click", (e) => menuOn(e.currentTarget, () => folderMenu(f), e));
  row.addEventListener("contextmenu", (e) => menuOn(row, () => folderMenu(f), e));
  draggable(row, row.dataset.key);
  dropInto(row, f.id, "drop-into");
  return row;
}

function bookmarkRow(b, { where = false, extra = null } = {}) {
  const row = document.createElement("div");
  row.className = "row bookmark";
  row.dataset.key = `b:${b.id}`;
  row.title = b.url;
  row.innerHTML = `<div class="preview">${icon("globe", 30)}</div><div class="line"><span class="icon-slot"></span>
    <span class="text"><span class="title"></span><span class="sub"></span><span class="note"></span><span class="tags"></span></span>
    <span class="extra"></span>
    <button class="btn ghost icon-only sm row-btn" data-act="edit" title="Edit">${icon("edit", 14)}</button>
    <button class="btn ghost icon-only sm row-btn" data-act="more" title="More">${icon("dots", 14)}</button></div>`;
  row.querySelector(".icon-slot").replaceWith(siteIcon(b.url, { label: b.title }));
  row.querySelector(".title").textContent = b.title || b.url;
  const address = b.url.replace(/^https?:\/\/(www\.)?/, "");
  row.querySelector(".sub").textContent = where ? `${address} · ${pathOf(b.folder)}` : `${address}${b.added ? ` · ${formatRelativeTime(b.added)}` : ""}`;
  const note = row.querySelector(".note");
  if (b.description) note.textContent = b.description;
  else note.remove();
  const tags = row.querySelector(".tags");
  for (const t of b.tags || []) {
    const chip = document.createElement("button");
    chip.className = "tag";
    chip.textContent = `#${t}`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      search(`#${t}`);
    });
    tags.appendChild(chip);
  }
  if (!b.tags?.length) tags.remove();
  if (extra) row.querySelector(".extra").append(extra);
  if (state.cards && state.view === "folder" && !state.q) showPreview(row, b.id);
  row.addEventListener("click", (e) => pick(row.dataset.key, e));
  row.addEventListener("dblclick", () => openUrl(b.url));
  row.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    openUrl(b.url, "background");
  });
  row.querySelector("[data-act=edit]").addEventListener("click", (e) => {
    e.stopPropagation();
    editBookmark(b).catch((err) => toast(String(err)));
  });
  row.querySelector("[data-act=more]").addEventListener("click", (e) => menuOn(e.currentTarget, () => bookmarkMenu(b), e));
  row.addEventListener("contextmenu", (e) => menuOn(row, () => bookmarkMenu(b), e));
  draggable(row, row.dataset.key);
  dropBefore(row, b);
  return row;
}

async function showPreview(row, id) {
  if (!state.previews.has(id)) state.previews.set(id, await invoke("bookmark_preview", { id }).catch(() => null));
  const url = state.previews.get(id);
  if (!url) return;
  const p = row.querySelector(".preview");
  p.style.backgroundImage = `url("${url}")`;
  p.innerHTML = "";
}

// Words in the name, address, note or tags; "#tag" for one tag.
function matches(b, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${b.title} ${b.url} ${b.description || ""} ${(b.tags || []).join(" ")}`.toLowerCase();
  return words.every((w) => (w.startsWith("#") && w.length > 1 ? (b.tags || []).includes(w.slice(1)) : text.includes(w)));
}

function renderList() {
  const list = $("list");
  list.innerHTML = "";
  document.body.classList.toggle("cards", state.cards && state.view === "folder" && !state.q);
  if (state.q) {
    const found = state.tree.bookmarks.filter((b) => matches(b, state.q));
    const q = state.q.toLowerCase();
    const folders = q.startsWith("#") ? [] : state.tree.folders.filter((f) => f.title.toLowerCase().includes(q));
    for (const f of folders) list.appendChild(folderRow(f, { where: true }));
    for (const b of found) list.appendChild(bookmarkRow(b, { where: true }));
    if (!found.length && !folders.length) list.appendChild(emptyState("Nothing matches.", "search"));
    return;
  }
  if (state.view === "duplicates") return renderDuplicates(list);
  if (state.view === "links") return renderLinks(list);
  if (state.view === "backups") return renderBackups(list);
  const folders = childFolders(state.folder);
  const bookmarks = childBookmarks(state.folder);
  for (const f of folders) list.appendChild(folderRow(f));
  for (const b of bookmarks) list.appendChild(bookmarkRow(b));
  if (!folders.length && !bookmarks.length) {
    list.appendChild(emptyState(state.folder ? "This folder is empty. Drag bookmarks here, or add one." : "No bookmarks yet. Star a page, or import some (the ⋯ menu)."));
  }
}

async function renderDuplicates(list) {
  const groups = await invoke("find_duplicate_bookmarks");
  if (state.view !== "duplicates" || state.q) return;
  list.innerHTML = "";
  if (!groups.length) return list.appendChild(emptyState("No page is bookmarked twice.", "check"));
  for (const ids of groups) {
    const items = ids.map((id) => state.tree.bookmarks.find((b) => b.id === id)).filter(Boolean);
    if (items.length < 2) continue;
    const box = document.createElement("div");
    box.className = "group";
    for (const b of items) box.appendChild(bookmarkRow(b, { where: true }));
    const keep = document.createElement("button");
    keep.className = "btn sm";
    keep.textContent = "Keep the first, delete the others";
    keep.style.margin = "6px 10px";
    keep.addEventListener("click", () => deleteItems(items.slice(1).map((b) => b.id), [], { ask: false }).catch((err) => toast(String(err))));
    box.appendChild(keep);
    list.appendChild(box);
  }
}

function renderLinks(list) {
  const top = document.createElement("div");
  top.style.cssText = "display:flex;gap:10px;align-items:center;margin:8px 10px 14px;font-size:12.5px;color:var(--text-dim)";
  const run = document.createElement("button");
  run.className = "btn sm primary";
  run.id = "check-links";
  run.textContent = state.checking ? "Checking…" : state.links ? "Check again" : `Check all ${state.tree.bookmarks.length} links`;
  run.disabled = state.checking || !state.tree.bookmarks.length;
  run.addEventListener("click", checkLinks);
  const why = document.createElement("span");
  why.textContent = "Kessel asks each site whether the page is still there, a few at a time.";
  top.append(run, why);
  list.appendChild(top);
  if (!state.links) return;
  const bookmarks = new Map(state.tree.bookmarks.map((b) => [b.id, b]));
  const bad = state.links.filter((l) => l.state !== "ok" && bookmarks.has(l.id));
  if (!bad.length) return list.appendChild(emptyState("Every link works.", "check"));
  const all = document.createElement("button");
  all.className = "btn sm danger";
  all.textContent = `Delete all ${bad.length}`;
  all.style.margin = "0 10px 8px";
  all.addEventListener("click", () => deleteItems(bad.map((l) => l.id), []).catch((err) => toast(String(err))));
  list.appendChild(all);
  const LABEL = { gone: "Gone", error: "Error", unreachable: "No answer" };
  for (const l of bad) {
    const tag = document.createElement("span");
    tag.className = "state";
    tag.textContent = `${LABEL[l.state] || l.state}${l.status ? ` (${l.status})` : ""}`;
    list.appendChild(bookmarkRow(bookmarks.get(l.id), { where: true, extra: tag }));
  }
}

async function checkLinks() {
  state.checking = true;
  if (state.view === "links") renderList();
  try {
    state.links = await invoke("check_bookmark_links", { ids: null });
  } catch (err) {
    toast(String(err));
  }
  state.checking = false;
  if (state.view === "links" && !state.q) renderList();
}

async function renderBackups(list) {
  const backups = await invoke("bookmark_backups");
  if (state.view !== "backups" || state.q) return;
  list.innerHTML = "";
  if (!backups.length) return list.appendChild(emptyState("No backups yet. Kessel keeps one a day, the first time your bookmarks change that day.", "history"));
  for (const b of backups) {
    const row = document.createElement("div");
    row.className = "row backup";
    const name = b.name.replace(/^bookmarks-/, "").replace(/\.json$/, "").replace("-before-restore", " (before a restore)");
    row.innerHTML = `<span class="folder-icon">${icon("history", 16)}</span><span class="text"><span class="title"></span><span class="sub"></span></span><button class="btn sm">Restore</button>`;
    row.querySelector(".title").textContent = name;
    row.querySelector(".sub").textContent = `${b.bookmarks} bookmarks, ${b.folders} folders`;
    row.querySelector("button").addEventListener("click", async () => {
      if (!(await confirmDialog(`Put your bookmarks back as they were on ${name}? The ones you have now are backed up first.`, "Restore"))) return;
      const n = await invoke("restore_bookmark_backup", { name: b.name }).catch((err) => {
        toast(String(err));
        return null;
      });
      if (n != null) toast(`Restored ${n} bookmarks`);
    });
    list.appendChild(row);
  }
}

function render() {
  renderTree();
  renderCrumbs();
  renderList();
  syncSelection();
  const folderView = state.view === "folder" && !state.q;
  $("sort-btn").hidden = !folderView;
  $("view-btn").innerHTML = icon(state.cards ? "tabs" : "grid", 15);
  $("view-btn").title = state.cards ? "Show as a list" : "Show as cards, with previews";
}

function showFolder(id) {
  state.view = "folder";
  state.folder = id;
  state.q = "";
  $("q").value = "";
  clearSelection();
  history.replaceState(null, "", id ? `#${encodeURIComponent(id)}` : location.pathname);
  render();
}

function showView(view) {
  state.view = view;
  state.q = "";
  $("q").value = "";
  clearSelection();
  render();
}

function search(q) {
  $("q").value = q;
  state.q = q.trim();
  clearSelection();
  render();
}

async function importHtml() {
  const r = await invoke("import_bookmarks", { path: null });
  if (!r) return;
  toast(`Imported ${r.added} bookmark${r.added === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} you had already)` : ""}`);
  await load();
  if (r.folder) showFolder(r.folder);
}

async function exportHtml() {
  const path = await invoke("export_bookmarks", { path: null });
  if (path) toast(`Saved to ${path}`);
}

// --- Start ----------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  $("search-icon").outerHTML = icon("search", 15);
  $("add-btn").innerHTML = `${icon("plus", 13)}<span>Add</span>`;
  $("folder-btn").innerHTML = `${icon("folder", 13)}<span>New folder</span>`;
  $("sort-btn").innerHTML = `${icon("arrowRight", 13)}<span>Sort</span>`;
  $("more-btn").innerHTML = icon("dots", 15);
  $("more-btn").title = "Import, export and tidying up";
  $("move-selected").textContent = "Move to…";
  $("delete-selected").textContent = "Delete";
  const tidy = { duplicates: ["Duplicates", "copy"], links: ["Check links", "link"], backups: ["Backups", "history"] };
  for (const b of document.querySelectorAll("[data-view]")) {
    const [label, name] = tidy[b.dataset.view];
    b.innerHTML = `${icon(name, 14)}<span class="label">${label}</span>`;
    b.addEventListener("click", () => showView(b.dataset.view));
  }

  $("q").addEventListener("input", debounce(() => search($("q").value), 120));
  $("add-btn").addEventListener("click", () => editBookmark().catch((err) => toast(String(err))));
  $("folder-btn").addEventListener("click", () =>
    editFolder()
      .then((id) => {
        if (id && state.folder) {
          state.open.add(state.folder);
          remember();
        }
      })
      .catch((err) => toast(String(err)))
  );
  $("sort-btn").addEventListener("click", (e) =>
    openMenu(e.currentTarget, [
      ["By name", "arrowRight", () => invoke("sort_bookmark_folder", { id: state.folder, by: "name" })],
      ["By address", "globe", () => invoke("sort_bookmark_folder", { id: state.folder, by: "address" })],
      ["Newest first", "clock", () => invoke("sort_bookmark_folder", { id: state.folder, by: "date" })],
    ])
  );
  $("view-btn").addEventListener("click", () => {
    state.cards = !state.cards;
    remember();
    render();
  });
  $("more-btn").addEventListener("click", (e) =>
    openMenu(e.currentTarget, [
      ["Import from an HTML file…", "download", importHtml],
      ["Import from another browser…", "arrowRight", () => invoke("open_singleton_tab", { route: "kessel://settings/import" })],
      ["Export to an HTML file…", "save", exportHtml],
      null,
      ["Find duplicates", "copy", () => showView("duplicates")],
      ["Check links", "link", () => showView("links")],
      ["Backups", "history", () => showView("backups")],
    ])
  );
  $("move-selected").addEventListener("click", (e) => {
    const [bookmarks, folders] = selectedIds();
    moveTo(e.currentTarget, bookmarks, folders);
  });
  $("delete-selected").addEventListener("click", () => {
    const [bookmarks, folders] = selectedIds();
    deleteItems(bookmarks, folders).catch((err) => toast(String(err)));
  });
  $("clear-selection").addEventListener("click", clearSelection);

  // Pressing anywhere else closes a menu (on press, not click: the click
  // that opens a menu mustn't close it again).
  document.addEventListener("pointerdown", (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
  });
  window.addEventListener("blur", closeMenu);
  document.addEventListener("keydown", (e) => {
    if (document.querySelector(".modal-backdrop")) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !typing)) {
      e.preventDefault();
      $("q").focus();
      $("q").select();
    } else if (e.key === "Escape") {
      if (openMenuEl) closeMenu();
      else if (state.selected.size) clearSelection();
      else if ($("q").value) search("");
    } else if (e.key === "Delete" && !typing && state.selected.size) {
      e.preventDefault();
      const [bookmarks, folders] = selectedIds();
      deleteItems(bookmarks, folders).catch((err) => toast(String(err)));
    } else if (e.ctrlKey && e.key.toLowerCase() === "a" && !typing) {
      e.preventDefault();
      state.selected = new Set([...document.querySelectorAll("#list .row[data-key]")].map((r) => r.dataset.key));
      syncSelection();
    } else if (e.key === "Enter" && !typing && state.selected.size === 1) {
      const [[id], [folder]] = selectedIds();
      const b = state.tree.bookmarks.find((x) => x.id === id);
      if (b) openUrl(b.url);
      else if (folder) showFolder(folder);
    }
  });

  const refresh = debounce(() => load().catch((err) => toast(String(err))), 80);
  listen("bookmarks-changed", refresh);
  listen("bookmark-folders-changed", refresh);

  // kessel://bookmarks/<folder id> (bookmarks.html#<id>) opens at that
  // folder -- and turns this tab to it when it's open already.
  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && folderById(id) && id !== state.folder) showFolder(id);
  };
  window.addEventListener("hashchange", fromHash);
  await load();
  fromHash();
});
