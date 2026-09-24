// Title bar of a torn-off pop-out window (see create_popout_internal in
// main.rs). Rust tells us which pop-out we belong to via
// window.__KESSEL_POPOUT__ before this runs; title/favicon/navigation updates
// arrive as the same events the toolbar gets for tabs, addressed to us.
import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { hostOf } from "./shared/api.js";
import { siteIcon, injectRefractionFilter, watchCustomWallpaper } from "./shared/glass.js";
import { avatarHtml } from "./shared/accounts.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const INTERNAL_TITLES = { "kessel://settings": "Settings", "kessel://passwords": "Passwords", "kessel://downloads": "Downloads", "kessel://newtab": "New Tab" };
const info = window.__KESSEL_POPOUT__ || { id: 0, url: "", title: "" };
let state = { url: info.url, title: info.title, favicon: null };
let onTop = false;

function render() {
  const title = state.title || INTERNAL_TITLES[state.url] || hostOf(state.url) || "Kessel";
  document.getElementById("title").textContent = title;
  document.getElementById("site").title = state.url;
  const holder = document.getElementById("site-icon");
  holder.replaceChildren(siteIcon(state.url, { label: title, knownFavicon: state.favicon }));
  // Signed in as another account than Main: its avatar leads the bar.
  const account = info.account;
  if (account) {
    holder.insertAdjacentHTML("afterbegin", avatarHtml(account, 18));
    document.getElementById("site").title = `${account.name} · ${state.url}`;
  }
  appWindow.setTitle(account ? `${title} (${account.name})` : title).catch(() => {});
}

function paintButtons() {
  const pin = document.getElementById("pop-pin");
  pin.innerHTML = icon(onTop ? "pinFilled" : "pin", 14);
  pin.classList.toggle("on", onTop);
  pin.title = onTop ? "Stop keeping on top" : "Keep on top";
  document.getElementById("pop-dock").innerHTML = icon("arrowRight", 14);
  document.getElementById("pop-min").innerHTML = icon("winMin", 13);
  document.getElementById("pop-max").innerHTML = icon("winMax", 12);
  document.getElementById("pop-close").innerHTML = icon("close", 13);
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  injectRefractionFilter();
  watchCustomWallpaper(currentSettings);
  paintButtons();
  render();

  document.getElementById("pop-pin").addEventListener("click", async () => {
    onTop = !onTop;
    await appWindow.setAlwaysOnTop(onTop).catch(() => (onTop = !onTop));
    paintButtons();
  });
  document.getElementById("pop-dock").addEventListener("click", () => invoke("dock_popout", { id: info.id }));
  document.getElementById("pop-min").addEventListener("click", () => appWindow.minimize());
  document.getElementById("pop-max").addEventListener("click", () => appWindow.toggleMaximize());
  document.getElementById("pop-close").addEventListener("click", () => appWindow.close());

  // The whole bar drags the window, except its buttons.
  document.getElementById("bar").addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    if (e.detail === 2) appWindow.toggleMaximize();
    else appWindow.startDragging();
  });

  await listen("tab-title-changed", (e) => {
    if (e.payload.id !== info.id || !e.payload.title) return;
    state.title = e.payload.title;
    render();
  });
  await listen("tab-favicon-changed", (e) => {
    if (e.payload.id !== info.id) return;
    state.favicon = e.payload.url;
    render();
  });
  await listen("popout-navigated", (e) => {
    state = { url: e.payload, title: "", favicon: null };
    render();
  });
  // Same page, new address (pushState) -- keeps its title and icon.
  await listen("tab-url-changed", (e) => {
    if (e.payload.id !== info.id || e.payload.url === state.url) return;
    state.url = e.payload.url;
    render();
  });
});
