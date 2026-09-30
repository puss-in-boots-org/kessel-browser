// The downloads list (downloads.html, in the side panel and kessel://downloads):
// what's downloading -- how far, paused, cancelled -- and what's done;
// search it, sort it, open a file or show it in its folder, pause, resume,
// cancel or try a failed one again. The live part is downloads.rs.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { toast, hostOf, formatBytes, formatRelativeTime } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let downloads = [];
const live = new Map(); // id -> { received, total, state, can_resume }

const nameOf = (d) => d.path.split(/[\\/]/).pop();

function sorted(list) {
  const q = document.getElementById("q").value.trim().toLowerCase();
  const out = list.filter((d) => !q || `${nameOf(d)} ${d.url}`.toLowerCase().includes(q));
  switch (document.getElementById("sort").value) {
    case "old": return out.sort((a, b) => a.started_at - b.started_at);
    case "name": return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    case "site": return out.sort((a, b) => hostOf(a.url).localeCompare(hostOf(b.url)) || b.started_at - a.started_at);
    default: return out.sort((a, b) => b.started_at - a.started_at);
  }
}

function status(d) {
  const l = live.get(d.id);
  // Cancelled is over too, but not a failure.
  if (l?.state === "cancelled") return "Cancelled";
  if (d.finished) return d.success ? `Done · ${hostOf(d.url)} · ${formatRelativeTime(d.started_at)}` : "Failed";
  if (!l) return "Downloading…";
  const size = l.total > 0 ? `${formatBytes(l.received)} of ${formatBytes(l.total)}` : formatBytes(l.received);
  if (l.state === "paused") return `Paused · ${size}`;
  if (l.state === "cancelled") return "Cancelled";
  if (l.state === "interrupted") return l.can_resume ? `Stopped · ${size}` : "Failed";
  return size;
}

function button(name, title, action) {
  const b = document.createElement("button");
  b.title = title;
  b.innerHTML = icon(name, 14);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    action();
  });
  return b;
}

function control(d, action) {
  invoke("download_control", { id: d.id, action }).catch((err) => toast(String(err)));
}

function render() {
  const list = document.getElementById("list");
  const shown = sorted([...downloads]);
  if (!shown.length) {
    list.innerHTML = `<div class="empty">${downloads.length ? "No download matches." : "No downloads yet."}</div>`;
    return;
  }
  list.innerHTML = "";
  for (const d of shown) {
    const l = live.get(d.id);
    const running = !d.finished && (!l || !["cancelled"].includes(l.state));
    const row = document.createElement("div");
    row.className = `dl-row${running ? " running" : ""}`;
    row.innerHTML = `
      <span class="dl-icon">${icon(d.finished ? (d.success ? "check" : "warning") : "download", 15)}</span>
      <span class="dl-meta"><div class="dl-name"></div><div class="dl-sub"></div></span>
      <span class="actions"></span>`;
    row.querySelector(".dl-name").textContent = nameOf(d);
    row.title = d.url;
    row.querySelector(".dl-sub").textContent = status(d);
    if (running) {
      const bar = document.createElement("div");
      bar.className = `bar${l?.state === "paused" ? " paused" : ""}${!l || !(l.total > 0) ? " unknown" : ""}`;
      bar.innerHTML = "<i></i>";
      if (l?.total > 0) bar.firstChild.style.width = `${Math.min(100, (l.received / l.total) * 100).toFixed(1)}%`;
      row.querySelector(".dl-meta").appendChild(bar);
    }
    const actions = row.querySelector(".actions");
    if (running && l?.state === "progress") actions.append(button("pause", "Pause", () => control(d, "pause")));
    if (running && (l?.state === "paused" || (l?.state === "interrupted" && l.can_resume))) actions.append(button("play", "Resume", () => control(d, "resume")));
    if (running) actions.append(button("close", "Cancel", () => control(d, "cancel")));
    if ((d.finished && !d.success) || l?.state === "cancelled" || (l?.state === "interrupted" && !l.can_resume)) {
      actions.append(button("refresh", "Try again", () => invoke("open_url", { url: d.url, how: "tab" }).catch((err) => toast(String(err)))));
    }
    if (d.finished && d.success) actions.append(button("folder", "Show in folder", () => invoke("show_download", { path: d.path }).catch((err) => toast(String(err)))));
    row.addEventListener("click", () => {
      if (d.finished && d.success) invoke("open_download", { path: d.path }).catch((err) => toast(String(err)));
    });
    list.appendChild(row);
  }
}

async function refresh() {
  downloads = await invoke("get_downloads").catch(() => []);
  render();
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  await refresh();

  document.getElementById("open-folder-btn").addEventListener("click", () => invoke("open_downloads_folder").catch((err) => toast(String(err))));
  document.getElementById("clear-btn").addEventListener("click", async () => {
    await invoke("clear_downloads");
    downloads = [];
    render();
    toast("Downloads list cleared");
  });
  document.getElementById("q").addEventListener("input", render);
  document.getElementById("sort").addEventListener("change", render);

  await listen("download-started", refresh);
  await listen("download-finished", refresh);
  await listen("downloads-changed", refresh);
  await listen("download-progress", (event) => {
    const p = event.payload || {};
    live.set(p.id, p);
    render();
  });
});
