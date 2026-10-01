// kessel://bookmarks (bookmarks.html): the bookmark manager. Folders on the
// left (drag bookmarks onto one to move them; right-click one to rename,
// add a folder inside, or delete it), tags under them; on the right the
// bookmarks -- search, sort, pick several (checkboxes, Shift for a run),
// drag to reorder in "Your order". The work is bookmarks.rs.

import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { toast, hostOf, formatRelativeTime, confirmDialog } from "./shared/api.js";
import { readBookmarkFile, duplicateGroups } from "./shared/bookmark-file.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

let bookmarks = [];
let folders = [];
// What's shown: { kind: "all" } | { kind: "folder", path } | { kind: "tag", tag }
let view = { kind: "all" };
const picked = new Set();
let lastPicked = null;
const collapsed = new Set(JSON.parse(localStorageGet("kessel-bm-collapsed") || "[]"));

function localStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function localStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

async function load() {
  const tree = await invoke("bookmark_tree").catch(() => ({ bookmarks: [], folders: [] }));
  bookmarks = tree.bookmarks || [];
  folders = tree.folders || [];
  for (const url of [...picked]) if (!bookmarks.some((b) => b.url === url)) picked.delete(url);
  if (view.kind === "folder" && view.path && !folders.includes(view.path)) view = { kind: "all" };
  render();
}

const leaf = (path) => path.split("/").pop();
const depth = (path) => path.split("/").length - 1;
const inside = (folder, parent) => folder === parent || folder.startsWith(`${parent}/`);

// --- The folder tree ---

function renderTree() {
  const tree = $("tree");
  tree.innerHTML = "";
  const node = (label, glyph, count, isOn, onClick, extra = {}) => {
    const el = document.createElement("div");
    el.className = `node${isOn ? " on" : ""}`;
    el.style.paddingLeft = `${8 + (extra.depth || 0) * 14}px`;
    el.innerHTML = `${extra.toggle ?? ""}${icon(glyph, 14)}<span class="name"></span><span class="n">${count || ""}</span>`;
    el.querySelector(".name").textContent = label;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".caret")) return;
      onClick();
    });
    if (extra.folder !== undefined) {
      el.dataset.folder = extra.folder;
      el.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("text/x-kessel-bookmarks")) return;
        e.preventDefault();
        el.classList.add("drop");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop"));
      el.addEventListener("drop", async (e) => {
        e.preventDefault();
        el.classList.remove("drop");
        const urls = JSON.parse(e.dataTransfer.getData("text/x-kessel-bookmarks") || "[]");
        if (urls.length) await invoke("move_bookmarks", { urls, folder: extra.folder }).catch((err) => toast(String(err)));
      });
      if (extra.folder) el.addEventListener("contextmenu", (e) => folderMenu(e, extra.folder));
    }
    tree.appendChild(el);
    return el;
  };
  node("All bookmarks", "bookmark", bookmarks.length, view.kind === "all", () => show({ kind: "all" }));
  node("Top level", "folder", bookmarks.filter((b) => !b.folder).length, view.kind === "folder" && view.path === "", () => show({ kind: "folder", path: "" }), { folder: "" });
  for (const f of folders) {
    const parent = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : null;
    // Hidden when a folder it's in is folded.
    if (parent && [...collapsed].some((c) => inside(f, c) && f !== c)) continue;
    const hasKids = folders.some((x) => x.startsWith(`${f}/`));
    const toggle = hasKids ? `<span class="caret" data-caret="${encodeURIComponent(f)}" style="display:inline-flex;width:12px;cursor:pointer">${icon(collapsed.has(f) ? "chevronRight" : "chevronDown", 11)}</span>` : `<span style="display:inline-block;width:12px"></span>`;
    const count = bookmarks.filter((b) => inside(b.folder, f)).length;
    node(leaf(f), "folder", count, view.kind === "folder" && view.path === f, () => show({ kind: "folder", path: f }), { folder: f, depth: depth(f) + 1, toggle });
  }
  const tags = new Map();
  for (const b of bookmarks) for (const t of b.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  if (tags.size) {
    tree.insertAdjacentHTML("beforeend", `<div class="section">Tags</div>`);
    for (const [t, n] of [...tags].sort((a, b) => a[0].localeCompare(b[0]))) node(`#${t}`, "note", n, view.kind === "tag" && view.tag === t, () => show({ kind: "tag", tag: t }));
  }
  tree.querySelectorAll("[data-caret]").forEach((c) =>
    c.addEventListener("click", () => {
      const f = decodeURIComponent(c.dataset.caret);
      collapsed.has(f) ? collapsed.delete(f) : collapsed.add(f);
      localStorageSet("kessel-bm-collapsed", JSON.stringify([...collapsed]));
      renderTree();
    })
  );
  $("folder-list").innerHTML = folders.map((f) => `<option value="${f.replace(/"/g, "&quot;")}"></option>`).join("");
}

function show(next) {
  view = next;
  picked.clear();
  render();
}

// --- The list ---

function visible() {
  const q = $("q").value.trim().toLowerCase();
  let list = bookmarks;
  if (view.kind === "folder") list = list.filter((b) => (view.path === "" ? !b.folder : inside(b.folder, view.path)));
  if (view.kind === "tag") list = list.filter((b) => (b.tags || []).includes(view.tag));
  if (q) {
    const words = q.split(/\s+/);
    list = list.filter((b) => words.every((w) => `${b.title} ${b.url} ${(b.tags || []).join(" ")} ${b.note || ""} ${b.folder || ""}`.toLowerCase().includes(w.replace(/^#/, ""))));
  }
  const sorted = [...list];
  switch ($("sort").value) {
    case "name": sorted.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url)); break;
    case "new": sorted.sort((a, b) => (b.added || 0) - (a.added || 0)); break;
    case "old": sorted.sort((a, b) => (a.added || 0) - (b.added || 0)); break;
    case "site": sorted.sort((a, b) => hostOf(a.url).localeCompare(hostOf(b.url))); break;
  }
  return sorted;
}

function renderList() {
  const list = $("list");
  const shown = visible();
  $("heading").textContent = view.kind === "all" ? "All bookmarks" : view.kind === "tag" ? `#${view.tag}` : view.path || "Top level";
  if (!shown.length) {
    list.innerHTML = `<div id="empty">${bookmarks.length ? "Nothing here." : "No bookmarks yet -- star a page (Ctrl+D), or import them from another browser."}</div>`;
    renderBulk();
    return;
  }
  list.innerHTML = "";
  const manual = $("sort").value === "manual" && !$("q").value.trim();
  shown.forEach((b, index) => {
    const row = document.createElement("div");
    row.className = `bm${picked.has(b.url) ? " picked" : ""}`;
    row.draggable = true;
    row.innerHTML = `<input type="checkbox" ${picked.has(b.url) ? "checked" : ""} title="Pick" />
      <span class="fav">${faviconLetter(b.url)}</span>
      <div class="main"><div class="t"></div><div class="u"><span class="addr"></span></div>${b.note ? `<div class="note"></div>` : ""}</div>
      <span class="acts"><button data-act="edit" title="Edit">${icon("edit", 14)}</button><button data-act="delete" title="Delete">${icon("trash", 14)}</button></span>`;
    row.querySelector(".t").textContent = b.title || b.url;
    row.querySelector(".addr").textContent = `${hostOf(b.url)}${view.kind !== "folder" && b.folder ? ` · ${b.folder}` : ""}${b.added ? ` · ${formatRelativeTime(b.added)}` : ""}`;
    for (const t of b.tags || []) {
      const chip = document.createElement("span");
      chip.className = "tag";
      chip.textContent = `#${t}`;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        show({ kind: "tag", tag: t });
      });
      row.querySelector(".u").appendChild(chip);
    }
    if (b.note) row.querySelector(".note").textContent = b.note;
    row.title = b.url;
    row.querySelector("input").addEventListener("click", (e) => {
      e.stopPropagation();
      togglePick(b.url, e.shiftKey, shown);
    });
    row.querySelector(".main").addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return togglePick(b.url, e.shiftKey, shown);
      invoke("open_url", { url: b.url, how: "tab" }).catch((err) => toast(String(err)));
    });
    row.querySelector(".main").addEventListener("auxclick", (e) => {
      if (e.button === 1) invoke("open_url", { url: b.url, how: "tab" }).catch(() => {});
    });
    row.querySelector('[data-act="edit"]').addEventListener("click", () => editBookmark(b));
    row.querySelector('[data-act="delete"]').addEventListener("click", () => removeBookmarks([b.url]));
    row.addEventListener("dragstart", (e) => {
      const urls = picked.has(b.url) ? [...picked] : [b.url];
      e.dataTransfer.setData("text/x-kessel-bookmarks", JSON.stringify(urls));
      e.dataTransfer.setData("text/uri-list", urls.join("\n"));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    if (manual) {
      row.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("text/x-kessel-bookmarks")) return;
        e.preventDefault();
        row.classList.add("drop-above");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-above"));
      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        row.classList.remove("drop-above");
        const moving = JSON.parse(e.dataTransfer.getData("text/x-kessel-bookmarks") || "[]");
        const order = shown.map((x) => x.url).filter((u) => !moving.includes(u));
        order.splice(order.indexOf(b.url) < 0 ? index : order.indexOf(b.url), 0, ...moving);
        // Dropped into this folder's list from elsewhere: into this folder too.
        if (view.kind === "folder") {
          const outsiders = moving.filter((u) => bookmarks.find((x) => x.url === u)?.folder !== view.path);
          if (outsiders.length) await invoke("move_bookmarks", { urls: outsiders, folder: view.path }).catch(() => {});
        }
        await invoke("reorder_bookmarks", { urls: order }).catch((err) => toast(String(err)));
      });
    }
    list.appendChild(row);
  });
  renderBulk();
}

function togglePick(url, range, shown) {
  if (range && lastPicked) {
    const a = shown.findIndex((b) => b.url === lastPicked);
    const z = shown.findIndex((b) => b.url === url);
    if (a >= 0 && z >= 0) for (const b of shown.slice(Math.min(a, z), Math.max(a, z) + 1)) picked.add(b.url);
  } else if (picked.has(url)) picked.delete(url);
  else picked.add(url);
  lastPicked = url;
  renderList();
}

function renderBulk() {
  $("bulk").classList.toggle("on", picked.size > 0);
  $("bulk-count").textContent = `${picked.size} picked`;
}

function render() {
  renderTree();
  renderList();
}

// --- Dialogs ---

function ask(title, value = "") {
  return new Promise((resolve) => {
    const d = $("ask");
    $("ask-title").textContent = title;
    $("ask-input").value = value;
    const done = (v) => {
      d.close();
      $("ask-ok").onclick = $("ask-cancel").onclick = null;
      $("ask-input").onkeydown = null;
      resolve(v);
    };
    $("ask-ok").onclick = () => done($("ask-input").value);
    $("ask-cancel").onclick = () => done(null);
    $("ask-input").onkeydown = (e) => e.key === "Enter" && done($("ask-input").value);
    d.onclose = () => resolve(null);
    d.showModal();
    $("ask-input").select();
  });
}

function editBookmark(b, isNew = false) {
  const d = $("edit");
  $("edit-title").textContent = isNew ? "Add a bookmark" : "Edit bookmark";
  $("e-title").value = b.title || "";
  $("e-url").value = b.url || "";
  $("e-folder").value = b.folder || "";
  $("e-tags").value = (b.tags || []).join(", ");
  $("e-note").value = b.note || "";
  $("e-cancel").onclick = () => d.close();
  $("e-save").onclick = async () => {
    const changes = {
      url: $("e-url").value.trim(),
      title: $("e-title").value.trim() || $("e-url").value.trim(),
      folder: $("e-folder").value,
      tags: $("e-tags").value.split(","),
      note: $("e-note").value,
    };
    try {
      if (isNew) {
        await invoke("add_bookmark_to", { url: changes.url, title: changes.title, folder: changes.folder });
        await invoke("update_bookmark", { url: changes.url, changes: { tags: changes.tags, note: changes.note } });
      } else {
        await invoke("update_bookmark", { url: b.url, changes });
      }
      d.close();
    } catch (err) {
      toast(String(err));
    }
  };
  d.showModal();
  (isNew ? $("e-url") : $("e-title")).focus();
}

async function removeBookmarks(urls) {
  if (urls.length > 1 && !(await confirmDialog(`Delete ${urls.length} bookmarks?`, "Delete"))) return;
  await invoke("delete_bookmarks", { urls }).catch((err) => toast(String(err)));
  toast(urls.length > 1 ? `Deleted ${urls.length} bookmarks -- Backups can bring them back` : "Bookmark deleted");
}

function folderMenu(e, path) {
  e.preventDefault();
  const menu = document.createElement("div");
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:10;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.35);min-width:180px`;
  const item = (label, run) => {
    const b = document.createElement("div");
    b.className = "node";
    b.textContent = label;
    b.addEventListener("click", () => {
      menu.remove();
      run();
    });
    menu.appendChild(b);
  };
  item("Rename…", async () => {
    const name = await ask("Rename folder", leaf(path));
    if (!name) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const to = await invoke("rename_bookmark_folder", { from: path, to: parent ? `${parent}/${name.replace(/\//g, "-")}` : name.replace(/\//g, "-") }).catch((err) => toast(String(err)));
    if (to) show({ kind: "folder", path: to });
  });
  item("Move to…", async () => {
    const parent = await ask(`Move “${leaf(path)}” into (empty for the top)`, "");
    if (parent === null) return;
    const to = await invoke("rename_bookmark_folder", { from: path, to: parent.trim() ? `${parent.trim()}/${leaf(path)}` : leaf(path) }).catch((err) => toast(String(err)));
    if (to) show({ kind: "folder", path: to });
  });
  item("New folder inside…", async () => {
    const name = await ask(`New folder in “${leaf(path)}”`);
    if (name) await invoke("create_bookmark_folder", { path: `${path}/${name.replace(/\//g, "-")}` }).catch((err) => toast(String(err)));
  });
  item("Open all in tabs", () => openAll(bookmarks.filter((b) => inside(b.folder, path)).map((b) => b.url)));
  item("Delete folder (keep its bookmarks)", () => invoke("delete_bookmark_folder", { path, withBookmarks: false }).catch((err) => toast(String(err))));
  item("Delete folder and its bookmarks", async () => {
    const n = bookmarks.filter((b) => inside(b.folder, path)).length;
    if (n && !(await confirmDialog(`Delete “${leaf(path)}” and its ${n} bookmark${n === 1 ? "" : "s"}?`, "Delete"))) return;
    await invoke("delete_bookmark_folder", { path, withBookmarks: true }).catch((err) => toast(String(err)));
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

async function openAll(urls) {
  if (urls.length > 20 && !(await confirmDialog(`Open ${urls.length} tabs?`, "Open them"))) return;
  for (const url of urls) await invoke("open_url", { url, how: "tab" }).catch(() => {});
}

function info(title, fill) {
  $("info-title").textContent = title;
  const list = $("info-list");
  list.innerHTML = "";
  fill(list);
  $("info-close").onclick = () => $("info").close();
  $("info").showModal();
}

async function showBackups() {
  const backups = await invoke("bookmark_backups").catch(() => []);
  info("Bookmark backups", (list) => {
    if (!backups.length) list.innerHTML = `<p style="font-size:12.5px;opacity:.7">Kessel keeps a copy of your bookmarks each day you change them (the last 14 days). None yet.</p>`;
    for (const b of backups) {
      const row = document.createElement("div");
      row.className = "dup";
      row.innerHTML = `<div class="item"><span></span><button class="btn sm">Restore</button></div>`;
      row.querySelector("span").textContent = `${new Date(b.day * 1000).toLocaleDateString()} -- ${b.count} bookmarks`;
      row.querySelector("button").addEventListener("click", async () => {
        if (!(await confirmDialog(`Put back your bookmarks as they were on ${new Date(b.day * 1000).toLocaleDateString()}? Today's are backed up first.`, "Restore"))) return;
        await invoke("restore_bookmark_backup", { name: b.name }).catch((err) => toast(String(err)));
        $("info").close();
        toast("Bookmarks restored");
      });
      list.appendChild(row);
    }
  });
}

function showDuplicates() {
  const groups = duplicateGroups(bookmarks);
  info(groups.length ? `${groups.length} page${groups.length === 1 ? "" : "s"} bookmarked more than once` : "No duplicates", (list) => {
    if (!groups.length) list.innerHTML = `<p style="font-size:12.5px;opacity:.7">Every bookmark goes to a different page.</p>`;
    for (const group of groups) {
      const box = document.createElement("div");
      box.className = "dup";
      group.forEach((b, i) => {
        const row = document.createElement("div");
        row.className = "item";
        row.innerHTML = `<span></span>${i ? `<button class="btn sm ghost">Delete</button>` : `<em style="font-size:11px;opacity:.6">kept</em>`}`;
        row.querySelector("span").textContent = `${b.title || b.url} -- ${b.url}${b.folder ? ` (${b.folder})` : ""}`;
        row.querySelector("button")?.addEventListener("click", async () => {
          await invoke("delete_bookmarks", { urls: [b.url] }).catch((err) => toast(String(err)));
          row.remove();
        });
        box.appendChild(row);
      });
      list.appendChild(box);
    }
  });
}

async function importFile() {
  const text = await invoke("read_bookmark_file").catch((err) => {
    toast(String(err));
    return null;
  });
  if (!text) return;
  const into = currentSettings()?.features?.bookmark_import_folder ?? "Imported";
  const list = readBookmarkFile(text, new DOMParser(), into);
  if (!list.length) return toast("No bookmarks in that file");
  const added = await invoke("add_bookmarks", { list }).catch((err) => toast(String(err)));
  if (added != null) toast(`Imported ${added} bookmark${added === 1 ? "" : "s"}${list.length > added ? ` (${list.length - added} you had already)` : ""}`);
}

function wire() {
  $("q").addEventListener("input", renderList);
  $("sort").addEventListener("change", () => {
    localStorageSet("kessel-bm-sort", $("sort").value);
    renderList();
  });
  $("sort").value = localStorageGet("kessel-bm-sort") || "manual";
  $("add").addEventListener("click", () => editBookmark({ url: "https://", title: "", folder: view.kind === "folder" ? view.path : "" }, true));
  $("new-folder").addEventListener("click", async () => {
    const inFolder = view.kind === "folder" && view.path ? view.path : "";
    const name = await ask(inFolder ? `New folder in “${leaf(inFolder)}”` : "New folder");
    if (!name) return;
    const path = await invoke("create_bookmark_folder", { path: inFolder ? `${inFolder}/${name.replace(/\//g, "-")}` : name.replace(/\//g, "-") }).catch((err) => toast(String(err)));
    if (path) show({ kind: "folder", path });
  });
  $("import").addEventListener("click", importFile);
  $("export").addEventListener("click", async () => {
    const path = await invoke("export_bookmarks").catch((err) => toast(String(err)));
    if (path) toast(`Saved to ${path}`);
  });
  $("backups").addEventListener("click", showBackups);
  $("dups").addEventListener("click", showDuplicates);
  $("bulk-clear").addEventListener("click", () => {
    picked.clear();
    renderList();
  });
  $("bulk-delete").addEventListener("click", () => removeBookmarks([...picked]));
  $("bulk-open").addEventListener("click", () => openAll([...picked]));
  $("bulk-move").addEventListener("click", async () => {
    const folder = await ask(`Move ${picked.size} bookmark${picked.size === 1 ? "" : "s"} to folder (empty for the top)`, view.kind === "folder" ? view.path : "");
    if (folder === null) return;
    await invoke("move_bookmarks", { urls: [...picked], folder }).catch((err) => toast(String(err)));
  });
  $("bulk-tag").addEventListener("click", async () => {
    const tag = await ask("Tag to add");
    if (!tag?.trim()) return;
    for (const url of picked) {
      const b = bookmarks.find((x) => x.url === url);
      if (b) await invoke("update_bookmark", { url, changes: { tags: [...(b.tags || []), tag] } }).catch(() => {});
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, dialog")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      for (const b of visible()) picked.add(b.url);
      renderList();
    } else if (e.key === "Delete" && picked.size) removeBookmarks([...picked]);
    else if (e.key === "Escape") {
      picked.clear();
      renderList();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      $("q").focus();
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  $("title").innerHTML = `${icon("bookmark", 17)}<span>Bookmarks</span>`;
  await initTheme();
  wire();
  const folderFromUrl = new URLSearchParams(location.search).get("folder");
  if (folderFromUrl !== null) view = { kind: "folder", path: folderFromUrl };
  await load();
  listen("bookmarks-changed", load);
});
