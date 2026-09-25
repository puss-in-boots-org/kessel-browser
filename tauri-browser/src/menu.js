// The Kessel menu (the address bar's ⋮ button, Alt+F, Alt+E, F10). Every
// item is a browser command (see src-tauri/src/commands.rs): clicking it
// runs the command in this window, as if its shortcut had been pressed, and
// shows that shortcut. Keyboard: arrows move, Enter runs, Escape closes.
import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";
import { keyLabel } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const info = window.__KESSEL_POPUP__ || {};

// [command id, icon] -- or "-" for a separator, "zoom" for the zoom row.
const LAYOUT = [
  ["new-tab", "plus"],
  ["new-window", "window"],
  ["new-private-window", "incognito"],
  "-",
  ["history", "history"],
  ["downloads", "download"],
  ["bookmark", "star"],
  ["bookmark-all-tabs", "bookmark"],
  ["toggle-bookmarks-bar", "bookmark"],
  ["passwords", "key"],
  "-",
  "zoom",
  "-",
  ["print", "print"],
  ["save-page", "save"],
  ["find", "find"],
  ["open-file", "file"],
  "-",
  ["reopen-closed-tab", "refresh"],
  ["reopen-closed-window", "window"],
  "-",
  ["devtools", "code"],
  ["view-source", "code"],
  ["task-manager", "activity"],
  ["clear-browsing-data", "broom"],
  "-",
  ["settings", "settings"],
  ["help", "help"],
  ["exit", "power"],
];

// Labels that read better in a menu than the command's own.
const MENU_LABELS = {
  "reopen-closed-tab": "Reopen closed tab",
  "toggle-bookmarks-bar": "Show bookmarks bar",
  "print": "Print…",
  "save-page": "Save page as…",
  "find": "Find…",
  "open-file": "Open file…",
  "clear-browsing-data": "Clear browsing data…",
  "exit": "Exit",
};

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];
let zoom = info.zoom ?? 1;

const close = () => invoke("close_popup").catch(() => {});

async function run(id) {
  if (id === "exit") {
    await invoke("quit_app");
    return;
  }
  await invoke("run_command", { id }).catch(() => {});
  close();
}

function stepZoom(direction) {
  const current = Math.round(zoom * 100) / 100;
  zoom = direction > 0
    ? ZOOM_LEVELS.find((z) => z > current + 0.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
    : [...ZOOM_LEVELS].reverse().find((z) => z < current - 0.001) ?? ZOOM_LEVELS[0];
  document.getElementById("zoom-value").textContent = `${Math.round(zoom * 100)}%`;
}

function build(commands) {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const menu = document.getElementById("menu");
  menu.innerHTML = "";
  for (const entry of LAYOUT) {
    if (entry === "-") {
      menu.insertAdjacentHTML("beforeend", `<div class="sep" role="separator"></div>`);
      continue;
    }
    if (entry === "zoom") {
      const row = document.createElement("div");
      row.className = "zoom";
      row.innerHTML = `<span class="label">Zoom</span>
        <button id="zoom-out" title="Zoom out (Ctrl+-)">${icon("minus", 14)}</button>
        <output id="zoom-value">${Math.round(zoom * 100)}%</output>
        <button id="zoom-in" title="Zoom in (Ctrl++)">${icon("plus", 14)}</button>
        <button id="zoom-full" title="Full screen (F11)">${icon("expand", 14)}</button>`;
      row.querySelector("#zoom-out").addEventListener("click", () => {
        stepZoom(-1);
        invoke("run_command", { id: "zoom-out" }).catch(() => {});
      });
      row.querySelector("#zoom-in").addEventListener("click", () => {
        stepZoom(1);
        invoke("run_command", { id: "zoom-in" }).catch(() => {});
      });
      row.querySelector("#zoom-full").addEventListener("click", () => run("fullscreen"));
      row.querySelector("#zoom-value").addEventListener("click", () => {
        zoom = currentSettings()?.default_zoom ?? 1;
        document.getElementById("zoom-value").textContent = `${Math.round(zoom * 100)}%`;
        invoke("run_command", { id: "zoom-reset" }).catch(() => {});
      });
      menu.appendChild(row);
      continue;
    }
    const [id, iconName] = entry;
    const command = byId.get(id);
    if (!command && id !== "exit") continue;
    const item = document.createElement("div");
    item.className = "item";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.dataset.command = id;
    let label = MENU_LABELS[id] || command?.label || id;
    if (id === "toggle-bookmarks-bar" && currentSettings()?.bookmarks_bar !== false) label = "Hide bookmarks bar";
    item.innerHTML = `${icon(iconName, 15)}<span class="label"></span><span class="keys"></span>`;
    item.querySelector(".label").textContent = label;
    item.querySelector(".keys").textContent = keyLabel(command?.keys?.[0] || "");
    if ((id === "bookmark" || id === "view-source") && !info.web) item.classList.add("disabled");
    item.addEventListener("click", () => run(id));
    menu.appendChild(item);
  }
}

// Arrow keys move through the items, Enter runs one.
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
    else if (e.key === "Enter" && at >= 0) { e.preventDefault(); run(items[at].dataset.command); }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  watchCustomWallpaper(currentSettings);
  build(await invoke("get_commands").catch(() => []));
  wireKeys();
  // A popover: clicking anywhere else (which moves focus out of this
  // webview) closes it.
  window.addEventListener("blur", close);
});
