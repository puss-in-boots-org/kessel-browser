import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { toast } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function render(downloads) {
  const list = document.getElementById("list");
  if (downloads.length === 0) {
    list.innerHTML = `<div class="empty">No downloads yet.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const d of downloads) {
    const row = document.createElement("div");
    row.className = "dl-row";
    const name = d.path.split(/[\\/]/).pop();
    row.innerHTML = `
      <span class="dl-icon">${icon(d.finished ? (d.success ? "check" : "warning") : "download", 15)}</span>
      <span class="dl-meta">
        <div class="dl-name"></div>
        <div class="dl-sub">${d.finished ? (d.success ? "Done" : "Failed") : "Downloading…"}</div>
      </span>`;
    row.querySelector(".dl-name").textContent = name;
    row.addEventListener("click", () => {
      if (d.finished && d.success) invoke("open_download", { path: d.path });
    });
    list.appendChild(row);
  }
}

async function refresh() {
  const downloads = await invoke("get_downloads").catch(() => []);
  render(downloads);
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  await refresh();

  document.getElementById("open-folder-btn").addEventListener("click", () => invoke("open_downloads_folder"));
  document.getElementById("clear-btn").addEventListener("click", async () => {
    await invoke("clear_downloads");
    render([]);
    toast("Downloads list cleared");
  });

  await listen("download-started", refresh);
  await listen("download-finished", refresh);
  await listen("downloads-changed", refresh);
});
