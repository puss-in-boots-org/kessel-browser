// The side panel's own page (kessel://sidebar/<page>): bookmarks, the
// reading list, history, notes, search, workspaces and extensions -- one at
// a time, switched from its tabs at the top or the rail's buttons (the
// toolbar says which: "show"). Its title is the page it's on, which the
// side panel's frame shows.
//
// A click opens a page in the tab you're on; Ctrl or middle click in a new
// tab behind it, Shift click in a new tab in front.

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { toast, hostOf, escapeHtml, formatRelativeTime, debounce, listenHere, confirmDialog } from "./shared/api.js";
import { siteIcon } from "./shared/glass.js";
import { SIDEBAR_PANELS, WORKSPACE_COLORS, WORKSPACE_ICONS } from "./shared/sidebar-panels.js";
import { engineById } from "./shared/search.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// --- Opening pages ---------------------------------------------------------------

async function open(url, e) {
  const fail = (err) => toast(String(err));
  if (e && (e.button === 1 || e.ctrlKey || e.metaKey)) return invoke("open_url", { url, how: "background" }).catch(fail);
  if (e && e.shiftKey) return invoke("open_url", { url, how: "tab" }).catch(fail);
  const tab = await invoke("active_tab_info").catch(() => null);
  if (tab?.id) return invoke("navigate", { id: tab.id, url }).catch(fail);
  return invoke("open_url", { url, how: "tab" }).catch(fail);
}

// The web page you're on in the window (not one of Kessel's own).
async function currentPage() {
  const tab = await invoke("active_tab_info").catch(() => null);
  if (!tab || !/^https?:\/\//i.test(tab.url || "")) {
    toast("Open a web page first");
    return null;
  }
  return { url: tab.url, title: tab.title && tab.title !== "New Tab" ? tab.title : hostOf(tab.url) };
}

// One row of a list: `leading` (an element), title and a line under it,
// `actions` [{ icon, title, run, danger }] shown on hover.
function row({ leading, title, sub, actions = [], onOpen, className = "" }) {
  const item = el(`<div class="sb-item ${className}" tabindex="0"><div class="sb-text"><div class="sb-title"></div><div class="sb-sub"></div></div><div class="sb-actions"></div></div>`);
  if (leading) item.prepend(leading);
  item.querySelector(".sb-title").textContent = title || "";
  const subEl = item.querySelector(".sb-sub");
  if (sub) subEl.textContent = sub;
  else subEl.remove();
  const bar = item.querySelector(".sb-actions");
  for (const a of actions) {
    const b = el(`<button class="${a.danger ? "danger" : ""}" title="${escapeHtml(a.title)}">${icon(a.icon, 13)}</button>`);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      a.run(e);
    });
    bar.appendChild(b);
  }
  if (onOpen) {
    item.addEventListener("click", (e) => onOpen(e));
    item.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        onOpen(e);
      }
    });
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onOpen(e);
    });
  }
  return item;
}

function empty(text) {
  const d = el(`<div class="sb-empty"></div>`);
  d.textContent = text;
  return d;
}

function group(title) {
  const g = el(`<div class="sb-group"></div>`);
  g.textContent = title;
  return g;
}

function head(title, buttons = []) {
  const h = el(`<div class="sb-head"><h1></h1></div>`);
  h.querySelector("h1").textContent = title;
  for (const b of buttons) {
    const btn = el(`<button class="btn sm" title="${escapeHtml(b.title || b.label)}">${icon(b.icon, 13)}<span>${escapeHtml(b.label)}</span></button>`);
    btn.addEventListener("click", b.run);
    h.appendChild(btn);
  }
  return h;
}

function searchBox(placeholder, onInput) {
  const input = el(`<input class="field sb-search" type="search" spellcheck="false">`);
  input.placeholder = placeholder;
  input.addEventListener("input", debounce(() => onInput(input.value.trim()), 90));
  return input;
}

const matches = (q, ...fields) => !q || fields.some((f) => (f || "").toLowerCase().includes(q.toLowerCase()));

const views = {};

// --- Bookmarks ---------------------------------------------------------------------

// A folder at a time (folders first, "‹ <parent>" to go up); searching
// looks through all of them -- names, addresses, tags ("#tag") and notes.
views.bookmarks = async (root) => {
  let query = "";
  let folder = "";
  const list = el(`<div></div>`);
  const draw = async () => {
    const tree = await invoke("bookmark_tree").catch(() => ({ bookmarks: [], folders: [] }));
    const byId = new Map(tree.folders.map((f) => [f.id, f]));
    if (folder && !byId.has(folder)) folder = "";
    const bookmarkRow = (b, sub = hostOf(b.url)) =>
      row({
        leading: siteIcon(b.url, { label: b.title }),
        title: b.title || hostOf(b.url),
        sub,
        onOpen: (e) => open(b.url, e),
        actions: [
          { icon: "plus", title: "Open in a new tab", run: () => invoke("open_url", { url: b.url, how: "tab" }) },
          { icon: "trash", title: "Remove bookmark", danger: true, run: () => invoke("remove_bookmark", { url: b.url }) },
        ],
      });
    const folderRow = (id, title, iconName = "folder") => {
      const n = tree.bookmarks.filter((b) => b.folder === id).length;
      return row({
        leading: el(`<span style="width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--accent)">${icon(iconName, 16)}</span>`),
        title,
        sub: iconName === "folder" ? `${n} bookmark${n === 1 ? "" : "s"}` : "",
        className: "sb-bookmark-folder",
        onOpen: () => {
          folder = id;
          draw();
        },
      });
    };
    if (query) {
      const q = query.toLowerCase();
      const shown = tree.bookmarks.filter((b) => (q.startsWith("#") && q.length > 1 ? (b.tags || []).includes(q.slice(1)) : matches(query, b.title, b.url, b.description, (b.tags || []).join(" "))));
      list.replaceChildren(...(shown.length ? shown.map((b) => bookmarkRow(b, [hostOf(b.url), byId.get(b.folder)?.title].filter(Boolean).join(" · "))) : [empty("No bookmarks match.")]));
      return;
    }
    const here = byId.get(folder);
    const folders = tree.folders.filter((f) => f.parent === folder);
    const inside = tree.bookmarks.filter((b) => b.folder === folder);
    list.replaceChildren(
      ...(here ? [folderRow(here.parent, `‹ ${byId.get(here.parent)?.title || "Bookmarks bar"}`, "chevronLeft"), group(here.title)] : []),
      ...folders.map((f) => folderRow(f.id, f.title)),
      ...inside.map((b) => bookmarkRow(b)),
      ...(!folders.length && !inside.length ? [empty(here ? "This folder is empty." : "No bookmarks yet -- star a page, or add the one you're on.")] : [])
    );
  };
  root.append(
    head("Bookmarks", [
      {
        label: "Add this page",
        icon: "star",
        run: async () => {
          const page = await currentPage();
          if (!page) return;
          const id = await invoke("add_bookmark", { url: page.url, title: page.title });
          // Into the folder you're looking at.
          const tree = id && folder ? await invoke("bookmark_tree").catch(() => null) : null;
          const b = tree?.bookmarks.find((x) => x.id === id);
          if (b) await invoke("save_bookmark", { bookmark: { ...b, folder } }).catch(() => {});
        },
      },
      { label: "Manager", icon: "bookmark", title: "The bookmark manager (Ctrl+Shift+O)", run: () => invoke("open_singleton_tab", { route: `kessel://bookmarks${folder ? `/${encodeURIComponent(folder)}` : ""}` }) },
    ]),
    searchBox("Search bookmarks", (q) => {
      query = q;
      draw();
    }),
    list
  );
  await draw();
  return { refresh: draw, events: ["bookmarks-changed"] };
};

// --- Reading list -------------------------------------------------------------------

views.reading = async (root) => {
  let showRead = false;
  const segment = el(`<div class="sb-segment"><button data-v="unread">Unread</button><button data-v="read">Read</button></div>`);
  const list = el(`<div></div>`);
  const draw = async () => {
    const all = await invoke("get_reading_list").catch(() => []);
    const unread = all.filter((i) => !i.read);
    const read = all.filter((i) => i.read);
    segment.querySelector('[data-v="unread"]').textContent = `Unread (${unread.length})`;
    segment.querySelector('[data-v="read"]').textContent = `Read (${read.length})`;
    segment.querySelectorAll("button").forEach((b) => b.classList.toggle("active", (b.dataset.v === "read") === showRead));
    const shown = showRead ? read : unread;
    list.replaceChildren(
      ...(shown.length
        ? shown.map((i) =>
            row({
              leading: siteIcon(i.url, { label: i.title }),
              title: i.title,
              sub: `${hostOf(i.url)} · ${formatRelativeTime(i.added)}`,
              className: i.read ? "read" : "",
              onOpen: (e) => {
                open(i.url, e);
                if (!i.read) invoke("set_reading_read", { url: i.url, read: true });
              },
              actions: [
                { icon: i.read ? "undo" : "check", title: i.read ? "Mark as unread" : "Mark as read", run: () => invoke("set_reading_read", { url: i.url, read: !i.read }) },
                { icon: "trash", title: "Remove", danger: true, run: () => invoke("remove_from_reading_list", { url: i.url }) },
              ],
            })
          )
        : [empty(showRead ? "Nothing read yet." : "Nothing to read -- add the page you're on, or right-click a link: Add link to reading list.")])
    );
  };
  segment.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    showRead = b.dataset.v === "read";
    draw();
  });
  root.append(
    head("Reading list", [
      {
        label: "Add this page",
        icon: "plus",
        run: async () => {
          const page = await currentPage();
          if (page) invoke("add_to_reading_list", page).then(() => toast("Added to your reading list")).catch((err) => toast(String(err)));
        },
      },
    ]),
    segment,
    list
  );
  await draw();
  return { refresh: draw, events: ["reading-list-changed"] };
};

// --- History ------------------------------------------------------------------------

function dayLabel(seconds) {
  const d = new Date(seconds * 1000);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

views.history = async (root) => {
  let query = "";
  let loaded = [];
  const PAGE = 80;
  const list = el(`<div></div>`);
  const more = el(`<button class="btn sm sb-more">Show more</button>`);
  const draw = () => {
    const out = [];
    let lastDay = null;
    for (const v of loaded) {
      const day = dayLabel(v.visited_at);
      if (day !== lastDay) {
        out.push(group(day));
        lastDay = day;
      }
      out.push(
        row({
          leading: siteIcon(v.url, { label: v.title || v.host, guess: false }),
          title: v.title || v.url,
          sub: `${new Date(v.visited_at * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · ${v.host || hostOf(v.url)}`,
          onOpen: (e) => open(v.url, e),
          actions: [
            {
              icon: "trash",
              title: "Remove from history",
              danger: true,
              run: async () => {
                await invoke("delete_history", { ids: [v.id] });
                loaded = loaded.filter((x) => x.id !== v.id);
                draw();
              },
            },
          ],
        })
      );
    }
    list.replaceChildren(...(out.length ? out : [empty(query ? "Nothing in your history matches." : "No history yet.")]));
  };
  const load = async (reset) => {
    const page = await invoke("query_history", { text: query, limit: PAGE, offset: reset ? 0 : loaded.length }).catch(() => []);
    loaded = reset ? page : [...loaded, ...page];
    more.style.display = page.length < PAGE ? "none" : "";
    draw();
  };
  more.addEventListener("click", () => load(false));
  root.append(
    head("History", [{ label: "All history", icon: "history", run: () => invoke("open_singleton_tab", { route: "kessel://history" }) }]),
    searchBox("Search history", (q) => {
      query = q;
      load(true);
    }),
    list,
    more
  );
  await load(true);
  return { refresh: () => load(true), events: [] };
};

// --- Notes ------------------------------------------------------------------------------

views.notes = async (root) => {
  let query = "";
  let editing = null;
  const listView = el(`<div></div>`);
  const list = el(`<div></div>`);
  const firstLine = (n) => (n.text || "").trim().split("\n")[0].slice(0, 80) || "Empty note";
  const draw = async () => {
    if (editing) return;
    const all = await invoke("get_notes").catch(() => []);
    const shown = all.filter((n) => matches(query, n.text, n.title, n.url)).sort((a, b) => b.pinned - a.pinned || b.updated - a.updated);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((n) =>
            row({
              leading: el(`<span class="sb-glyph">${icon(n.pinned ? "pinFilled" : "note", 13)}</span>`),
              title: firstLine(n),
              sub: `${formatRelativeTime(n.updated)}${n.url ? ` · ${hostOf(n.url)}` : ""}`,
              onOpen: () => edit(n),
              actions: [
                { icon: n.pinned ? "pin" : "pinFilled", title: n.pinned ? "Unpin" : "Pin to the top", run: () => invoke("save_note", { note: { ...n, pinned: !n.pinned } }) },
                { icon: "trash", title: "Delete note", danger: true, run: async () => (await confirmDialog("Delete this note?", "Delete")) && invoke("delete_note", { id: n.id }) },
              ],
            })
          )
        : [empty(query ? "No notes match." : "No notes yet. Write one, or pick text on a page and right-click: Save selection to notes.")])
    );
  };
  const edit = (note) => {
    editing = { ...note };
    const editor = el(`<div class="note-editor">
      <div class="sb-head"><button class="btn sm" id="note-back">${icon("back", 13)}<span>Notes</span></button><h1></h1><button class="btn sm" id="note-link">${icon("link", 13)}<span>Link this page</span></button></div>
      <textarea placeholder="Write something…"></textarea>
      <div class="note-meta"></div>
    </div>`);
    const text = editor.querySelector("textarea");
    const meta = editor.querySelector(".note-meta");
    text.value = editing.text || "";
    const showMeta = (saved) => {
      meta.replaceChildren();
      if (editing.url) {
        const link = el(`<span class="note-link">${icon("globe", 11)}<span></span></span>`);
        link.lastElementChild.textContent = editing.title || hostOf(editing.url);
        link.title = editing.url;
        link.addEventListener("click", (e) => open(editing.url, e));
        meta.appendChild(link);
      }
      const when = el(`<span></span>`);
      when.textContent = saved ? "Saved" : editing.updated ? `Edited ${formatRelativeTime(editing.updated)}` : "";
      meta.appendChild(when);
    };
    const save = async () => {
      if (!editing || (!editing.id && !text.value.trim())) return;
      editing.text = text.value;
      const saved = await invoke("save_note", { note: editing }).catch((err) => toast(String(err)));
      if (saved && editing) {
        editing = { ...saved, text: text.value };
        showMeta(true);
      }
    };
    text.addEventListener("input", debounce(save, 400));
    editor.querySelector("#note-back").addEventListener("click", async () => {
      await save();
      editing = null;
      showList();
    });
    editor.querySelector("#note-link").addEventListener("click", async () => {
      const page = await currentPage();
      if (!page) return;
      editing.url = page.url;
      editing.title = page.title;
      await save();
      showMeta(true);
    });
    showMeta(false);
    root.replaceChildren(editor);
    text.focus();
  };
  const showList = () => {
    root.replaceChildren(listView);
    draw();
  };
  listView.append(
    head("Notes", [{ label: "New note", icon: "plus", run: () => edit({ id: "", text: "", url: "", title: "", pinned: false }) }]),
    searchBox("Search notes", (q) => {
      query = q;
      draw();
    }),
    list
  );
  showList();
  return { refresh: draw, events: ["notes-changed"], editNote: (n) => edit(n) };
};

// --- Search ------------------------------------------------------------------------------

views.search = async (root) => {
  const results = el(`<div></div>`);
  let serial = 0;
  const section = (title, rows) => (rows.length ? [group(title), ...rows] : []);
  const searchWeb = (q) => {
    const engine = engineById(currentSettings(), currentSettings()?.search_engine);
    invoke("tell_toolbar", { message: { type: "web-search", url: engine.url(q), query: q } });
  };
  const run = async (q) => {
    const mine = ++serial;
    if (!q) {
      results.replaceChildren(empty("Type to search your open tabs, bookmarks, reading list, notes and history. Enter searches the web, right here."));
      return;
    }
    const [tabs, bookmarks, reading, notes, history] = await Promise.all([
      invoke("all_tabs").catch(() => []),
      invoke("get_bookmarks").catch(() => []),
      invoke("get_reading_list").catch(() => []),
      invoke("get_notes").catch(() => []),
      invoke("query_history", { text: q, limit: 8, offset: 0 }).catch(() => []),
    ]);
    if (mine !== serial) return;
    const web = row({
      leading: el(`<span class="sb-glyph">${icon("globe", 13)}</span>`),
      title: `Search the web for “${q}”`,
      sub: engineById(currentSettings(), currentSettings()?.search_engine).name,
      onOpen: () => searchWeb(q),
    });
    results.replaceChildren(
      web,
      ...section("Open tabs", tabs.filter((t) => matches(q, t.title, t.url)).slice(0, 8).map((t) => row({ leading: siteIcon(t.url, { label: t.title, knownFavicon: t.favicon }), title: t.title || t.url, sub: hostOf(t.url), onOpen: () => invoke("focus_tab", { id: t.id }) }))),
      ...section("Bookmarks", bookmarks.filter((b) => matches(q, b.title, b.url)).slice(0, 8).map((b) => row({ leading: siteIcon(b.url, { label: b.title }), title: b.title || b.url, sub: hostOf(b.url), onOpen: (e) => open(b.url, e) }))),
      ...section("Reading list", reading.filter((i) => matches(q, i.title, i.url)).slice(0, 6).map((i) => row({ leading: siteIcon(i.url, { label: i.title }), title: i.title, sub: hostOf(i.url), onOpen: (e) => open(i.url, e) }))),
      ...section(
        "Notes",
        notes.filter((n) => matches(q, n.text, n.title)).slice(0, 6).map((n) => row({ leading: el(`<span class="sb-glyph">${icon("note", 13)}</span>`), title: (n.text || "").trim().split("\n")[0] || "Empty note", sub: formatRelativeTime(n.updated), onOpen: () => showPanel("notes", { note: n }) }))
      ),
      ...section("History", history.map((v) => row({ leading: siteIcon(v.url, { label: v.title, guess: false }), title: v.title || v.url, sub: hostOf(v.url), onOpen: (e) => open(v.url, e) })))
    );
  };
  const input = searchBox("Search tabs, bookmarks, history, notes…", (q) => run(q));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) searchWeb(input.value.trim());
  });
  root.append(head("Search"), input, results);
  run("");
  setTimeout(() => input.focus(), 30);
  return { refresh: () => run(input.value.trim()), events: ["bookmarks-changed", "reading-list-changed", "notes-changed"] };
};

// --- Workspaces (the toolbar keeps them: it's asked, and tells) ---------------------------

let workspaces = null; // { current, list: [{ id, name, icon, color, tabs }] }

views.workspaces = async (root) => {
  let form = null; // the workspace being made or changed: { id, name, icon, color, isNew }
  const tell = (message) => invoke("tell_toolbar", { message }).catch((err) => toast(String(err)));
  const draw = () => {
    root.replaceChildren(head("Workspaces", [{ label: "New", icon: "plus", run: () => { form = { id: "", name: "", icon: WORKSPACE_ICONS[1], color: WORKSPACE_COLORS[1], isNew: true }; draw(); } }]));
    if (form) root.append(workspaceForm());
    if (!workspaces) return;
    for (const w of workspaces.list) {
      const dot = el(`<span class="ws-dot"></span>`);
      dot.textContent = w.icon || "•";
      dot.style.background = w.color || "var(--surface-2)";
      const here = w.id === workspaces.current;
      root.append(
        row({
          leading: dot,
          title: w.name,
          sub: `${w.tabs} tab${w.tabs === 1 ? "" : "s"}${here ? " · you're here" : ""}`,
          className: here ? "current" : "",
          onOpen: () => tell({ type: "workspace-switch", id: w.id }),
          actions: [
            ...(here ? [] : [{ icon: "arrowRight", title: "Move the tab you're on here", run: () => tell({ type: "workspace-move-tab", id: w.id }) }]),
            { icon: "edit", title: "Rename, icon, colour", run: () => { form = { ...w, isNew: false }; draw(); } },
            ...(w.id ? [{ icon: "trash", title: "Delete", danger: true, run: async () => (await confirmDialog(`Delete the workspace “${w.name}”? Its tabs move to “${workspaces.list[0].name}”.`, "Delete")) && tell({ type: "workspace-delete", id: w.id }) }] : []),
          ],
        })
      );
    }
    root.append(empty("Each window shows one workspace's tabs at a time. The others' tabs sleep until you come back, and cost nothing meanwhile."));
  };
  const workspaceForm = () => {
    const f = el(`<div class="ws-form">
      <div class="row"><input class="field" style="flex:1" maxlength="40" placeholder="Name"><button class="btn sm primary"></button><button class="btn sm">Cancel</button></div>
      <div class="ws-colors" data-kind="icon"></div>
      <div class="ws-colors" data-kind="color"></div>
    </div>`);
    const name = f.querySelector("input");
    name.value = form.name || "";
    const [save, cancel] = f.querySelectorAll(".row button");
    save.textContent = form.isNew ? "Add" : "Save";
    const pick = (box, values, key, paint) => {
      for (const v of values) {
        const b = el(`<button></button>`);
        paint(b, v);
        b.classList.toggle("picked", form[key] === v);
        b.addEventListener("click", () => {
          form[key] = v;
          box.querySelectorAll("button").forEach((x) => x.classList.toggle("picked", x === b));
        });
        box.appendChild(b);
      }
    };
    pick(f.querySelector('[data-kind="icon"]'), WORKSPACE_ICONS, "icon", (b, v) => {
      b.textContent = v;
      b.style.cssText = "background:var(--surface-2);font-size:12px;width:26px;height:26px;border-radius:8px";
    });
    pick(f.querySelector('[data-kind="color"]'), WORKSPACE_COLORS, "color", (b, v) => (b.style.background = v));
    save.addEventListener("click", () => {
      tell({ type: form.isNew ? "workspace-new" : "workspace-edit", id: form.id, name: name.value.trim() || "Workspace", icon: form.icon, color: form.color });
      form = null;
      draw();
    });
    cancel.addEventListener("click", () => {
      form = null;
      draw();
    });
    name.addEventListener("keydown", (e) => e.key === "Enter" && save.click());
    setTimeout(() => name.focus(), 20);
    return f;
  };
  draw();
  tell({ type: "workspaces-get" });
  return { refresh: draw, events: [] };
};

// --- Extensions ----------------------------------------------------------------------------

views.extensions = async (root) => {
  const list = el(`<div></div>`);
  const draw = async () => {
    const all = (await invoke("list_extensions").catch(() => [])).filter((x) => !x.theme);
    list.replaceChildren(
      ...(all.length
        ? all.map((x) => {
            const leading = x.icon ? Object.assign(document.createElement("img"), { className: "ext-icon", src: x.icon, alt: "" }) : el(`<span class="sb-glyph">${icon("puzzle", 13)}</span>`);
            const openable = x.enabled && (x.popup || x.side_panel);
            return row({
              leading,
              title: x.name,
              sub: x.error ? `Couldn't run: ${x.error}` : !x.enabled ? "Off" : openable ? "Click to open it here" : x.description || `Version ${x.version}`,
              className: x.enabled ? "" : "off",
              onOpen: () => openable && invoke("open_extension_side_panel", { id: x.id }).catch((err) => toast(String(err))),
              actions: [
                { icon: x.enabled ? "eyeOff" : "eye", title: x.enabled ? "Turn off" : "Turn on", run: () => invoke("set_extension_enabled", { id: x.id, enabled: !x.enabled }).catch((err) => toast(String(err))) },
                ...(x.options ? [{ icon: "settings", title: "Options", run: () => invoke("open_extension_page", { id: x.id }) }] : []),
              ],
            });
          })
        : [empty("No extensions yet. Get some from the Chrome Web Store or Edge Add-ons: open one's page and click “Add to Kessel” in the address bar.")])
    );
  };
  root.append(
    head("Extensions", [
      { label: "Manage", icon: "settings", run: () => invoke("open_singleton_tab", { route: "kessel://settings/extensions" }) },
      { label: "Get more", icon: "plus", run: () => invoke("open_url", { url: "https://chromewebstore.google.com/", how: "tab" }) },
    ]),
    list
  );
  await draw();
  return { refresh: draw, events: ["extensions-changed"] };
};

// --- The page ---------------------------------------------------------------------------------

let current = null;
let view = null;

async function showPanel(id, options = {}) {
  if (!views[id]) id = "bookmarks";
  document.title = SIDEBAR_PANELS.find((p) => p.id === id).label;
  history.replaceState(null, "", `#${id}`);
  document.querySelectorAll("#sb-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.id === id));
  current = id;
  const root = document.getElementById("sb-body");
  root.replaceChildren();
  root.scrollTop = 0;
  view = await views[id](root);
  if (options.noteId && !options.note) options.note = (await invoke("get_notes").catch(() => [])).find((n) => n.id === options.noteId);
  if (options.note && view?.editNote) view.editNote(options.note);
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  const tabs = document.getElementById("sb-tabs");
  for (const p of SIDEBAR_PANELS) {
    const b = el(`<button role="tab" title="${escapeHtml(p.label)}" data-id="${p.id}">${icon(p.icon, 16)}</button>`);
    b.addEventListener("click", () => {
      showPanel(p.id);
      invoke("set_side_panel_kind", { kind: `sidebar:${p.id}` }).catch(() => {});
    });
    tabs.appendChild(b);
  }
  const ai = el(`<button title="AI assistant">${icon("sparkle", 16)}</button>`);
  ai.addEventListener("click", () => invoke("tell_toolbar", { message: { type: "ai-open" } }));
  tabs.appendChild(ai);

  // Lists changed anywhere show here at once.
  for (const event of ["bookmarks-changed", "reading-list-changed", "notes-changed", "extensions-changed"]) {
    listen(event, () => {
      if (view?.events?.includes(event)) view.refresh();
    });
  }
  // The toolbar: which page to show, and its workspaces.
  listenHere("toolbar-message", (e) => {
    const m = e.payload || {};
    if (m.type === "show") showPanel(m.panel, m);
    else if (m.type === "workspaces") {
      workspaces = m;
      if (current === "workspaces") view?.refresh();
    }
  });
  // kessel://sidebar/notes?note=<id> -> #notes?note=<id>: that note, open.
  const [panel, query] = location.hash.slice(1).split("?");
  await showPanel(panel || "bookmarks", { noteId: new URLSearchParams(query || "").get("note") });
});
