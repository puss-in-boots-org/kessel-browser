// The side panel's glass frame (see open_side_panel_webviews in main.rs).
// Rust tells us what the panel shows via window.__KESSEL_PANEL__ before this
// runs; the page's own title/favicon reports (id 0) and navigations are
// forwarded to this webview only.
import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { hostOf } from "./shared/api.js";
import { siteIcon, alignToChrome, injectRefractionFilter, watchCustomWallpaper } from "./shared/glass.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const info = window.__KESSEL_PANEL__ || { kind: "", url: "", title: "" };
const BUILT_IN = { downloads: "download", passwords: "key", settings: "settings" };
let state = { url: info.url, title: info.title, favicon: null };

function render() {
  const title = state.title || hostOf(state.url) || "Side panel";
  document.getElementById("title").textContent = title;
  document.getElementById("site").title = state.url.startsWith("kessel://") ? title : state.url;
  const holder = document.getElementById("site-icon");
  const builtIn = BUILT_IN[info.kind];
  if (builtIn) {
    holder.innerHTML = `<span class="panel-icon">${icon(builtIn, 13)}</span>`;
  } else {
    holder.replaceChildren(siteIcon(state.url, { label: title, knownFavicon: state.favicon }));
  }
}

// --- Resize grip ---------------------------------------------------------------
// Starts the drag; the page inside the panel and the active tab continue it
// whenever the cursor crosses into them (they listen for "side-panel-drag").
// Every participant reports the pointer's x relative to the panel's left
// edge -- which for this frame is simply clientX.
function wireGrip() {
  const grip = document.getElementById("grip");
  let dragging = false;
  const finish = (x) => {
    dragging = false;
    grip.classList.remove("dragging");
    invoke("commit_side_panel_width", { width: x }).catch(() => {});
    invoke("notify_side_panel_drag", { dragging: false }).catch(() => {});
  };
  grip.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    grip.classList.add("dragging");
    invoke("notify_side_panel_drag", { dragging: true }).catch(() => {});
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    if (!(e.buttons & 1)) return finish(e.clientX);
    invoke("resize_side_panel_live", { width: e.clientX }).catch(() => {});
  });
  document.addEventListener("mouseup", (e) => {
    if (dragging) finish(e.clientX);
  });
  // Released over the page or the tab: they already committed it.
  listen("side-panel-drag", (e) => {
    if (!e.payload) {
      dragging = false;
      grip.classList.remove("dragging");
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  alignToChrome(document.getElementById("wallpaper"));
  await initTheme();
  injectRefractionFilter();
  watchCustomWallpaper(currentSettings);

  document.getElementById("panel-to-tab").innerHTML = icon("arrowRight", 14);
  document.getElementById("panel-pop-out").innerHTML = icon("popOut", 14);
  document.getElementById("panel-close").innerHTML = icon("close", 13);
  document.getElementById("panel-to-tab").addEventListener("click", () => invoke("side_panel_to_tab").catch(() => {}));
  document.getElementById("panel-pop-out").addEventListener("click", () => invoke("side_panel_pop_out").catch(() => {}));
  document.getElementById("panel-close").addEventListener("click", () => invoke("close_side_panel").catch(() => {}));
  // Built-in pages can't be popped out into a window (they're Kessel's own).
  if (BUILT_IN[info.kind]) document.getElementById("panel-pop-out").hidden = true;

  wireGrip();
  render();

  await listen("tab-title-changed", (e) => {
    if (e.payload.id !== 0 || !e.payload.title || BUILT_IN[info.kind]) return;
    state.title = e.payload.title;
    render();
  });
  await listen("tab-favicon-changed", (e) => {
    if (e.payload.id !== 0) return;
    state.favicon = e.payload.url;
    render();
  });
  await listen("panel-navigated", (e) => {
    state = { url: e.payload, title: "", favicon: null };
    render();
  });
  // Same page, new address (pushState) -- keeps its title and icon.
  await listen("tab-url-changed", (e) => {
    if (e.payload.id !== 0 || BUILT_IN[info.kind] || e.payload.url === state.url) return;
    state.url = e.payload.url;
    render();
  });
});
