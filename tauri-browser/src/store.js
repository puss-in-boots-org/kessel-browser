// kessel://store: Kessel's own extension store. The catalog
// (shared/store-catalog.js) lists extensions picked to suit Kessel; any
// other Chrome Web Store extension comes in by its link. Each is
// downloaded from the store (extensions.rs), looked over here -- what it
// may do, in words -- and added to Kessel's own runtime (ext_runtime.rs).

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { toast } from "./shared/api.js";
import { permissionLines } from "./shared/extension-info.js";
import { CATALOG, CATEGORIES, storeIdOf, nameFits } from "./shared/store-catalog.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

let tab = "all";
let installed = [];

const COLORS = ["#7c5cff", "#2f9bff", "#1fbf8f", "#ff7a45", "#e5487a", "#c08bff", "#3ab0c9", "#d9a400"];
function avatar(name, iconUrl) {
  const a = document.createElement("span");
  a.className = "avatar";
  if (iconUrl) {
    a.append(Object.assign(document.createElement("img"), { src: iconUrl, alt: "" }));
    return a;
  }
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  a.style.background = COLORS[h % COLORS.length];
  a.textContent = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?";
  return a;
}

const have = (id) => installed.find((x) => x.id === id);

function fitBadge(fit) {
  if (fit === "good") return `<span class="fit good" title="What it does fits what Kessel's runtime covers">Runs well in Kessel</span>`;
  if (fit === "limited") return `<span class="fit limited" title="Runs, with parts Kessel doesn't do yet">Works with limits</span>`;
  return "";
}

function card(entry) {
  const mine = have(entry.id);
  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `<div class="top"><div class="who"></div><div style="min-width:0"><div class="name"></div><div class="blurb"></div></div></div>
    <div class="note" ${entry.note ? "" : "hidden"}></div>
    <div class="bottom">${fitBadge(entry.fit)}<span class="grow"></span><button class="btn sm"></button></div>`;
  el.querySelector(".who").replaceWith(avatar(entry.name, mine?.icon));
  el.querySelector(".name").textContent = entry.name;
  el.querySelector(".blurb").textContent = entry.blurb;
  el.querySelector(".note").textContent = entry.note || "";
  const b = el.querySelector("button");
  if (mine) {
    b.innerHTML = `${icon("check", 13)}<span>Added</span>`;
    b.classList.add("ghost");
    b.addEventListener("click", () => openSettings());
  } else {
    b.classList.add("primary");
    b.innerHTML = `${icon("plus", 13)}<span>Add</span>`;
    b.addEventListener("click", () => install(entry.id, entry, b));
  }
  return el;
}

function installedCard(x) {
  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `<div class="top"><div class="who"></div><div style="min-width:0"><div class="name"></div><div class="blurb"></div></div></div>
    <div class="bottom"><span class="fit"></span><span class="grow"></span><button class="btn sm ghost">${icon("settings", 13)}<span>Manage</span></button></div>`;
  el.querySelector(".who").replaceWith(avatar(x.name, x.icon));
  el.querySelector(".name").textContent = `${x.name}  ${x.version}`;
  el.querySelector(".blurb").textContent = x.description || "";
  const fit = el.querySelector(".fit");
  if (x.runtime === "kessel") {
    fit.className = "fit good";
    fit.textContent = x.enabled ? "Kessel runtime" : "Kessel runtime · off";
  } else {
    fit.className = "fit engine";
    fit.textContent = x.enabled ? "Edge engine" : "Edge engine · off";
  }
  el.querySelector("button").addEventListener("click", () => openSettings());
  return el;
}

function render() {
  const q = $("q").value.trim().toLowerCase();
  const grid = $("grid");
  grid.replaceChildren();
  const linkId = storeIdOf($("q").value);
  renderLink(linkId);
  if (tab === "installed") {
    const list = installed.filter((x) => !x.theme && (!q || x.name.toLowerCase().includes(q)));
    if (!list.length) grid.append(Object.assign(document.createElement("div"), { className: "empty", textContent: q ? "None of your extensions match." : "No extensions yet -- add one from Featured." }));
    for (const x of list) grid.append(installedCard(x));
    return;
  }
  let list = CATALOG;
  if (q && !linkId) list = list.filter((e) => `${e.name} ${e.blurb}`.toLowerCase().includes(q));
  else if (tab === "all") list = list.filter((e) => e.featured).concat(list.filter((e) => !e.featured));
  else list = list.filter((e) => e.category === tab);
  if (!list.length) grid.append(Object.assign(document.createElement("div"), { className: "empty", textContent: "Nothing here matches. Paste a Chrome Web Store link to add any extension." }));
  for (const e of list) grid.append(card(e));
}

// A pasted Chrome Web Store link: add that one.
function renderLink(id) {
  const box = $("link");
  box.replaceChildren();
  if (!id) return;
  const known = CATALOG.find((e) => e.id === id);
  const mine = have(id);
  const el = document.createElement("div");
  el.className = "link-card";
  el.innerHTML = `${icon("puzzle", 22)}<div class="grow"><b></b><small></small></div><button class="btn sm primary"></button>`;
  el.querySelector("b").textContent = known ? known.name : "An extension from the Chrome Web Store";
  el.querySelector("small").textContent = mine ? `You have ${mine.name} already.` : "Kessel downloads it, shows you what it may do, then adds it to its own runtime.";
  const b = el.querySelector("button");
  b.innerHTML = mine ? `<span>Manage</span>` : `${icon("download", 13)}<span>Get it</span>`;
  b.addEventListener("click", () => (mine ? openSettings() : install(id, known, b)));
  box.append(el);
}

async function install(id, entry, button) {
  const label = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = "<span>Downloading…</span>";
  }
  const preview = await invoke("preview_store_extension", { store: "chrome", id }).catch((err) => (toast(`Couldn't get it from the Chrome Web Store: ${err}`), null));
  if (button) {
    button.disabled = false;
    button.innerHTML = label;
  }
  if (preview) showSheet(preview, entry);
}

// What it may do, before it's added.
function showSheet(preview, entry) {
  const x = preview.extension;
  const wrong = entry && !nameFits(entry, x.name);
  const back = document.createElement("div");
  back.className = "sheet-back";
  const lines = x.theme ? ["Change Kessel's colours"] : permissionLines(x);
  back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
    <h3><span class="who"></span><span><span class="n"></span> <span class="ver"></span></span></h3>
    <div class="desc" style="color:var(--text-dim);font-size:12.5px"></div>
    <ul></ul>
    <div class="warn" hidden></div>
    <div class="actions"><button class="btn sm">Cancel</button><button class="btn sm primary"></button></div>
  </div>`;
  back.querySelector(".who").replaceWith(avatar(x.name, x.icon));
  back.querySelector(".n").textContent = x.name;
  back.querySelector(".ver").textContent = preview.have ? `${x.version} (you have ${preview.have})` : x.version;
  back.querySelector(".desc").textContent = lines.length ? "It will be able to:" : "It asks for nothing that reaches your data.";
  const ul = back.querySelector("ul");
  for (const l of lines) ul.append(Object.assign(document.createElement("li"), { textContent: l }));
  const [cancel, add] = back.querySelectorAll(".actions button");
  add.textContent = x.theme ? "Use theme" : preview.have ? "Update" : "Add to Kessel";
  if (wrong) {
    const w = back.querySelector(".warn");
    w.hidden = false;
    w.textContent = `The store sent “${x.name}”, not ${entry.name}. Kessel won't add it from here.`;
    add.disabled = true;
  }
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      invoke("cancel_extension_install", { token: preview.token }).catch(() => {});
      close();
    }
  };
  document.addEventListener("keydown", onKey);
  cancel.addEventListener("click", () => {
    invoke("cancel_extension_install", { token: preview.token }).catch(() => {});
    close();
  });
  add.addEventListener("click", async () => {
    add.disabled = true;
    const done = await invoke("confirm_extension_install", { token: preview.token }).catch((err) => (toast(String(err)), null));
    close();
    if (done) toast(done.error ? `${done.name} was added, but couldn't run: ${done.error}` : `${done.name} is in Kessel -- its button is under the puzzle in the address bar`);
    await load();
  });
  document.body.append(back);
  add.focus();
}

const openSettings = () => invoke("open_singleton_tab", { route: "kessel://settings/extensions" }).catch((err) => toast(String(err)));

function drawTabs() {
  const box = $("tabs");
  box.replaceChildren();
  const all = [...CATEGORIES, { id: "installed", label: `Yours${installed.filter((x) => !x.theme).length ? ` (${installed.filter((x) => !x.theme).length})` : ""}` }];
  for (const c of all) {
    if (c.id === "installed") box.append(Object.assign(document.createElement("span"), { className: "grow" }));
    const chip = document.createElement("span");
    chip.className = `chip${tab === c.id ? " active" : ""}`;
    chip.textContent = c.label;
    chip.addEventListener("click", () => {
      tab = c.id;
      drawTabs();
      render();
    });
    box.append(chip);
  }
}

async function load() {
  installed = await invoke("list_extensions").catch(() => []);
  drawTabs();
  render();
  document.body.dataset.ready = "true";
}

window.addEventListener("DOMContentLoaded", async () => {
  $("title").innerHTML = `${icon("puzzle", 22)}<span>Kessel Store</span>`;
  $("search-icon").outerHTML = icon("search", 16);
  $("manage").innerHTML = `${icon("settings", 13)}<span>Manage extensions</span>`;
  $("manage").addEventListener("click", openSettings);
  $("cws").innerHTML = `${icon("globe", 13)}<span>Browse the Chrome Web Store</span>`;
  $("cws").addEventListener("click", () => invoke("open_url", { url: "https://chromewebstore.google.com/", how: "tab" }).catch((err) => toast(String(err))));
  $("file").innerHTML = `${icon("file", 13)}<span>Add from a file…</span>`;
  $("file").addEventListener("click", async () => {
    const preview = await invoke("preview_extension_file", {}).catch((err) => (toast(String(err)), null));
    if (preview) showSheet(preview, null);
  });
  await initTheme();
  $("q").addEventListener("input", render);
  $("q").addEventListener("keydown", (e) => {
    const id = storeIdOf($("q").value);
    if (e.key === "Enter" && id && !have(id)) install(id, CATALOG.find((x) => x.id === id), null);
  });
  // ?id=<id>: straight to adding that one (from "Add to Kessel").
  const asked = new URLSearchParams(location.search).get("id");
  await load();
  if (asked && storeIdOf(asked)) {
    $("q").value = asked;
    render();
  }
  listen("extensions-changed", load);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
});
