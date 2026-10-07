// The suggestions under a form's field (forms.html, forms.rs): your saved
// addresses or cards. The page keeps the keyboard and passes on Down, Up
// and Enter ("forms-key"); a press of the mouse picks one at once -- before
// the field's losing the focus closes the list.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { listenHere } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const info = window.__KESSEL_POPUP__ || { kind: "address", items: [] };
const items = (info.items || []).slice(0, 6);
let selected = -1;

function render() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  items.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = `item${i === selected ? " on" : ""}`;
    row.dataset.id = item.id;
    row.innerHTML = `${icon(info.kind === "card" ? "card" : "user", 15)}<span class="label"></span>`;
    row.querySelector(".label").textContent = item.label;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pick(i);
    });
    list.appendChild(row);
  });
}

function pick(i) {
  const item = items[i];
  if (item) invoke("forms_pick", { id: item.id }).catch(() => {});
}

listenHere("forms-key", (event) => {
  const key = event.payload;
  if (key === "ArrowDown") selected = (selected + 1) % items.length;
  else if (key === "ArrowUp") selected = (selected - 1 + items.length) % items.length;
  else if (key === "Enter" && selected >= 0) return pick(selected);
  render();
});

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  const manage = document.getElementById("manage");
  manage.textContent = info.kind === "card" ? "Manage cards…" : "Manage addresses…";
  manage.addEventListener("mousedown", (e) => {
    e.preventDefault();
    invoke("open_singleton_tab", { route: "kessel://settings/autofill" }).catch(() => {});
  });
  render();
});
