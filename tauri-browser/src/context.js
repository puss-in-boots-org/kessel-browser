// A right-click menu (see context.html). What to show comes in
// window.__KESSEL_POPUP__ = { items, opener, token }; a click sends
// "context-pick" { token, id } back to the opener, which does the rest.
//
// An item is { id, label, icon?, keys?, disabled?, danger?, checked?,
// swatch? }, "-" for a separator, or { header }.

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";

const { invoke } = window.__TAURI__.core;
const { emitTo } = window.__TAURI__.event;
let info = window.__KESSEL_POPUP__ || { items: [] };

const close = () => invoke("close_popup").catch(() => {});

function pick(id) {
  emitTo(info.opener, "context-pick", { token: info.token, id }).catch(() => {});
  close();
}

function build() {
  const menu = document.getElementById("menu");
  menu.innerHTML = "";
  menu.scrollTop = 0;
  for (const item of info.items || []) {
    if (item === "-") {
      menu.insertAdjacentHTML("beforeend", `<div class="sep" role="separator"></div>`);
      continue;
    }
    if (item.header) {
      const h = document.createElement("div");
      h.className = "header";
      h.textContent = item.header;
      menu.appendChild(h);
      continue;
    }
    const row = document.createElement("div");
    row.className = `item${item.disabled ? " disabled" : ""}${item.danger ? " danger" : ""}`;
    row.setAttribute("role", "menuitem");
    row.dataset.id = item.id;
    if (item.swatch) {
      const s = document.createElement("span");
      s.className = "swatch";
      s.style.background = item.swatch;
      row.appendChild(s);
    } else if (item.checked !== undefined) {
      const c = document.createElement("span");
      c.className = "check";
      c.innerHTML = item.checked ? icon("check", 14) : "";
      row.appendChild(c);
    } else {
      row.insertAdjacentHTML("beforeend", icon(item.icon || "dots", 14));
    }
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = item.label; // tab titles and names are the user's / sites'
    row.appendChild(label);
    if (item.keys) {
      const keys = document.createElement("span");
      keys.className = "keys";
      keys.textContent = item.keys;
      row.appendChild(keys);
    }
    row.addEventListener("click", () => pick(item.id));
    menu.appendChild(row);
  }
}

function wireKeys() {
  document.addEventListener("keydown", (e) => {
    const items = [...document.querySelectorAll(".item:not(.disabled)")];
    const at = items.findIndex((i) => i.classList.contains("focused"));
    const focus = (i) => {
      items.forEach((el) => el.classList.remove("focused"));
      const el = items[(i + items.length) % items.length];
      el.classList.add("focused");
      el.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") { e.preventDefault(); focus(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focus(at < 0 ? -1 : at - 1); }
    else if (e.key === "Home") { e.preventDefault(); focus(0); }
    else if (e.key === "End") { e.preventDefault(); focus(-1); }
    else if (e.key === "Enter" && at >= 0) { e.preventDefault(); pick(items[at].dataset.id); }
  });
}

// Closes when you click anywhere else -- unless the focus comes straight
// back: a right-click elsewhere while this is open shows the new menu right
// here (toggle_popup calls __kesselShowMenu).
let blurTimer = null;
window.addEventListener("blur", () => {
  clearTimeout(blurTimer);
  blurTimer = setTimeout(() => {
    if (!document.hasFocus()) close();
  }, 150);
});
window.addEventListener("focus", () => clearTimeout(blurTimer));

window.__kesselShowMenu = (next) => {
  clearTimeout(blurTimer);
  info = next || { items: [] };
  build();
};

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  watchCustomWallpaper(currentSettings);
  build();
  wireKeys();
});
