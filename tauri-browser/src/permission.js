// A site's request (permission.html, from permissions.rs): allow or block,
// and whether to keep the answer for the site (never from a private
// window). It stays up until you answer; Esc blocks it this once.

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { closeOwnPopup } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const info = window.__KESSEL_POPUP__ || {};
const $ = (id) => document.getElementById(id);

const GLYPHS = { camera: "eye", microphone: "volume", location: "globe", notifications: "bolt", clipboard: "copy", downloads: "download", files: "folder" };

async function answer(allow) {
  $("allow").disabled = $("block").disabled = true;
  await invoke("resolve_permission", { n: info.n, allow, remember: !info.private && $("remember").checked }).catch(() => {});
  closeOwnPopup();
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  $("glyph").innerHTML = icon(GLYPHS[info.kind] || "shield", 16);
  const title = $("title");
  const site = document.createElement("b");
  site.textContent = info.site || "This page";
  title.append(site, ` wants to ${info.label || "do something"}`);
  $("remember").checked = currentSettings()?.features?.permission_remember !== false;
  $("remember-row").hidden = !!info.private;
  $("allow").addEventListener("click", () => answer(true));
  $("block").addEventListener("click", () => answer(false));
  $("block").focus();
  // Answered some other way (unanswered for two minutes: blocked).
  window.__TAURI__.event.listen("permission-resolved", (event) => {
    if (event.payload?.n === info.n) closeOwnPopup();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("remember").checked = false;
      answer(false);
    }
  });
});
