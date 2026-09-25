// The Shields popup for one tab (Rust passes its id in
// window.__KESSEL_SHIELDS_TAB__). Per-site switch = the site's domain on or
// off the allow list; the rest are global Shields settings.
import { icon } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";
import { listenHere, closeOwnPopup } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
// Only this window's stats -- each window has its own Shields popup.
const listen = listenHere;
const tabId = window.__KESSEL_SHIELDS_TAB__ ?? 0;
let info = null;

const close = () => closeOwnPopup("close_shields_popup");

function setSwitch(id, on) {
  const el = document.getElementById(id);
  el.classList.toggle("on", !!on);
  el.setAttribute("aria-checked", String(!!on));
}

function renderStats(stats) {
  document.getElementById("n-blocked").textContent = stats?.blocked ?? 0;
  document.getElementById("n-https").textContent = stats?.https_upgrades ?? 0;
  document.getElementById("n-params").textContent = stats?.params_stripped ?? 0;
}

function render() {
  const up = info.global && info.site_enabled;
  document.getElementById("main").classList.toggle("off", !up);
  document.getElementById("badge-icon").innerHTML = icon(up ? "shieldCheck" : "shieldOff", 18);
  document.getElementById("host").textContent = info.host || "This page";
  setSwitch("site-switch", info.site_enabled);
  document.getElementById("site-switch").disabled = !info.global || !info.host;
  document.getElementById("state").textContent = !info.global
    ? "Shields are off for all sites. Turn on “Block ads & trackers” below."
    : info.site_enabled
      ? "Shields are UP: ads, trackers and fingerprinting are blocked on this site."
      : "Shields are DOWN for this site. Nothing is blocked here.";
  renderStats(info.stats);
  setSwitch("g-adblock", info.global);
  setSwitch("g-https", info.https_upgrade);
  setSwitch("g-strip", info.strip_tracking);
  setSwitch("g-fp", info.fingerprinting);
  document.getElementById("lists-note").textContent = info.lists_loaded ? "" : "Downloading filter lists…";
}

async function refresh() {
  info = await invoke("shields_tab_info", { id: tabId });
  render();
}

function wireGlobal(id, key) {
  document.getElementById(id).addEventListener("click", async () => {
    await saveSettings({ [key]: !currentSettings()?.[key] });
    await refresh();
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  watchCustomWallpaper(currentSettings);
  await refresh();

  document.getElementById("site-switch").addEventListener("click", async () => {
    if (!info?.host) return;
    await invoke("shields_set_site", { id: tabId, host: info.host, enabled: !info.site_enabled }).catch(() => {});
    await refresh();
  });
  wireGlobal("g-adblock", "adblock_enabled");
  wireGlobal("g-https", "shields_https_upgrade");
  wireGlobal("g-strip", "shields_strip_tracking");
  wireGlobal("g-fp", "shields_fingerprinting");
  document.getElementById("open-settings").addEventListener("click", async () => {
    await invoke("toggle_side_panel", { kind: "settings", url: "kessel://settings" }).catch(() => {});
    close();
  });

  await listen("shields-stats", (e) => {
    if (e.payload.id === tabId) renderStats(e.payload.stats);
  });
  await listen("shields-lists-changed", refresh);

  // A popover: clicking anywhere else (which moves focus out of this
  // webview) or pressing Escape closes it.
  window.addEventListener("blur", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
});
