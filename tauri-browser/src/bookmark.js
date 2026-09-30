// The star's popup (see bookmark.html): name the bookmark, pick its folder
// (or make one), tag it, add a note -- saved when it closes, whichever way
// it closes (Done, Enter, clicking away) -- or remove it. "More…" opens
// the bookmark manager at its folder.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { closeOwnPopup, escapeHtml } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const info = window.__KESSEL_POPUP__ || { id: "", url: "", title: "", added: false };
const $ = (id) => document.getElementById(id);
const NEW_FOLDER = "\u0001new";

let bookmark = null;
let folders = [];
let closing = false;

function folderOptions(selected) {
  const out = [`<option value="">Bookmarks bar</option>`];
  const walk = (parent, depth) => {
    for (const f of folders.filter((f) => f.parent === parent)) {
      out.push(`<option value="${escapeHtml(f.id)}"${f.id === selected ? " selected" : ""}>${" ".repeat(depth)}${escapeHtml(f.title)}</option>`);
      walk(f.id, depth + 1);
    }
  };
  walk("", 1);
  out.push(`<option value="${NEW_FOLDER}">New folder…</option>`);
  return out.join("");
}

function chosenFolder() {
  const v = $("folder").value;
  return v === NEW_FOLDER ? bookmark.folder : v;
}

function showNewFolder(show) {
  $("new-folder").hidden = !show;
  $("new-folder-gap").hidden = !show;
  if (show) $("new-folder").focus();
  else $("new-folder").value = "";
}

// Makes the folder typed in "New folder…" (in the bookmarks bar) and picks it.
async function makeFolder() {
  const title = $("new-folder").value.trim();
  if (!title) return;
  const id = await invoke("save_bookmark_folder", { folder: { id: "", title, parent: "", added: 0 } }).catch(() => null);
  folders = (await invoke("bookmark_tree")).folders;
  $("folder").innerHTML = folderOptions(id || bookmark.folder);
  showNewFolder(false);
}

async function save() {
  if (!bookmark) return;
  if (!$("new-folder").hidden && $("new-folder").value.trim()) await makeFolder();
  const tags = $("tags").value;
  const next = { ...bookmark, title: $("title").value.trim() || bookmark.title, folder: chosenFolder(), tags: tags.split(","), description: $("note").value.trim() };
  const same = next.title === bookmark.title && next.folder === bookmark.folder && next.description === (bookmark.description || "") && tags.trim() === (bookmark.tags || []).join(", ");
  if (!same) await invoke("save_bookmark", { bookmark: next }).catch(() => {});
}

async function finish() {
  if (closing) return;
  closing = true;
  await save();
  closeOwnPopup();
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  const tree = await invoke("bookmark_tree");
  folders = tree.folders;
  bookmark = tree.bookmarks.find((b) => b.id === info.id) || tree.bookmarks.find((b) => b.url === info.url) || null;
  if (!bookmark) return closeOwnPopup();

  $("heading").innerHTML = `${icon("starFilled", 15)}<span></span>`;
  $("heading").querySelector("span").textContent = info.added ? "Bookmarked" : "Edit bookmark";
  $("title").value = bookmark.title;
  $("folder").innerHTML = folderOptions(bookmark.folder);
  $("tags").value = (bookmark.tags || []).join(", ");
  $("note").value = bookmark.description || "";
  $("title").focus();
  $("title").select();

  $("folder").addEventListener("change", () => showNewFolder($("folder").value === NEW_FOLDER));
  $("new-folder").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      makeFolder();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      $("folder").innerHTML = folderOptions(bookmark.folder);
      showNewFolder(false);
    }
  });

  $("done").addEventListener("click", finish);
  $("remove").addEventListener("click", async () => {
    closing = true;
    await invoke("remove_bookmark", { url: bookmark.url }).catch(() => {});
    closeOwnPopup();
  });
  $("more").addEventListener("click", async () => {
    closing = true;
    await save();
    const folder = chosenFolder();
    await invoke("open_singleton_tab", { route: `kessel://bookmarks${folder ? `/${encodeURIComponent(folder)}` : ""}` }).catch(() => {});
    closeOwnPopup();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      finish();
    } else if (e.key === "Escape") {
      finish();
    }
  });
  window.addEventListener("blur", () => setTimeout(() => !document.hasFocus() && finish(), 150));
});
