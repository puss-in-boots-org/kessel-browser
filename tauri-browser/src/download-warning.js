// The risky-download prompt (download-warning.html): the download waits
// until you keep or discard it (security.rs). It stays up until you choose.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { closeOwnPopup } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const info = window.__KESSEL_POPUP__ || {};
const $ = (id) => document.getElementById(id);

async function decide(keep) {
  $("keep").disabled = $("discard").disabled = true;
  await invoke("resolve_download", { id: info.id, keep }).catch(() => {});
  closeOwnPopup();
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  $("glyph").innerHTML = icon("warning", 16);
  $("title").textContent = info.kind === "dangerous" ? "This file may be dangerous" : "This file could harm your PC";
  $("file").textContent = info.file || "";
  $("detail").textContent = info.detail || "";
  $("from").textContent = info.url ? `From ${info.url}` : "";
  $("keep").addEventListener("click", () => decide(true));
  $("discard").addEventListener("click", () => decide(false));
  $("discard").focus();
  document.addEventListener("keydown", (e) => e.key === "Escape" && decide(false));
});
