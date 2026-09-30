// Command palette (F2, palette.html): every command Kessel has -- the same
// list as Settings -> Keyboard shortcuts -- filtered as you type (every word
// must match its name or category). Enter runs it in the window it was
// opened from; the ones you ran lately come first. Settings -> Page tools
// decides how many recent ones it remembers.

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";
import { escapeHtml, closeOwnPopup } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;

const RECENT_KEY = "kessel-palette-recent";
let commands = [];
let rows = [];
let focused = 0;

function recent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function remember(id) {
  const keep = Math.max(0, Math.min(20, Number(currentSettings()?.features?.palette_recent ?? 5)));
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter((r) => r !== id)].slice(0, keep)));
  } catch {}
}

function highlight(text, terms) {
  let html = escapeHtml(text);
  for (const w of terms) {
    const re = new RegExp(escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

function render() {
  const terms = document.getElementById("q").value.toLowerCase().split(/\s+/).filter(Boolean);
  const found = commands.filter((c) => c.id !== "command-palette" && terms.every((w) => `${c.label} ${c.category}`.toLowerCase().includes(w)));
  const lately = terms.length ? [] : recent().map((id) => found.find((c) => c.id === id)).filter(Boolean);
  const rest = found.filter((c) => !lately.includes(c));
  rows = [];
  let html = "";
  const section = (title, list) => {
    if (!list.length) return;
    html += `<div class="section">${escapeHtml(title)}</div>`;
    for (const c of list) {
      const i = rows.push(c) - 1;
      html += `<div class="row" data-i="${i}" role="option">
        <div class="main"><div class="title">${highlight(c.label, terms)}</div><div class="sub">${highlight(c.category, terms)}</div></div>
        <span class="keys">${(c.keys || []).slice(0, 2).map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join("")}</span>
      </div>`;
    }
  };
  section("Recently used", lately);
  section(terms.length ? "Commands" : "All commands", rest);
  document.getElementById("list").innerHTML = html || `<div id="empty">No command matches</div>`;
  document.getElementById("count").textContent = `${found.length}`;
  focused = Math.min(focused, Math.max(0, rows.length - 1));
  markFocused();
}

function markFocused() {
  document.querySelectorAll(".row").forEach((r) => r.classList.toggle("focused", Number(r.dataset.i) === focused));
  document.querySelector(`.row[data-i="${focused}"]`)?.scrollIntoView({ block: "nearest" });
}

async function run(command) {
  if (!command) return;
  remember(command.id);
  await invoke("run_command", { id: command.id }).catch(() => {});
  closeOwnPopup();
}

function wire() {
  const q = document.getElementById("q");
  q.addEventListener("input", () => {
    focused = 0;
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeOwnPopup();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      focused = Math.min(rows.length - 1, focused + 1);
      markFocused();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focused = Math.max(0, focused - 1);
      markFocused();
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(rows[focused]);
    }
  });
  const list = document.getElementById("list");
  list.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) run(rows[Number(row.dataset.i)]);
  });
  list.addEventListener("mousemove", (e) => {
    const row = e.target.closest(".row");
    if (row && Number(row.dataset.i) !== focused) {
      focused = Number(row.dataset.i);
      markFocused();
    }
  });
  window.addEventListener("blur", () => setTimeout(() => !document.hasFocus() && closeOwnPopup(), 150));
}

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("search-icon").innerHTML = icon("search", 15);
  wire();
  document.getElementById("q").focus();
  await initTheme();
  watchCustomWallpaper(currentSettings);
  commands = await invoke("get_commands").catch(() => []);
  render();
});
