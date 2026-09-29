// Kessel for phones: everything you see besides the page itself -- the
// address bar, new tab page, suggestions, tab switcher, menus, bookmarks,
// history, downloads and settings. The browser (the Kotlin side) keeps the
// tabs and data; this draws them and asks it to act (bridge.js).
//
// The screen: just the bar (at the bottom, or the top) over the page, or --
// while the new tab page, the tab switcher, a menu or a panel is up -- the
// whole screen (syncMode).

import { icon } from "./shared/icons.js";
import { ENGINES, resolveInput, escapeHtml, hostOf, formatBytes, debounce } from "./shared/api.js";
import { instantAnswer, parseCurrencyQuery, convertCurrency, parseDefineQuery } from "./shared/answers.js";
import * as S from "./suggest.js";
import { native, on } from "./bridge.js";

const $ = (id) => document.getElementById(id);
const BAR_HEIGHT = 56;

const state = {
  settings: {},
  tabs: [],
  active: 0,
  closed: 0,
  info: {},
  bookmarks: [],
  history: null,
  favicons: {},
  thumbs: {},
  systemDark: null,
};

let editing = false;
let switcherOpen = false;
let switcherPrivate = false;
let sheetOpen = false;
let sheetKind = "";
let findOpen = false;
const panels = [];

const activeTab = () => state.tabs.find((t) => t.id === state.active);
const isNtp = () => {
  const t = activeTab();
  return !!t && !t.url;
};
const engineKey = () => state.settings.search_engine || "google";
const engine = () => ENGINES[engineKey()] || ENGINES.google;
const toast = (text) => native("app.toast", { text }).catch(() => {});
const esc = escapeHtml;

// --- The screen -------------------------------------------------------------------------

let lastMode = "";
function syncMode() {
  const full = editing || switcherOpen || panels.length > 0 || sheetOpen || isNtp();
  const position = state.settings.bar_position === "top" ? "top" : "bottom";
  document.body.dataset.bar = position;
  document.body.classList.toggle("full", full);
  document.body.classList.toggle("panel-open", panels.length > 0);
  document.body.classList.toggle("switcher-open", switcherOpen && panels.length === 0);
  renderLayers();
  const key = `${full ? "full" : "bar"}:${position}`;
  if (key !== lastMode) {
    lastMode = key;
    native("ui.mode", { mode: full ? "full" : "bar", height: BAR_HEIGHT, position }).catch(() => {});
  }
}

// Which full-screen layer shows: a panel, the switcher, suggestions, the new tab page.
function renderLayers() {
  const typed = editing && $("address-input").value.trim();
  $("panel").hidden = panels.length === 0;
  $("switcher").hidden = !switcherOpen || panels.length > 0;
  $("suggest").hidden = !typed || panels.length > 0 || switcherOpen;
  const showNtp = !typed && !switcherOpen && panels.length === 0 && (isNtp() || editing);
  const ntp = $("ntp");
  if (showNtp && ntp.hidden) renderNtp();
  ntp.hidden = !showNtp;
}

// --- Theme ------------------------------------------------------------------------------------

let lastColors = "";
function applyTheme() {
  const pref = state.settings.theme || "system";
  const systemDark = state.systemDark ?? matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = pref === "dark" || (pref === "system" && systemDark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const t = activeTab();
  const css = getComputedStyle(document.documentElement);
  const bg = t?.private ? css.getPropertyValue("--private").trim() : css.getPropertyValue("--surface").trim();
  const key = `${bg}|${dark}`;
  if (key !== lastColors) {
    lastColors = key;
    native("ui.colors", { bg, dark: dark || !!t?.private }).catch(() => {});
  }
}

// --- Site icons ---------------------------------------------------------------------------------

const LETTER_COLORS = ["#4285f4", "#7c5cff", "#e5484d", "#12a594", "#f76b15", "#d6409f", "#0090ff", "#30a46c"];

// A site's first letter: its name, not "www." or "en." in front of it.
function letterTile(host, size = 20) {
  const labels = String(host || "?").split(".");
  const name = labels.length > 2 ? labels.at(-2) : labels[0];
  const letter = name.trim()[0]?.toUpperCase() || "?";
  const color = LETTER_COLORS[letter.charCodeAt(0) % LETTER_COLORS.length];
  return `<span class="letter" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size * 0.55)}px">${esc(letter)}</span>`;
}

function safeImage(src) {
  return /^(data:image\/|https:\/\/)/i.test(src || "") ? src : "";
}

function faviconHtml(url, size = 20, known = "") {
  const host = hostOf(url);
  const src = safeImage(known || state.favicons[host] || state.favicons[`www.${host}`] || "");
  return src ? `<img src="${esc(src)}" alt="" width="${size}" height="${size}">` : letterTile(host, size);
}

// Loads the icons of these sites (once), then redraws with `redraw`.
const askedIcons = new Set();
async function loadFavicons(urls, redraw) {
  const hosts = [];
  for (const url of urls) {
    try {
      const h = new URL(url).host.toLowerCase();
      for (const host of [h, h.replace(/^www\./, ""), `www.${h.replace(/^www\./, "")}`]) {
        if (!askedIcons.has(host)) {
          askedIcons.add(host);
          hosts.push(host);
        }
      }
    } catch {}
  }
  if (!hosts.length) return;
  const found = await native("favicons.get", { hosts }).catch(() => ({}));
  let any = false;
  for (const [h, src] of Object.entries(found || {})) {
    state.favicons[h.replace(/^www\./, "")] = src;
    state.favicons[h] = src;
    any = true;
  }
  if (any) redraw();
}

// --- The bar --------------------------------------------------------------------------------------

function displayUrl(url) {
  if (/^https?:\/\//i.test(url)) return hostOf(url);
  return url;
}

function renderBar() {
  const t = activeTab();
  if (!t) return;
  document.body.classList.toggle("private-tab", !!t.private);
  const count = state.tabs.filter((x) => !!x.private === !!t.private).length;
  $("tab-count").textContent = count > 99 ? ":D" : String(count);
  if (!editing) {
    const text = $("address-text");
    text.textContent = t.url ? displayUrl(t.url) : t.private ? "Private tab" : "Search or type an address";
    text.classList.toggle("placeholder", !t.url);
  }
  const site = $("site-btn");
  let siteIcon = "search";
  if (!editing && t.url) siteIcon = t.secure ? "lock" : /^http:/.test(t.url) ? "unlock" : "globe";
  const shieldsOn = state.settings.adblock_enabled !== false && !offSite(t.url);
  const badge = !editing && t.url && shieldsOn && t.blocked > 0 ? `<span class="count">${t.blocked > 99 ? "99+" : t.blocked}</span>` : "";
  site.innerHTML = icon(siteIcon, 18) + badge;
  site.classList.toggle("insecure", !editing && /^http:/.test(t.url));
  const progress = $("progress");
  progress.classList.toggle("loading", !!t.loading && !!t.url);
  $("progress-fill").style.width = `${t.loading ? Math.max(8, t.progress) : 100}%`;
}

function offSite(url) {
  const host = hostOf(url).replace(/^www\./, "");
  return (state.settings.shields_off_sites || []).includes(host);
}

// --- Typing an address -------------------------------------------------------------------------------

let generation = 0;
let items = [];

async function startEditing(initial = null) {
  if (findOpen) closeFind();
  const t = activeTab();
  const input = $("address-input");
  editing = true;
  document.body.classList.add("editing");
  $("address-text").hidden = true;
  input.hidden = false;
  input.value = initial ?? (t?.url && /^https?:/.test(t.url) ? t.url : "");
  $("clear-btn").hidden = !input.value;
  renderBar();
  syncMode();
  input.focus();
  if (input.value && initial === null) input.select();
  if (!state.history) state.history = await native("history.suggest").catch(() => []);
  state.bookmarks = await native("bookmarks.list").catch(() => state.bookmarks);
  if (editing) updateSuggestions();
}

function stopEditing() {
  if (!editing) return;
  editing = false;
  generation++;
  document.body.classList.remove("editing");
  const input = $("address-input");
  input.blur();
  input.hidden = true;
  $("address-text").hidden = false;
  $("clear-btn").hidden = true;
  renderBar();
  syncMode();
}

function answerItem(a) {
  return { kind: "answer", answerKind: a.kind, title: a.title, detail: a.detail, copy: a.copy, swatch: a.swatch || null };
}

function updateSuggestions() {
  const input = $("address-input");
  const text = input.value;
  const t = text.trim();
  const g = ++generation;
  $("clear-btn").hidden = !text;
  renderLayers();
  if (!t) {
    items = [];
    renderSuggestions();
    return;
  }
  const s = state.settings;
  const tab = activeTab();
  const history = state.history || [];
  const completion = s.autocomplete_addresses !== false ? S.completeAddress(t, history) : null;
  const answer = s.address_answers !== false ? instantAnswer(t) : null;
  const b = {
    first: S.firstItem(t, engineKey(), completion),
    answers: answer ? [answerItem(answer)] : [],
    tabs: S.tabMatches(t, state.tabs, { activeId: state.active, private: tab?.private }),
    bookmarks: S.bookmarkMatches(t, state.bookmarks),
    history: S.historyMatches(t, history),
    suggestions: [],
  };
  const redraw = () => {
    if (g !== generation) return;
    items = S.assemble(b);
    renderSuggestions();
  };
  redraw();
  // Never from a private tab: what you type there stays on the phone.
  if (!tab?.private && s.search_suggestions !== false && t.length < 120 && !/^[a-z]+:\/\//i.test(t)) {
    native("net.suggest", { engine: engineKey(), text: t.replace(/^\?\s*/, "") })
      .then((list) => {
        b.suggestions = (list || []).filter((q) => !/^=/.test(q.trim())).slice(0, 4).map((q) => ({ kind: "suggestion", title: q, url: engine().url(q), fill: q }));
        redraw();
      })
      .catch(() => {});
  }
  if (s.address_answers !== false && !answer && !tab?.private) {
    const money = parseCurrencyQuery(t);
    if (money) {
      native("net.rates")
        .then((rates) => {
          const c = rates && convertCurrency(money, rates);
          if (!c) return;
          b.answers = [{ kind: "answer", answerKind: "currency", title: `${c.value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${money.to}`, detail: `${c.text} · ECB rate of ${rates.date}`, copy: c.value.toFixed(2) }];
          redraw();
        })
        .catch(() => {});
    }
    const word = parseDefineQuery(t);
    if (word) {
      native("net.define", { word })
        .then((d) => {
          if (!d) return;
          b.answers = [{ kind: "answer", answerKind: "definition", title: `${d.word}${d.part ? `  ·  ${d.part}` : ""}`, detail: `${d.definition} — Wiktionary`, url: engine().url(`define ${d.word}`) }];
          redraw();
        })
        .catch(() => {});
    }
  }
}

const KIND_ICONS = { search: "search", suggestion: "search", history: "history", bookmark: "star", tab: "tabs", go: "globe" };

function renderSuggestions() {
  const list = $("suggest-list");
  list.innerHTML = items
    .map((item, i) => {
      let ico;
      if (item.kind === "answer") ico = item.swatch ? `<span class="swatch" style="background:${esc(item.swatch)}"></span>` : icon(item.answerKind === "definition" ? "book" : "calculator", 20);
      else if (item.kind === "history" || item.kind === "bookmark" || item.kind === "tab" || (item.kind === "go" && item.completed)) ico = faviconHtml(item.url);
      else ico = icon(KIND_ICONS[item.kind] || "globe", 20);
      const detail = item.kind === "tab" ? `Switch to this tab · ${esc(item.detail)}` : esc(item.detail || "");
      const fill = item.fill ? `<button class="icon-btn fill" data-fill="${i}" aria-label="Edit">${icon("arrowUpLeft", 18)}</button>` : "";
      const urlDetail = ["history", "bookmark", "tab"].includes(item.kind);
      return `<li class="row ${item.kind}" data-i="${i}"><span class="ico">${ico}</span><span class="text"><div class="title">${esc(item.title)}</div>${detail ? `<div class="detail${urlDetail ? " url" : ""}">${detail}</div>` : ""}</span>${fill}</li>`;
    })
    .join("");
  loadFavicons(items.filter((i) => i.url && i.kind !== "search" && i.kind !== "suggestion").map((i) => i.url), renderSuggestions);
}

function go(url) {
  if (!url) return;
  const t = activeTab();
  if (t) native("nav.go", { id: t.id, url }).catch((err) => toast(err.message));
  else native("tabs.new", { url }).catch(() => {});
  state.history = null;
  stopEditing();
}

function activate(item) {
  if (!item) return;
  if (item.kind === "tab") {
    native("tabs.activate", { id: item.tabId });
    stopEditing();
  } else if (item.kind === "answer") {
    if (item.copy) {
      native("page.copy", { text: item.copy });
      stopEditing();
    } else if (item.url) go(item.url);
  } else {
    go(item.url);
  }
}

// --- The new tab page ---------------------------------------------------------------------------------

async function renderNtp() {
  const el = $("ntp");
  const t = activeTab();
  const priv = !!t?.private;
  el.innerHTML = `
    <div class="logo">${priv ? icon("incognito", 34) : "K"}</div>
    <h1>${priv ? "Private tab" : "Kessel"}</h1>
    <button class="search-pill" id="ntp-search">${icon("search", 18)}<span>Search or type an address</span></button>
    <div class="tiles" id="ntp-tiles"></div>
    ${priv ? `<p class="note">Pages you open in private tabs aren't kept in your history, and their cookies and site data are deleted when you close your last private tab. Your bookmarks and downloads stay. The sites you visit and your network can still see what you do.</p>` : ""}`;
  $("ntp-search").addEventListener("click", () => startEditing());
  if (priv) return;
  if (!state.history) state.history = await native("history.suggest").catch(() => []);
  let tiles = S.topSites(state.history, 8);
  if (tiles.length < 4) {
    for (let i = 0; i < state.bookmarks.length && tiles.length < 8; i++) {
      const b = state.bookmarks[i];
      if (!tiles.some((x) => x.url === b.url)) tiles.push({ url: b.url, title: b.title, host: hostOf(b.url) });
    }
  }
  const drawTiles = () => {
    const box = $("ntp-tiles");
    if (!box) return;
    box.innerHTML = tiles
      .map((x, i) => `<button class="tile" data-i="${i}"><span class="face">${faviconHtml(x.url, 28)}</span><span>${esc(x.title.split(/[-|–·:]/)[0].trim() || x.host)}</span></button>`)
      .join("");
  };
  drawTiles();
  $("ntp-tiles").onclick = (e) => {
    const b = e.target.closest(".tile");
    if (b) go(tiles[+b.dataset.i].url);
  };
  loadFavicons(tiles.map((x) => x.url), drawTiles);
}

// --- Tabs ---------------------------------------------------------------------------------------------

async function newTab(isPrivate = false) {
  closeSheet();
  switcherOpen = false;
  await native("tabs.new", { url: "", private: isPrivate && !!state.info.privateSupported }).catch(() => {});
  startEditing();
}

async function openSwitcher() {
  if (editing) stopEditing();
  await native("tabs.capture").catch(() => {});
  switcherPrivate = !!activeTab()?.private;
  state.thumbs = (await native("tabs.thumbnails").catch(() => null)) || {};
  switcherOpen = true;
  renderSwitcher();
  syncMode();
}

function closeSwitcher() {
  switcherOpen = false;
  syncMode();
}

function renderSwitcher() {
  const el = $("switcher");
  const list = state.tabs.filter((t) => !!t.private === switcherPrivate);
  const normal = state.tabs.filter((t) => !t.private).length;
  const priv = state.tabs.length - normal;
  const segments = state.info.privateSupported
    ? `<div class="segments"><button data-seg="0" class="${switcherPrivate ? "" : "on"}">${icon("tabs", 15)} ${normal}</button><button data-seg="1" class="${switcherPrivate ? "on" : ""}">${icon("incognito", 15)} ${priv}</button></div>`
    : `<h2 style="flex:1;margin:0 0 0 10px;font-size:18px">Tabs</h2>`;
  el.innerHTML = `
    <header>${segments}</header>
    ${list.length
      ? `<div class="grid">${list
          .map((t) => {
            const shot = state.thumbs[t.id];
            const face = t.url ? "" : `<span style="font-size:13px">${t.private ? icon("incognito", 30) : "New tab"}</span>`;
            return `<div class="card${t.id === state.active ? " active" : ""}${t.private ? " private-card" : ""}" data-id="${t.id}">
              <div class="card-head">${t.url ? faviconHtml(t.url, 16, t.favicon) : icon("plus", 14)}<span class="title">${esc(t.title || (t.url ? displayUrl(t.url) : "New tab"))}</span><button class="icon-btn close" aria-label="Close tab">${icon("close", 16)}</button></div>
              <div class="shot" style="${shot ? `background-image:url('${esc(shot)}')` : ""}">${shot ? "" : face || letterTile(hostOf(t.url), 34)}</div>
            </div>`;
          })
          .join("")}</div>`
      : `<p class="empty">${switcherPrivate ? "No private tabs open.<br>Private tabs leave no history on this phone." : "No tabs open."}</p>`}
    <div class="switcher-foot">
      <button class="text-btn" id="close-all"${list.length ? "" : " disabled"}>Close all</button>
      <button class="fab" id="switcher-new" aria-label="New tab">${icon("plus", 24)}</button>
      <button class="text-btn" id="switcher-done">Done</button>
    </div>`;
  el.querySelectorAll("[data-seg]").forEach((b) =>
    b.addEventListener("click", () => {
      switcherPrivate = b.dataset.seg === "1";
      renderSwitcher();
    }),
  );
  $("switcher-done").addEventListener("click", closeSwitcher);
  $("switcher-new").addEventListener("click", () => newTab(switcherPrivate));
  $("close-all").addEventListener("click", () =>
    openSheet(
      "confirm",
      `<div class="sheet-head"><div class="title">Close all ${switcherPrivate ? "private " : ""}tabs?</div></div>
       <div class="buttons"><button data-a="cancel">Cancel</button><button class="primary" data-a="ok">Close ${list.length}</button></div>`,
      (a) => {
        closeSheet();
        if (a === "ok") native("tabs.closeAll", { private: switcherPrivate });
      },
    ),
  );
  el.querySelectorAll(".card").forEach(wireCard);
}

// A card: tap to go there, × or a sideways swipe to close.
function wireCard(card) {
  const id = +card.dataset.id;
  let startX = null;
  let dx = 0;
  card.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    dx = 0;
  }, { passive: true });
  card.addEventListener("touchmove", (e) => {
    if (startX === null) return;
    dx = e.touches[0].clientX - startX;
    if (Math.abs(dx) > 10) {
      card.style.transition = "none";
      card.style.transform = `translateX(${dx}px)`;
      card.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 260));
    }
  }, { passive: true });
  card.addEventListener("touchend", () => {
    card.style.transition = "";
    if (Math.abs(dx) > 110) {
      card.style.transform = `translateX(${dx > 0 ? 400 : -400}px)`;
      card.style.opacity = "0";
      setTimeout(() => native("tabs.close", { id }), 160);
    } else {
      card.style.transform = "";
      card.style.opacity = "";
    }
    startX = null;
  });
  card.addEventListener("click", (e) => {
    if (Math.abs(dx) > 10) return;
    if (e.target.closest(".close")) {
      native("tabs.close", { id });
      return;
    }
    native("tabs.activate", { id });
    closeSwitcher();
  });
}

// Swipe along the address bar: the next or previous tab.
function wireBarSwipe() {
  const address = $("address");
  let x0 = null;
  let y0 = 0;
  address.addEventListener("touchstart", (e) => {
    if (editing) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  address.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > 40) return;
    const t = activeTab();
    const same = state.tabs.filter((x) => !!x.private === !!t?.private);
    const i = same.indexOf(t);
    const next = same[i + (dx < 0 ? 1 : -1)];
    if (next) {
      // The tap that ends a swipe isn't a tap on the address.
      swiped = true;
      setTimeout(() => (swiped = false), 400);
      native("tabs.activate", { id: next.id });
    }
  });
}
let swiped = false;

// --- Sheets ---------------------------------------------------------------------------------------------

let sheetAction = null;
function openSheet(kind, html, onAction) {
  // A site's question can't be left hanging behind another sheet: that's a "no".
  if (pendingPermission) {
    const deny = pendingPermission;
    pendingPermission = null;
    deny();
  }
  const sheet = $("sheet");
  sheet.innerHTML = html;
  sheetKind = kind;
  sheetAction = onAction;
  sheet.hidden = false;
  $("scrim").hidden = false;
  sheetOpen = true;
  syncMode();
  sheet.scrollTop = 0;
}

function closeSheet() {
  if (!sheetOpen) return;
  sheetOpen = false;
  sheetKind = "";
  sheetAction = null;
  $("sheet").hidden = true;
  $("scrim").hidden = true;
  syncMode();
}

function item(action, iconName, label, { hint = "", danger = false, toggle = null } = {}) {
  const right = toggle === null ? (hint ? `<span class="hint">${esc(hint)}</span>` : "") : `<span class="switch${toggle ? " on" : ""}"></span>`;
  return `<button class="item${danger ? " danger" : ""}" data-a="${action}">${icon(iconName, 20)}<span class="grow">${esc(label)}</span>${right}</button>`;
}

function openMenu() {
  const t = activeTab();
  const page = !!t?.url;
  const quick = `<div class="quick">
    <button class="icon-btn" data-a="back"${t?.canBack ? "" : " disabled"} aria-label="Back">${icon("back", 22)}</button>
    <button class="icon-btn" data-a="forward"${t?.canForward ? "" : " disabled"} aria-label="Forward">${icon("forward", 22)}</button>
    <button class="icon-btn${t?.bookmarked ? " on" : ""}" data-a="bookmark"${page && !t?.private ? "" : " disabled"} aria-label="Bookmark">${icon(t?.bookmarked ? "starFilled" : "star", 22)}</button>
    <button class="icon-btn" data-a="${t?.loading ? "stop" : "reload"}"${page ? "" : " disabled"} aria-label="Reload">${icon(t?.loading ? "close" : "reload", 22)}</button>
    <button class="icon-btn" data-a="share"${page ? "" : " disabled"} aria-label="Share">${icon("share", 22)}</button>
  </div>`;
  const list = [
    item("new-tab", "plus", "New tab"),
    state.info.privateSupported ? item("new-private", "incognito", "New private tab") : "",
    state.closed > 0 ? item("reopen", "undo", "Reopen closed tab") : "",
    item("bookmarks", "bookmark", "Bookmarks"),
    item("history", "history", "History"),
    item("downloads", "download", "Downloads"),
    page ? item("find", "find", "Find in page") : "",
    page ? item("desktop", "window", "Desktop site", { toggle: !!t?.desktop }) : "",
    page ? item("home-screen", "pin", "Add to home screen") : "",
    page ? item("print", "print", "Print or save as PDF") : "",
    item("settings", "settings", "Settings"),
  ].join("");
  openSheet("menu", quick + list, (a) => menuAction(a));
}

function menuAction(a) {
  const t = activeTab();
  if (a !== "desktop") closeSheet();
  switch (a) {
    case "back": return native("nav.back", {});
    case "forward": return native("nav.forward", {});
    case "reload": return native("nav.reload", {});
    case "stop": return native("nav.stop", {});
    case "share": return native("page.share", {});
    case "bookmark":
      if (!t) return;
      if (t.bookmarked) {
        native("bookmarks.remove", { url: t.url });
        return toast("Bookmark removed");
      }
      native("bookmarks.add", { url: t.url, title: t.title });
      return toast("Bookmarked");
    case "new-tab": return newTab(false);
    case "new-private": return newTab(true);
    case "reopen": return native("tabs.reopen", {});
    case "bookmarks": return openPanel("bookmarks");
    case "history": return openPanel("history");
    case "downloads": return openPanel("downloads");
    case "settings": return openPanel("settings");
    case "find": return openFind();
    case "desktop":
      closeSheet();
      return native("page.desktop", { on: !t?.desktop });
    case "home-screen": return native("page.addToHome", {});
    case "print": return native("page.print", {});
  }
}

// The lock / shield button: this site's connection, Shields and permissions.
async function openSiteSheet() {
  const t = activeTab();
  if (!t?.url || editing) return startEditing();
  const host = hostOf(t.url);
  const shieldsOn = state.settings.adblock_enabled !== false && !offSite(t.url);
  const perms = ((await native("permissions.list").catch(() => [])) || []).find((p) => p.host === new URL(t.url).host);
  const permText = perms ? ["camera", "microphone", "location"].filter((k) => k in perms).map((k) => `${k}: ${perms[k] ? "allowed" : "blocked"}`).join(", ") : "";
  const secure = t.secure;
  openSheet(
    "site",
    `<div class="sheet-head"><div class="title">${esc(host)}</div>
       <div class="detail">${secure ? "Connection is secure" : /^http:/.test(t.url) ? "Connection is not secure: others on the network can see and change this page" : esc(t.url)}</div></div>
     ${state.settings.adblock_enabled !== false ? item("shields", shieldsOn ? "shieldCheck" : "shieldOff", `Shields for ${host}`, { toggle: shieldsOn }) : ""}
     ${state.settings.adblock_enabled !== false && shieldsOn ? `<div class="check" style="color:var(--text-dim);padding-top:0">${t.blocked} ad and tracker request${t.blocked === 1 ? "" : "s"} blocked on this page</div>` : ""}
     ${permText ? item("reset-perms", "key", "Reset site permissions", { hint: permText }) : ""}
     ${item("desktop", "window", "Desktop site", { toggle: !!t.desktop })}
     ${item("copy", "copy", "Copy link")}`,
    async (a) => {
      closeSheet();
      if (a === "shields") {
        state.settings = await native("shields.site", { host, on: !shieldsOn });
        renderBar();
        toast(shieldsOn ? `Shields down for ${host}` : `Shields up for ${host}`);
      } else if (a === "reset-perms") {
        native("permissions.reset", { host: new URL(t.url).host });
        toast("Permissions reset");
      } else if (a === "desktop") {
        native("page.desktop", { on: !t.desktop });
      } else if (a === "copy") {
        native("page.copy", { text: t.url });
      }
    },
  );
}

// A long press on a link or a picture in the page.
function openContextSheet(c) {
  const actions = [];
  const link = c.kind === "link" || c.kind === "image-link";
  const image = c.kind === "image" || c.kind === "image-link";
  if (link && c.url) {
    actions.push(item("open-new", "plus", "Open in new tab"), item("open-background", "layers", "Open in background"));
    if (c.privateSupported && !c.private) actions.push(item("open-private", "incognito", "Open in private tab"));
    actions.push(item("copy-link", "link", "Copy link"));
    if (c.text) actions.push(item("copy-text", "copy", "Copy link text"));
    actions.push(item("share-link", "share", "Share link"), item("download-link", "download", "Download link"));
  }
  if (image) {
    actions.push(item("open-image", "popOut", "Open image in new tab"), item("download-image", "download", "Download image"));
    if (!/^data:/.test(c.image)) actions.push(item("copy-image-address", "link", "Copy image address"), item("share-image", "share", "Share image"));
  }
  const preview = image && /^https?:\/\//.test(c.image) ? `<img class="preview" src="${esc(c.image)}" alt="">` : "";
  const heading = link ? c.text || S.shortUrl(c.url) : "Image";
  openSheet(
    "context",
    `<div class="sheet-head"><div class="title">${esc(heading)}</div>${link ? `<div class="detail">${esc(c.url)}</div>` : ""}${preview}</div>${actions.join("")}`,
    (a) => {
      closeSheet();
      native("context.action", { action: a });
    },
  );
}

// A site asking for the camera, the microphone or your location.
const KIND_NAMES = { camera: "camera", microphone: "microphone", location: "location" };
function openPermissionSheet(p) {
  const kinds = p.kinds.map((k) => KIND_NAMES[k] || k);
  const what = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : kinds[0];
  const iconName = p.kinds.includes("location") ? "globe" : "activity";
  let answered = false;
  const answer = (allow) => {
    if (answered) return;
    answered = true;
    const remember = !p.private && !!$("perm-remember")?.checked;
    native("permissions.answer", { id: p.id, allow, remember });
    closeSheet();
  };
  openSheet(
    `permission:${p.id}`,
    `<div class="sheet-head"><div class="title">${icon(iconName, 18)} ${esc(p.host)} wants to use your ${esc(what)}</div>
       <div class="detail">${p.private ? "In a private tab: asked again next time." : "Android may ask too, the first time."}</div></div>
     ${p.private ? "" : `<label class="check"><input type="checkbox" id="perm-remember" checked> Remember for this site</label>`}
     <div class="buttons"><button data-a="block">Block</button><button class="primary" data-a="allow">Allow</button></div>`,
    (a) => answer(a === "allow"),
  );
  // Dismissing the sheet (scrim, Back) is a "no".
  pendingPermission = () => answer(false);
}
let pendingPermission = null;

// --- Find in page -------------------------------------------------------------------------------------

function openFind() {
  findOpen = true;
  $("bar-main").hidden = true;
  $("find-bar").hidden = false;
  $("find-count").textContent = "";
  const input = $("find-input");
  input.value = "";
  input.focus();
}

function closeFind() {
  if (!findOpen) return;
  findOpen = false;
  native("find.clear", {}).catch(() => {});
  $("find-input").blur();
  $("find-bar").hidden = true;
  $("bar-main").hidden = false;
}

// --- Panels: bookmarks, history, downloads, settings ------------------------------------------------------

function openPanel(name, data = {}) {
  if (editing) stopEditing();
  panels.push({ name, data });
  renderPanel();
  syncMode();
}

function closePanel() {
  const top = panels.pop();
  top?.cleanup?.();
  if (panels.length) renderPanel();
  syncMode();
}

function closeAllPanels() {
  while (panels.length) panels.pop()?.cleanup?.();
  syncMode();
}

function renderPanel() {
  const p = panels.at(-1);
  if (!p) return;
  p.cleanup?.();
  p.cleanup = null;
  const el = $("panel");
  el.scrollTop = 0;
  ({ bookmarks: bookmarksPanel, history: historyPanel, downloads: downloadsPanel, settings: settingsPanel, clear: clearPanel, permissions: permissionsPanel, shields: shieldsPanel })[p.name]?.(el, p);
}

function panelHead(title, actions = "") {
  return `<div class="panel-head"><button class="icon-btn" data-back aria-label="Back">${icon("back", 22)}</button><h2>${esc(title)}</h2>${actions}</div>`;
}

function wireBack(el) {
  el.querySelector("[data-back]")?.addEventListener("click", closePanel);
}

function openHere(url) {
  closeAllPanels();
  closeSwitcher();
  go(url);
}

async function bookmarksPanel(el) {
  state.bookmarks = (await native("bookmarks.list").catch(() => [])) || [];
  let query = "";
  const draw = () => {
    const words = S.wordsOf(query);
    const list = state.bookmarks.filter((b) => words.every((w) => `${b.title} ${b.url}`.toLowerCase().includes(w)));
    el.querySelector("#bm-list").innerHTML = list.length
      ? `<div class="group">${list
          .map((b) => `<div class="row" data-url="${esc(b.url)}"><span class="ico">${faviconHtml(b.url)}</span><span class="text"><div class="title">${esc(b.title || S.shortUrl(b.url))}</div><div class="detail">${esc(S.shortUrl(b.url))}</div></span><button class="icon-btn more" aria-label="More">${icon("dotsV", 18)}</button></div>`)
          .join("")}</div>`
      : `<p class="empty">${query ? "No bookmarks match." : "No bookmarks yet.<br>Tap ☆ in the menu to bookmark a page."}</p>`;
    loadFavicons(list.map((b) => b.url), draw);
  };
  el.innerHTML = `${panelHead("Bookmarks")}<label class="search-field">${icon("search", 18)}<input id="bm-q" type="search" placeholder="Search bookmarks"></label><div id="bm-list"></div>`;
  wireBack(el);
  el.querySelector("#bm-q").addEventListener("input", (e) => {
    query = e.target.value;
    draw();
  });
  el.querySelector("#bm-list").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const url = row.dataset.url;
    const b = state.bookmarks.find((x) => x.url === url);
    if (e.target.closest(".more")) {
      openSheet(
        "bookmark",
        `<div class="sheet-head"><div class="title">${esc(b?.title || url)}</div><div class="detail">${esc(url)}</div></div>
         ${item("open-new", "plus", "Open in new tab")}
         ${state.info.privateSupported ? item("open-private", "incognito", "Open in private tab") : ""}
         ${item("rename", "edit", "Rename")}
         ${item("copy", "link", "Copy link")}
         ${item("delete", "trash", "Delete", { danger: true })}`,
        async (a) => {
          closeSheet();
          if (a === "open-new" || a === "open-private") {
            closeAllPanels();
            native("tabs.new", { url, private: a === "open-private" });
          } else if (a === "copy") {
            native("page.copy", { text: url });
          } else if (a === "delete") {
            await native("bookmarks.remove", { url });
            state.bookmarks = state.bookmarks.filter((x) => x.url !== url);
            draw();
          } else if (a === "rename") {
            openSheet(
              "rename",
              `<div class="sheet-head"><div class="title">Rename bookmark</div></div>
               <div style="padding:4px 20px"><input id="rename-input" class="search-field" style="margin:0;width:100%;padding:0 14px;color:var(--text)" value="${esc(b?.title || "")}"></div>
               <div class="buttons"><button data-a="cancel">Cancel</button><button class="primary" data-a="save">Save</button></div>`,
              async (x) => {
                const title = $("rename-input")?.value.trim();
                closeSheet();
                if (x === "save" && title) {
                  await native("bookmarks.rename", { url, title });
                  state.bookmarks = (await native("bookmarks.list").catch(() => state.bookmarks)) || [];
                  draw();
                }
              },
            );
            setTimeout(() => $("rename-input")?.focus(), 50);
          }
        },
      );
      return;
    }
    openHere(url);
  });
  draw();
}

function dayLabel(seconds) {
  const d = new Date(seconds * 1000);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000;
  if (seconds >= start) return "Today";
  if (seconds >= start - 86400) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

async function historyPanel(el, p) {
  let query = "";
  let entries = [];
  let done = false;
  const load = async (reset) => {
    if (reset) {
      entries = [];
      done = false;
    }
    const page = (await native("history.page", { q: query, offset: entries.length, limit: 100 }).catch(() => [])) || [];
    entries = entries.concat(page);
    done = page.length < 100;
    draw();
  };
  const draw = () => {
    let html = "";
    let day = "";
    let open = false;
    for (const v of entries) {
      const label = dayLabel(v.last);
      if (label !== day) {
        if (open) html += "</div>";
        html += `<div class="day">${esc(label)}</div><div class="group">`;
        open = true;
        day = label;
      }
      const time = new Date(v.last * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      html += `<div class="row" data-url="${esc(v.url)}"><span class="ico">${faviconHtml(v.url)}</span><span class="text"><div class="title">${esc(v.title || S.shortUrl(v.url))}</div><div class="detail">${esc(time)} · ${esc(S.shortUrl(v.url))}</div></span><button class="icon-btn remove" aria-label="Remove">${icon("close", 16)}</button></div>`;
    }
    if (open) html += "</div>";
    if (!entries.length) html = `<p class="empty">${query ? "Nothing in your history matches." : "Your history is empty."}</p>`;
    if (!done) html += `<div style="text-align:center;padding:10px"><button class="text-btn" id="more">Show more</button></div>`;
    el.querySelector("#h-list").innerHTML = html;
    el.querySelector("#more")?.addEventListener("click", () => load(false));
    loadFavicons(entries.slice(0, 200).map((v) => v.url), draw);
  };
  el.innerHTML = `${panelHead("History", `<button class="text-btn" id="h-clear">Clear data</button>`)}<label class="search-field">${icon("search", 18)}<input id="h-q" type="search" placeholder="Search history"></label><div id="h-list"></div>`;
  wireBack(el);
  el.querySelector("#h-clear").addEventListener("click", () => openPanel("clear"));
  el.querySelector("#h-q").addEventListener(
    "input",
    debounce((e) => {
      query = e.target.value.trim();
      load(true);
    }, 200),
  );
  el.querySelector("#h-list").addEventListener("click", async (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    if (e.target.closest(".remove")) {
      await native("history.remove", { url: row.dataset.url });
      entries = entries.filter((v) => v.url !== row.dataset.url);
      state.history = null;
      draw();
      return;
    }
    openHere(row.dataset.url);
  });
  await load(true);
}

const DL_STATES = { waiting: "Waiting", paused: "Paused — waiting for a connection", failed: "Failed", gone: "Removed" };

async function downloadsPanel(el, p) {
  const draw = (list) => {
    el.querySelector("#dl-list").innerHTML = list.length
      ? `<div class="group">${list
          .map((d) => {
            const running = d.state === "running" || d.state === "waiting";
            const pct = d.size > 0 ? Math.round((d.received / d.size) * 100) : 0;
            const status = d.state === "done" ? [d.size > 0 ? formatBytes(d.size) : "", new Date(d.time * 1000).toLocaleDateString()].filter(Boolean).join(" · ") : d.state === "running" ? `${formatBytes(d.received)}${d.size > 0 ? ` of ${formatBytes(d.size)}` : ""}` : DL_STATES[d.state] || d.state;
            return `<div class="row" data-key="${esc(d.key)}" data-done="${d.state === "done"}"><span class="ico">${icon(d.state === "failed" ? "warning" : "file", 22)}</span><span class="text"><div class="title">${esc(d.name)}</div><div class="detail">${esc(status)}</div>${running && d.size > 0 ? `<div class="meter"><div style="width:${pct}%"></div></div>` : ""}</span><button class="icon-btn remove" aria-label="Delete">${icon("trash", 18)}</button></div>`;
          })
          .join("")}</div>`
      : `<p class="empty">No downloads yet.<br>Files you download go to your phone's Downloads folder.</p>`;
  };
  el.innerHTML = `${panelHead("Downloads", `<button class="text-btn" id="dl-clear">Clear list</button>`)}<div id="dl-list"></div>`;
  wireBack(el);
  const refresh = async () => draw((await native("downloads.list").catch(() => [])) || []);
  el.querySelector("#dl-clear").addEventListener("click", async () => {
    await native("downloads.clear", {});
    refresh();
  });
  el.querySelector("#dl-list").addEventListener("click", async (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    if (e.target.closest(".remove")) {
      await native("downloads.remove", { key: row.dataset.key });
      toast("Deleted");
      refresh();
    } else if (row.dataset.done === "true") {
      native("downloads.open", { key: row.dataset.key });
    }
  });
  await refresh();
  const timer = setInterval(refresh, 1000);
  p.cleanup = () => clearInterval(timer);
}

// --- Settings ------------------------------------------------------------------------------------------------

// A switch for a setting that's on unless it's false -- or, `offByDefault`,
// off unless it's true.
function sw(key, title, detail = "", { offByDefault = false } = {}) {
  const on = offByDefault ? state.settings[key] === true : state.settings[key] !== false;
  return `<button class="setting" data-toggle="${key}" data-off-default="${offByDefault}"><span class="text"><div class="title">${esc(title)}</div>${detail ? `<div class="detail">${esc(detail)}</div>` : ""}</span><span class="switch${on ? " on" : ""}"></span></button>`;
}

function sel(key, title, options, detail = "") {
  const value = String(state.settings[key]);
  return `<label class="setting"><span class="text"><div class="title">${esc(title)}</div>${detail ? `<div class="detail">${esc(detail)}</div>` : ""}</span><select data-select="${key}">${options.map(([v, label]) => `<option value="${esc(String(v))}"${String(v) === value ? " selected" : ""}>${esc(label)}</option>`).join("")}</select></label>`;
}

function link(action, title, detail = "") {
  return `<button class="setting" data-link="${action}"><span class="text"><div class="title">${esc(title)}</div>${detail ? `<div class="detail">${esc(detail)}</div>` : ""}</span>${icon("chevronRight", 18)}</button>`;
}

async function saveSettings(patch) {
  state.settings = await native("settings.set", { patch }).catch(() => state.settings);
  applyTheme();
  renderBar();
  syncMode();
  return state.settings;
}

async function settingsPanel(el) {
  const shields = (await native("shields.info").catch(() => null)) || { rules: 0 };
  const info = (await native("app.info").catch(() => null)) || state.info;
  state.info = { ...state.info, ...info };
  const s = state.settings;
  const textZoom = Number(s.text_zoom) || 100;
  el.innerHTML = `${panelHead("Settings")}
    ${info.isDefault ? "" : `<div class="group">${link("default", "Make Kessel your default browser", "Links you tap in other apps open here")}</div>`}

    <div class="group-title">Search</div>
    <div class="group">
      ${sel("search_engine", "Search engine", Object.entries(ENGINES).map(([k, e]) => [k, e.name]))}
      ${sw("search_suggestions", "Search suggestions", "Your search engine's suggestions as you type. Never from a private tab.")}
      ${sw("address_answers", "Answers in the address bar", "Calculator, units, currencies, definitions, the time anywhere")}
      ${sw("autocomplete_addresses", "Complete addresses", "Type “yout” and go to youtube.com if you've been there")}
    </div>

    <div class="group-title">Look</div>
    <div class="group">
      ${sel("theme", "Theme", [["system", "Like the phone"], ["dark", "Dark"], ["light", "Light"]])}
      ${sel("bar_position", "Address bar", [["bottom", "At the bottom"], ["top", "At the top"]], "At the bottom is easier to reach with your thumb")}
      ${sw("dark_pages", "Dark pages", "Pages without a dark look of their own get one when Kessel is dark (Android 13 and later)")}
      <label class="setting"><span class="text"><div class="title">Text size</div><div class="detail" id="zoom-value">${textZoom}%</div></span><input type="range" min="50" max="200" step="10" value="${textZoom}" id="text-zoom"></label>
    </div>

    <div class="group-title">Privacy and Shields</div>
    <div class="group">
      ${sw("adblock_enabled", "Shields", `Block ads and trackers on every site. ${shields.rules ? `${shields.rules.toLocaleString()} servers on the lists.` : "Getting the lists…"}`)}
      ${sw("shields_strip_tracking", "Remove tracking from links", "fbclid, gclid, utm_ and friends")}
      ${sw("block_popups", "Block pop-ups", "Windows a page opens without you tapping anything")}
      ${sw("third_party_cookies", "Allow third-party cookies", "Off: other sites' cookies stay out of the page you're on", { offByDefault: true })}
      ${sw("javascript", "JavaScript", "Most sites need it")}
      ${link("shields", "Filter lists and sites", "Update the lists; sites you turned Shields off for")}
      ${link("permissions", "Site permissions", "Camera, microphone and location you allowed or blocked")}
      ${link("clear", "Clear browsing data", "History, cookies, cached files")}
    </div>

    <div class="group-title">Tabs</div>
    <div class="group">
      ${sw("restore_tabs", "Keep tabs when Kessel closes", "Your tabs come back next time (private tabs never do)")}
      ${sw("desktop_site", "Desktop site for new tabs", "Sites show their computer version", { offByDefault: true })}
      ${sel("max_awake_tabs", "Pages kept in memory", [2, 3, 4, 6, 8, 10, 12].map((n) => [n, `${n} tabs`]), "The rest sleep and reload when you go back to them")}
      ${sel("history_days", "Keep history for", [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"], [0, "Forever"]])}
    </div>

    <div class="group-title">About</div>
    <div class="group">
      <div class="setting"><span class="text"><div class="title">Kessel ${esc(info.version || "")}</div><div class="detail">Android ${esc(info.android || "")} · Android System WebView ${esc(info.webview || "")}${info.privateSupported ? "" : " · Private tabs need a newer WebView"}</div></span></div>
      <div class="setting"><span class="text"><div class="detail">Kessel is free software under the GNU GPL 3.0. The phone version has what works on a phone: the desktop's windows, split view, side panel, password vault, imports and extensions stay on the desktop.</div></span></div>
    </div>`;
  wireBack(el);
  el.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      const key = b.dataset.toggle;
      const current = b.dataset.offDefault === "true" ? state.settings[key] === true : state.settings[key] !== false;
      await saveSettings({ [key]: !current });
      b.querySelector(".switch").classList.toggle("on", !current);
    }),
  );
  el.querySelectorAll("[data-select]").forEach((select) =>
    select.addEventListener("change", () => {
      const key = select.dataset.select;
      const numeric = ["max_awake_tabs", "history_days"].includes(key);
      saveSettings({ [key]: numeric ? Number(select.value) : select.value });
    }),
  );
  const zoom = el.querySelector("#text-zoom");
  zoom.addEventListener("input", () => (el.querySelector("#zoom-value").textContent = `${zoom.value}%`));
  zoom.addEventListener("change", () => saveSettings({ text_zoom: Number(zoom.value) }));
  el.querySelectorAll("[data-link]").forEach((b) =>
    b.addEventListener("click", () => {
      const a = b.dataset.link;
      if (a === "default") native("app.defaultBrowser", {});
      else openPanel(a);
    }),
  );
}

function clearPanel(el) {
  el.innerHTML = `${panelHead("Clear browsing data")}
    <div class="group">
      ${sel("__range", "Time range", [["3600", "Last hour"], ["86400", "Last 24 hours"], ["604800", "Last 7 days"], ["0", "All time"]])}
    </div>
    <div class="group" style="padding:6px 0">
      <label class="check"><input type="checkbox" id="c-history" checked> Browsing history</label>
      <label class="check"><input type="checkbox" id="c-cookies"> Cookies and site data <span style="color:var(--text-faint);font-size:12.5px">— signs you out of most sites</span></label>
      <label class="check"><input type="checkbox" id="c-cache" checked> Cached images and files</label>
      <label class="check"><input type="checkbox" id="c-downloads"> Downloads list <span style="color:var(--text-faint);font-size:12.5px">— the files stay</span></label>
    </div>
    <div class="buttons" style="padding:6px 12px"><button class="primary" id="c-go">Clear data</button></div>
    <p class="empty" style="padding:10px 30px">Cookies and cached files go for all time, whatever the range: Android's WebView can't delete them by date.</p>`;
  wireBack(el);
  el.querySelector('[data-select="__range"]').value = "3600";
  el.querySelector("#c-go").addEventListener("click", async () => {
    const range = Number(el.querySelector('[data-select="__range"]').value);
    const since = range ? Math.floor(Date.now() / 1000) - range : 0;
    await native("data.clear", {
      since,
      history: $("c-history").checked,
      cookies: $("c-cookies").checked,
      cache: $("c-cache").checked,
      downloads: $("c-downloads").checked,
    });
    state.history = null;
    toast("Cleared");
    closePanel();
  });
}

async function permissionsPanel(el) {
  const draw = async () => {
    const list = (await native("permissions.list").catch(() => [])) || [];
    el.innerHTML = `${panelHead("Site permissions", list.length ? `<button class="text-btn" id="p-reset-all">Reset all</button>` : "")}
      ${list.length
        ? `<div class="group">${list
            .map((p) => {
              const what = ["camera", "microphone", "location"].filter((k) => k in p).map((k) => `${k} ${p[k] ? "allowed" : "blocked"}`).join(", ");
              return `<div class="row" data-host="${esc(p.host)}"><span class="ico">${faviconHtml(`https://${p.host}/`)}</span><span class="text"><div class="title">${esc(p.host)}</div><div class="detail">${esc(what)}</div></span><button class="icon-btn remove" aria-label="Reset">${icon("close", 16)}</button></div>`;
            })
            .join("")}</div>`
        : `<p class="empty">No site has asked yet.<br>When a site asks for your camera, microphone or location, your answer can be remembered here.</p>`}`;
    wireBack(el);
    el.querySelector("#p-reset-all")?.addEventListener("click", async () => {
      await native("permissions.reset", {});
      draw();
    });
    el.querySelectorAll(".remove").forEach((b) =>
      b.addEventListener("click", async () => {
        await native("permissions.reset", { host: b.closest(".row").dataset.host });
        draw();
      }),
    );
  };
  await draw();
}

async function shieldsPanel(el) {
  const draw = async () => {
    const info = (await native("shields.info").catch(() => null)) || { rules: 0, lists: [] };
    const off = state.settings.shields_off_sites || [];
    const updated = info.updated ? new Date(info.updated).toLocaleDateString() : "the lists that came with Kessel";
    el.innerHTML = `${panelHead("Filter lists and sites")}
      <div class="group">
        <div class="setting"><span class="text"><div class="title">${(info.rules || 0).toLocaleString()} ad and tracking servers</div><div class="detail">${esc((info.lists || []).join(", "))} · updated ${esc(updated)}. They update by themselves every few days.</div></span></div>
        ${link("update", "Update now")}
      </div>
      <div class="group-title">Shields are down for</div>
      <div class="group" style="padding:8px 10px">${off.length ? off.map((h) => `<span class="chip">${esc(h)}<button class="icon-btn" data-host="${esc(h)}" style="width:28px;height:28px" aria-label="Shields up">${icon("close", 14)}</button></span>`).join("") : `<div class="detail" style="padding:6px;color:var(--text-dim);font-size:13px">No sites. Turn Shields off for a site from the lock beside its address.</div>`}</div>`;
    wireBack(el);
    el.querySelector('[data-link="update"]').addEventListener("click", async () => {
      toast("Updating the filter lists…");
      const count = await native("shields.update", {}).catch(() => null);
      toast(count ? `${count.toLocaleString()} servers on the lists` : "Couldn't update the lists");
      draw();
    });
    el.querySelectorAll("[data-host]").forEach((b) =>
      b.addEventListener("click", async () => {
        state.settings = await native("shields.site", { host: b.dataset.host, on: true });
        draw();
      }),
    );
  };
  await draw();
}

// --- Back ----------------------------------------------------------------------------------------------------

// Android's Back: close what's open, innermost first. false: nothing was
// (the browser goes back in the page instead).
window.__kesselBack = () => {
  if (sheetOpen) {
    const pending = pendingPermission;
    closeSheet();
    pending?.();
    return true;
  }
  if (findOpen) {
    closeFind();
    return true;
  }
  if (editing) {
    stopEditing();
    return true;
  }
  if (panels.length) {
    closePanel();
    return true;
  }
  if (switcherOpen) {
    closeSwitcher();
    return true;
  }
  return false;
};

// --- Wiring --------------------------------------------------------------------------------------------------

function wire() {
  $("site-btn").innerHTML = icon("search", 18);
  $("menu-btn").innerHTML = icon("dotsV", 20);
  $("clear-btn").innerHTML = icon("close", 18);
  $("find-prev").innerHTML = icon("chevronDown", 20);
  $("find-prev").style.transform = "rotate(180deg)";
  $("find-next").innerHTML = icon("chevronDown", 20);
  $("find-close").innerHTML = icon("close", 20);

  $("address").addEventListener("click", () => {
    if (swiped) {
      swiped = false;
      return;
    }
    if (!editing) startEditing();
  });
  $("site-btn").addEventListener("click", openSiteSheet);
  $("menu-btn").addEventListener("click", openMenu);
  $("tabs-btn").addEventListener("click", openSwitcher);
  $("clear-btn").addEventListener("click", () => {
    const input = $("address-input");
    input.value = "";
    input.focus();
    updateSuggestions();
  });
  // Holding the tabs button: a new tab, or a new private one.
  let hold = null;
  $("tabs-btn").addEventListener("touchstart", () => {
    hold = setTimeout(() => {
      hold = "fired";
      openSheet(
        "tabs",
        `${item("new-tab", "plus", "New tab")}${state.info.privateSupported ? item("new-private", "incognito", "New private tab") : ""}${item("close-tab", "close", "Close this tab")}`,
        (a) => {
          closeSheet();
          if (a === "new-tab") newTab(false);
          else if (a === "new-private") newTab(true);
          else if (a === "close-tab" && state.active) native("tabs.close", { id: state.active });
        },
      );
    }, 500);
  }, { passive: true });
  $("tabs-btn").addEventListener("touchend", (e) => {
    if (hold === "fired") e.preventDefault();
    else clearTimeout(hold);
    hold = null;
  });

  const input = $("address-input");
  input.addEventListener("input", updateSuggestions);
  $("bar-main").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (items[0]) activate(items[0]);
    else go(resolveInput(text, engineKey()));
  });
  $("suggest-list").addEventListener("click", (e) => {
    const fill = e.target.closest("[data-fill]");
    if (fill) {
      const it = items[+fill.dataset.fill];
      input.value = it.fill;
      input.focus();
      updateSuggestions();
      return;
    }
    const row = e.target.closest(".row");
    if (row) activate(items[+row.dataset.i]);
  });

  // Find in page.
  const findInput = $("find-input");
  findInput.addEventListener(
    "input",
    debounce(() => {
      const text = findInput.value;
      if (text) native("find.start", { text });
      else {
        native("find.clear", {});
        $("find-count").textContent = "";
      }
    }, 150),
  );
  $("find-bar").addEventListener("submit", (e) => {
    e.preventDefault();
    native("find.next", { forward: true });
  });
  $("find-next").addEventListener("click", () => native("find.next", { forward: true }));
  $("find-prev").addEventListener("click", () => native("find.next", { forward: false }));
  $("find-close").addEventListener("click", closeFind);

  // Sheets.
  $("scrim").addEventListener("click", () => window.__kesselBack());
  $("sheet").addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]");
    if (!b || b.disabled) return;
    if (sheetKind.startsWith("permission:")) pendingPermission = null;
    sheetAction?.(b.dataset.a);
  });

  wireBarSwipe();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    state.systemDark = null;
    applyTheme();
  });
}

function listen() {
  on("tabs", (p) => {
    state.tabs = p.tabs;
    state.active = p.active;
    state.closed = p.closed;
    afterTabsChanged();
  });
  on("tab", (t) => {
    const i = state.tabs.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tabs[i] = { ...state.tabs[i], ...t };
    if (t.active || t.id === state.active) renderBar();
    // The new tab page went to a site (or the other way round).
    if (t.id === state.active) syncMode();
  });
  on("blocked", (b) => {
    const t = state.tabs.find((x) => x.id === b.id);
    if (t) {
      t.blocked = b.count;
      if (b.id === state.active) renderBar();
    }
  });
  on("find", (f) => ($("find-count").textContent = f.count ? `${f.active}/${f.count}` : "0/0"));
  on("context", openContextSheet);
  on("permission", openPermissionSheet);
  on("permission-cancel", (p) => {
    if (sheetKind === `permission:${p.id}`) {
      pendingPermission = null;
      closeSheet();
    }
  });
  on("open", (o) => {
    const url = resolveInput(o.text, engineKey());
    if (url) native("tabs.new", { url });
  });
  on("new-tab", (o) => newTab(!!o.private));
  on("system-theme", (t) => {
    state.systemDark = !!t.dark;
    applyTheme();
  });
  on("app-info", (info) => {
    state.info = { ...state.info, ...info };
    if (panels.at(-1)?.name === "settings") renderPanel();
  });
  on("shields-lists", () => {
    if (panels.at(-1)?.name === "shields") renderPanel();
  });
}

let lastActiveId = 0;
function afterTabsChanged() {
  const t = activeTab();
  if (state.active !== lastActiveId) {
    lastActiveId = state.active;
    if (editing) stopEditing();
    if (findOpen) closeFind();
    $("ntp").hidden = true; // redrawn for the new tab (private or not)
  }
  applyTheme();
  renderBar();
  if (switcherOpen) renderSwitcher();
  syncMode();
  if (!t) return;
}

async function start() {
  wire();
  listen();
  const init = await native("ready");
  state.settings = init.settings;
  state.tabs = init.tabs;
  state.active = init.active;
  state.closed = init.closed;
  state.info = init;
  lastActiveId = state.active;
  state.bookmarks = (await native("bookmarks.list").catch(() => [])) || [];
  applyTheme();
  renderBar();
  syncMode();
}

start().catch((err) => console.error("Kessel UI failed to start:", err));
