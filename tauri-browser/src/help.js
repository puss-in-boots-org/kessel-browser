// kessel://help (F1): every shortcut Kessel has -- read live from the
// command list, so shortcuts you changed show as you set them -- plus the
// mouse, the address bar, privacy, troubleshooting and version info.
// kessel://help/<section> opens at that section.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { toast, escapeHtml, keycapsHtml } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

const SECTIONS = [
  { id: "shortcuts", label: "Keyboard shortcuts", icon: "keyboard" },
  { id: "mouse", label: "Mouse", icon: "arrowRight" },
  { id: "address-bar", label: "Address bar", icon: "search" },
  { id: "tabs", label: "Tabs & windows", icon: "window" },
  { id: "privacy", label: "Privacy & data", icon: "shield" },
  { id: "troubleshooting", label: "Troubleshooting", icon: "warning" },
  { id: "about", label: "About Kessel", icon: "logo" },
];

// Keys that belong to the page itself (the engine handles them) or to a
// particular place, so they aren't in the command list.
const FIXED_SHORTCUTS = [
  {
    title: "In the address bar",
    lines: [
      ["Go to the address or search", ["Enter"]],
      ["Open in a new tab", ["Alt+Enter"]],
      ["Open in a new window", ["Shift+Enter"]],
      ["Add www. and .com, then go", ["Ctrl+Enter"], "kessel → www.kessel.com"],
      ["Undo your typing / back to the page", ["Esc"], "Press once to undo what you typed, twice to go back to the page"],
      ["Search instead of going to an address", ["?"], "Start with a question mark"],
    ],
  },
  {
    title: "On a page",
    lines: [
      ["Scroll down / up a screen", ["Space", "Shift+Space"]],
      ["Scroll down / up a screen", ["PgDn", "PgUp"]],
      ["Top / bottom of the page", ["Home", "End"]],
      ["Next / previous link or field", ["Tab", "Shift+Tab"]],
      ["Select all", ["Ctrl+A"]],
      ["Copy / cut / paste", ["Ctrl+C", "Ctrl+X", "Ctrl+V"]],
      ["Paste as plain text", ["Ctrl+Shift+V"]],
      ["Undo / redo", ["Ctrl+Z", "Ctrl+Y"]],
    ],
  },
];

const MOUSE = [
  ["Open a link in a new tab", "Ctrl + click, or middle-click", "Middle-click opens it behind the tab you're on; Ctrl + click too if you choose so in Settings"],
  ["Open a link in a new background tab", "Ctrl + Shift + click", ""],
  ["Open a link in a new window", "Shift + click", ""],
  ["Close a tab", "Middle-click the tab", ""],
  ["Zoom in / out", "Ctrl + mouse wheel", "Kessel remembers the zoom of each site"],
  ["Back / forward", "The mouse's side buttons", ""],
  ["Scroll freely", "Middle-click on the page (not on a link), then move", "Autoscroll: click again or press Esc to stop"],
  ["Move a tab into another window", "Drag it onto that window's tab strip", "The page moves along without reloading"],
  ["Open a tab in its own window", "Drag it out of the tab strip", "Or right-click the tab → Move to new window"],
  ["Maximize / restore the window", "Double-click the empty tab strip", ""],
  ["More for a tab", "Right-click it", "Duplicate, pop out, move to another window, close others…"],
];

const PAGES = [
  ["kessel://newtab", "The new tab page"],
  ["kessel://history", "Your history (Ctrl+H)"],
  ["kessel://downloads", "Downloads (Ctrl+J)"],
  ["kessel://settings", "Settings"],
  ["kessel://passwords", "Your passwords (Ctrl+Shift+L)"],
  ["kessel://help", "This page (F1)"],
];

function line(what, keysHtml, { note = "", custom = false } = {}) {
  return `<div class="line${custom ? " custom" : ""}" data-search="${escapeHtml(`${what} ${note} ${keysHtml.replace(/<[^>]+>/g, " ")}`.toLowerCase())}">
    <span class="what">${escapeHtml(what)}${note ? `<span class="note">${escapeHtml(note)}</span>` : ""}</span>
    <span class="keys">${keysHtml}</span>
  </div>`;
}

function combos(keys) {
  if (!keys.length) return `<span class="none">no shortcut</span>`;
  return keys.map((k) => `<span class="combo">${keycapsHtml(k)}</span>`).join(`<span class="alt">or</span>`);
}

function shortcutsSection(commands) {
  const categories = [];
  for (const c of commands) {
    let cat = categories.find((x) => x.name === c.category);
    if (!cat) categories.push((cat = { name: c.category, commands: [] }));
    cat.commands.push(c);
  }
  let html = `<p class="sub">Shortcuts marked <b>customized</b> are ones you changed. <a class="page-link" data-open="kessel://settings/shortcuts">Change shortcuts in Settings</a></p>`;
  for (const cat of categories) {
    html += `<h3>${escapeHtml(cat.name)}</h3><div class="card">`;
    for (const c of cat.commands) {
      const custom = JSON.stringify(c.keys) !== JSON.stringify(c.default_keys);
      html += line(c.label, combos(c.keys), { custom });
    }
    html += `</div>`;
  }
  for (const group of FIXED_SHORTCUTS) {
    html += `<h3>${escapeHtml(group.title)}</h3><div class="card">`;
    for (const [what, keys, note] of group.lines) html += line(what, combos(keys), { note });
    html += `</div>`;
  }
  return html;
}

function mouseSection() {
  let html = `<div class="card">`;
  for (const [what, how, note] of MOUSE) html += line(what, `<span class="combo">${escapeHtml(how)}</span>`, { note });
  return html + `</div>`;
}

function tips(items) {
  return `<div class="tips">${items
    .map(([title, body]) => `<div class="card tip" data-search="${escapeHtml(`${title} ${body.replace(/<[^>]+>/g, " ")}`.toLowerCase())}"><b>${escapeHtml(title)}</b>${body}</div>`)
    .join("")}</div>`;
}

function addressBarSection() {
  let html = tips([
    ["Search or go", "Type an address to go there, or anything else to search with your search engine. Pick the engine with the button at the right of the address bar."],
    ["Always search", "Start with <code>?</code> to search even for something that looks like an address. <kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>Ctrl</kbd>+<kbd>E</kbd> starts one for you."],
    ["Open it somewhere else", "<kbd>Alt</kbd>+<kbd>Enter</kbd> opens what you typed in a new tab, <kbd>Shift</kbd>+<kbd>Enter</kbd> in a new window."],
    ["Quick .com", "Type a name and press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>: <code>wikipedia</code> goes to www.wikipedia.com."],
    ["A page's source", "<kbd>Ctrl</kbd>+<kbd>U</kbd>, or type <code>view-source:</code> before an address."],
    ["Files on this PC", "<kbd>Ctrl</kbd>+<kbd>O</kbd> opens a file; <code>file:///C:/</code> browses a drive."],
  ]);
  html += `<h3>Kessel's own pages</h3><div class="card">`;
  for (const [url, what] of PAGES) html += line(what, `<a class="page-link" data-open="${escapeHtml(url)}"><code>${escapeHtml(url)}</code></a>`);
  return html + `</div>`;
}

function tabsSection() {
  return tips([
    ["Reopen what you closed", "<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> brings back the last closed tab -- or a whole window, if that closed last. History → Recently closed has the rest."],
    ["Jump to a tab", "<kbd>Ctrl</kbd>+<kbd>1</kbd> … <kbd>8</kbd> go to that tab, <kbd>Ctrl</kbd>+<kbd>9</kbd> to the last one; <kbd>Ctrl</kbd>+<kbd>Tab</kbd> cycles."],
    ["Windows", "<kbd>Ctrl</kbd>+<kbd>N</kbd> opens a new window. Drag a tab out of the strip to give it its own window, or onto another window's strip to move it there."],
    ["Private windows", "<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>. Nothing you do there is kept: no history, no cookies or sign-ins once the last private window closes."],
    ["Accounts", "Sign in to the same site with several accounts side by side: each account's tabs are grouped by its colour. Use the account button in the address bar."],
    ["Keep your tabs", `Turn on "Keep tabs when Kessel closes" and your windows, tabs, pinned tabs and groups come back next time. <a class="page-link" data-open="kessel://settings/tabs">Settings → Tabs</a>`],
    ["Right-click a tab", "Pin it (it shrinks to its icon at the front), mute it, duplicate it, put it to sleep, add it to a group, move it to another window, or close the tabs around it."],
    ["Several tabs at once", "<kbd>Ctrl</kbd>+click or <kbd>Shift</kbd>+click tabs to pick them: the tab menu and <kbd>Ctrl</kbd>+<kbd>W</kbd> then act on all of them."],
    ["Tab groups", "Right-click a tab → Add tab to new group, and type its name. Click the group's name to fold it, double-click to rename, right-click for its colour, Save group (it goes on the bookmarks bar) and more. \"Group tabs by site\" makes groups for you."],
    ["Find a tab", "<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> (or the arrow beside the tabs) searches every tab of every window, sleeping and recently closed ones too."],
    ["Sound", "A speaker shows on tabs playing sound: click it, or press <kbd>Ctrl</kbd>+<kbd>M</kbd>, to mute the tab."],
    ["Hover cards", "Rest the mouse on a tab for its title, a preview of the page and how much memory it's using. A dot on a tab means its page changed while you were elsewhere."],
    ["Vertical tabs", "Settings → Tabs → Tab layout: Side puts the tabs in a column beside the page. Drag its edge to resize it, or collapse it to icons."],
    ["Sleeping and paused tabs", "Background tabs are slowed down; after a while they're paused, and after longer they go to sleep to free memory -- waking up when you return. Tabs playing sound are left alone (Settings → Performance)."],
    ["Full screen", "<kbd>F11</kbd> hides everything but the page. Press it again to come back."],
    ["Zoom", "<kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd>, or <kbd>Ctrl</kbd> and the mouse wheel. <kbd>Ctrl</kbd>+<kbd>0</kbd> resets. Each site keeps its own zoom."],
  ]);
}

function privacySection() {
  return tips([
    ["Clear browsing data", `<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Del</kbd> removes history, cookies, cache and more, for the last hour or any time. <a class="page-link" data-open="kessel://settings/clear">Open it</a>`],
    ["History", `Kessel keeps your history for 90 days unless you change it. Delete single pages, whole sites or days in <a class="page-link" data-open="kessel://history">History</a>.`],
    ["Shields", "Blocks ads and trackers on every site, upgrades connections to HTTPS and strips tracking codes from links. The shield in the address bar shows what it blocked and turns it off for one site."],
    ["Passwords", "Kept in an encrypted vault that only your master password opens. Kessel offers to fill them in only on the site they belong to."],
    ["Separate profiles", "Run <code>kessel.exe --profile work</code> for a completely separate Kessel: its own history, bookmarks, passwords, settings and sign-ins."],
  ]);
}

function troubleshootingSection() {
  return tips([
    ["A page looks broken", "Reload it with <kbd>Ctrl</kbd>+<kbd>F5</kbd> -- that fetches everything again instead of using the cache. If a site blocks something it needs, try turning Shields off for it."],
    ["A page is stuck", "<kbd>Shift</kbd>+<kbd>Esc</kbd> opens the task manager: end the process of the page that hangs."],
    ["Text is too small or big", "<kbd>Ctrl</kbd>+<kbd>0</kbd> resets the zoom; Settings → Appearance changes Kessel's own interface size."],
    ["Shortcut doesn't work on a site", "Some sites use a shortcut themselves (a web editor's Ctrl+S, say): the site gets it first, as in any browser. Kessel's own tab and window shortcuts always work."],
    ["For developers", "<kbd>F12</kbd> opens the developer tools, <kbd>Ctrl</kbd>+<kbd>U</kbd> a page's source."],
  ]);
}

async function aboutSection() {
  const info = await invoke("about_info").catch(() => ({}));
  const rows = [
    ["Version", info.version ? `Kessel ${info.version}` : "Kessel"],
    ["Engine", info.engine ? `Microsoft Edge WebView2 ${info.engine}` : navigator.userAgent],
    ["Built with", info.tauri ? `Tauri ${info.tauri}` : "Tauri"],
    ["Profile", info.profile || "default"],
    ["Profile folder", info.profile_dir || ""],
  ];
  return `<div class="card about" data-search="about version engine profile kessel webview2 tauri">
    <div class="logo">${icon("logo", 30)}</div>
    <dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
  </div>
  <div class="actions">
    <button class="btn sm" id="copy-about">${icon("copy", 13)} Copy version info</button>
    <button class="btn sm" data-open="kessel://settings">${icon("settings", 13)} Settings</button>
  </div>`;
}

async function render() {
  const commands = await invoke("get_commands").catch(() => []);
  const bodies = {
    shortcuts: shortcutsSection(commands),
    mouse: mouseSection(),
    "address-bar": addressBarSection(),
    tabs: tabsSection(),
    privacy: privacySection(),
    troubleshooting: troubleshootingSection(),
    about: await aboutSection(),
  };
  $("sections").innerHTML = SECTIONS.map(
    (s) => `<section id="${s.id}"><h2>${escapeHtml(s.label)}</h2>${bodies[s.id]}</section>`,
  ).join("");

  for (const el of document.querySelectorAll("[data-open]")) {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      invoke("open_singleton_tab", { route: el.dataset.open }).catch((err) => toast(String(err)));
    });
  }
  $("copy-about")?.addEventListener("click", async () => {
    const text = [...document.querySelectorAll(".about dl dt")].map((dt) => `${dt.textContent}: ${dt.nextElementSibling.textContent}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch {
      toast("Couldn't copy -- clipboard unavailable");
    }
  });
  filter();
}

// Hides everything that doesn't match the search box.
function filter() {
  const needle = $("q").value.trim().toLowerCase();
  let any = false;
  for (const section of document.querySelectorAll("section")) {
    let shown = 0;
    for (const item of section.querySelectorAll("[data-search]")) {
      const match = !needle || item.dataset.search.includes(needle) || section.id.includes(needle);
      item.classList.toggle("hidden-by-search", !match);
      if (match) shown++;
    }
    // Headings of groups with nothing left.
    for (const h3 of section.querySelectorAll("h3")) {
      const card = h3.nextElementSibling;
      const empty = card && !card.querySelector("[data-search]:not(.hidden-by-search)");
      h3.classList.toggle("hidden-by-search", !!empty);
      card?.classList.toggle("hidden-by-search", !!empty);
    }
    const intro = section.querySelector(".sub");
    intro?.classList.toggle("hidden-by-search", !!needle);
    section.classList.toggle("hidden-by-search", shown === 0);
    if (shown) any = true;
  }
  document.body.classList.toggle("searching-empty", !any);
}

function showSection(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  markNav(id);
}

function markNav(id) {
  for (const a of document.querySelectorAll(".nav-item")) a.classList.toggle("active", a.dataset.section === id);
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  $("logo").outerHTML = icon("help", 18);
  $("search-icon").outerHTML = icon("search", 16);
  $("nav").innerHTML = SECTIONS.map(
    (s) => `<a class="nav-item" href="#${s.id}" data-section="${s.id}">${icon(s.icon, 15)}<span>${escapeHtml(s.label)}</span></a>`,
  ).join("");
  for (const a of document.querySelectorAll(".nav-item")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      history.replaceState(null, "", `#${a.dataset.section}`);
      showSection(a.dataset.section);
    });
  }
  await render();
  showSection(location.hash.slice(1) || "shortcuts");
  window.addEventListener("hashchange", () => showSection(location.hash.slice(1)));

  // The nav follows the scrolling.
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) markNav(visible.target.id);
    },
    { root: $("main"), rootMargin: "-70px 0px -60% 0px" },
  );
  for (const s of document.querySelectorAll("section")) observer.observe(s);

  $("q").addEventListener("input", filter);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") || (e.key === "/" && document.activeElement !== $("q"))) {
      e.preventDefault();
      $("q").focus();
      $("q").select();
    } else if (e.key === "Escape" && document.activeElement === $("q") && $("q").value) {
      e.preventDefault();
      $("q").value = "";
      filter();
    }
  });
  // Shortcuts you change in Settings show up here straight away.
  listen("settings-changed", () => render());
});
