// The address bar's extensions popup (toggle_popup "extensions"): your
// extensions, each a click from its own popup -- or, from "Add to Kessel"
// on an extension's page in a store ("install"), that extension to look
// over and add. `x`/`y`: where the extensions button is, for their popups.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { toast, escapeHtml, closeOwnPopup } from "./shared/api.js";
import { permissionLines, SOURCE_NAMES, applyExtensionTheme } from "./shared/extension-info.js";

const { invoke } = window.__TAURI__.core;
const info = window.__KESSEL_POPUP__ || {};
let token = null; // a package downloaded and waiting for "Add"

const content = () => document.getElementById("content");
const footer = () => document.getElementById("footer");

function close() {
  if (token) invoke("cancel_extension_install", { token }).catch(() => {});
  token = null;
  closeOwnPopup();
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function textEl(html, text) {
  const e = el(html);
  e.textContent = text;
  return e;
}

function iconOf(ext) {
  if (ext.icon) return Object.assign(document.createElement("img"), { src: ext.icon, alt: "" });
  return el(`<span class="glyph">${icon("puzzle", 14)}</span>`);
}

function footerButtons(buttons) {
  footer().replaceChildren(
    ...buttons.map(([label, run, primary]) => {
      const b = textEl(`<button class="btn sm ${primary ? "primary" : ""}"></button>`, label);
      b.addEventListener("click", run);
      return b;
    })
  );
}

// --- Your extensions ---------------------------------------------------------------

async function showList() {
  document.getElementById("heading").textContent = "Extensions";
  const all = (await invoke("list_extensions").catch(() => [])).filter((x) => !x.theme);
  const box = content();
  box.replaceChildren();
  if (!all.length) box.append(textEl(`<div class="waiting"></div>`, "No extensions yet."));
  for (const x of all) {
    const row = el(`<div class="ext"><div class="text"><div class="name"></div><div class="sub"></div></div></div>`);
    row.prepend(iconOf(x));
    row.querySelector(".name").textContent = x.name;
    row.querySelector(".sub").textContent = x.error ? `Couldn't run: ${x.error}` : !x.enabled ? "Off -- click to turn it on" : x.restart ? "Restart Kessel to finish its update" : x.popup ? "Click to open" : x.options ? "Click for its options" : "Runs on its own";
    if (!x.enabled) row.style.opacity = "0.6";
    const add = (name, title, run) => {
      const b = el(`<button title="${escapeHtml(title)}">${icon(name, 14)}</button>`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run();
        close();
      });
      row.append(b);
    };
    if (x.enabled && (x.popup || x.side_panel)) add("sidebar", "Open in the side panel", () => invoke("open_extension_side_panel", { id: x.id }).catch((err) => toast(String(err))));
    if (x.options) add("settings", "Options", () => invoke("open_extension_page", { id: x.id }).catch((err) => toast(String(err))));
    row.addEventListener("click", async () => {
      if (!x.enabled) {
        await invoke("set_extension_enabled", { id: x.id, enabled: true }).catch((err) => toast(String(err)));
        return showList();
      }
      invoke("open_extension_popup", { id: x.id, x: info.x ?? 600, y: info.y ?? 80 }).catch((err) => toast(String(err)));
    });
    box.append(row);
  }
  footerButtons([
    ["Manage", () => (invoke("open_singleton_tab", { route: "kessel://settings/extensions" }), close())],
    ["Get more", () => (invoke("open_url", { url: "https://chromewebstore.google.com/", how: "tab" }), close())],
  ]);
}

// --- Adding one from a store ----------------------------------------------------------

async function showInstall() {
  const store = SOURCE_NAMES[info.store] || "the store";
  document.getElementById("heading").textContent = "Add to Kessel";
  content().replaceChildren(el(`<div class="waiting"><div class="spinner"></div><div>Getting it from the ${escapeHtml(store)}…</div></div>`));
  footerButtons([["Cancel", close]]);
  let preview;
  try {
    preview = await invoke("preview_store_extension", { store: info.store, id: info.id });
  } catch (err) {
    content().replaceChildren(textEl(`<div class="waiting"></div>`, `Couldn't add it: ${err}`));
    footerButtons([["Close", close]]);
    return;
  }
  token = preview.token;
  const x = preview.extension;
  const card = el(`<div class="install"><div class="top"><div><h2></h2><div class="meta"></div></div></div><p class="desc"></p></div>`);
  card.querySelector(".top").prepend(iconOf(x));
  card.querySelector("h2").textContent = x.name;
  card.querySelector(".meta").textContent = `Version ${x.version} · ${store}${preview.have ? ` · you have ${preview.have}` : ""}`;
  card.querySelector(".desc").textContent = x.description || "";
  if (x.theme) {
    card.append(textEl(`<div class="note"></div>`, "A theme: Kessel takes on its colours, and your style keeps its shapes. Settings -> Appearance can put yours back."));
  } else {
    const lines = permissionLines(x);
    card.append(textEl(`<div class="asks"></div>`, lines.length ? "It will be able to:" : "It asks for nothing that reaches your data."));
    if (lines.length) {
      const ul = el(`<ul></ul>`);
      for (const l of lines) ul.append(textEl(`<li></li>`, l));
      card.append(ul);
    }
    card.append(textEl(`<div class="note"></div>`, "Settings -> Extensions can keep it to some sites, or switch it off. Extensions don't run in private windows."));
  }
  content().replaceChildren(card);
  footerButtons([
    ["Cancel", close],
    [
      preview.have ? "Update" : x.theme ? "Use theme" : "Add extension",
      async (e) => {
        e.target.disabled = true;
        try {
          const added = await invoke("confirm_extension_install", { token });
          token = null;
          if (added.theme) await applyExtensionTheme(added.id);
          const said = added.theme ? `Using the theme “${added.name}”.` : added.error ? `${added.name} was added, but couldn't run: ${added.error}` : `${added.name} is in Kessel -- it's under the puzzle button in the address bar.`;
          content().replaceChildren(el(`<div class="waiting">${icon(added.error ? "warning" : "check", 22)}<div></div></div>`));
          content().querySelector(".waiting div").textContent = said;
          footerButtons([["Done", close, true]]);
          setTimeout(close, added.error ? 6000 : 2200);
        } catch (err) {
          toast(`Couldn't add it: ${err}`);
          e.target.disabled = false;
        }
      },
      true,
    ],
  ]);
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  window.addEventListener("keydown", (e) => e.key === "Escape" && close());
  window.addEventListener("blur", close);
  if (info.mode === "install" && info.store && info.id) await showInstall();
  else await showList();
});
