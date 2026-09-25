// A hovered tab's card (hovercard.html). What to show comes first in
// window.__KESSEL_POPUP__, then (the same card, moved to the next tab) in
// window.__kesselHoverCard(info) -- see showHoverCard in main.js:
// { title, host, secure, state ("sleeping" | "frozen" | null), audible,
//   muted, pinned, attention, group { name, color }, account { name, color },
//   showMemory, memory (bytes), cpu (%), heavy, preview, thumbnail (a data:
//   URL, "none", or null while it's being taken) }.

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";
import { formatBytes, escapeHtml as text } from "./shared/api.js";

function pill(html) {
  return `<span class="pill">${html}</span>`;
}

function show(info) {
  if (!info) return;
  document.getElementById("title").textContent = info.title || "";
  document.getElementById("host").innerHTML = `${info.secure ? `<span class="secure">${icon("lock", 11)}</span>` : ""}<span>${text(info.host || "")}</span>`;

  const status = [];
  if (info.state === "sleeping") status.push(pill(`${icon("moon2", 12)}Sleeping to save memory -- click to wake it up`));
  if (info.state === "frozen") status.push(pill(`${icon("snowflake", 12)}Paused in the background`));
  if (info.audible && !info.muted) status.push(pill(`${icon("volume", 12)}Playing sound`));
  if (info.muted) status.push(pill(`${icon("volumeOff", 12)}Muted`));
  if (info.attention) status.push(pill(`<span class="dot" style="background:var(--accent)"></span>Changed while you were away`));
  if (info.group) status.push(pill(`<span class="dot" style="background:${text(info.group.color)}"></span>${text(info.group.name || "Group")}`));
  if (info.account) status.push(pill(`<span class="dot" style="background:${text(info.account.color)}"></span>${text(info.account.name)}`));
  const statusEl = document.getElementById("status");
  statusEl.innerHTML = status.join("");
  statusEl.hidden = !status.length;

  const memory = document.getElementById("memory");
  memory.hidden = !info.showMemory;
  memory.classList.toggle("heavy", !!info.heavy);
  if (info.showMemory) {
    const parts = [info.memory != null ? `Memory: ${formatBytes(info.memory)}` : "Memory: measuring..."];
    if (info.cpu != null) parts.push(`CPU: ${Math.round(info.cpu)}%`);
    if (info.heavy) parts.push("using a lot");
    memory.innerHTML = `${icon("activity", 12)}<span>${parts.join(" · ")}</span>`;
  }

  const preview = document.getElementById("preview");
  preview.hidden = !info.preview;
  if (info.preview) {
    if (info.thumbnail && info.thumbnail !== "none") {
      const img = new Image();
      img.alt = "";
      img.src = info.thumbnail;
      preview.replaceChildren(img);
    } else {
      preview.innerHTML = `<span class="none">${info.thumbnail === "none" ? "No preview yet -- it's taken when you leave the tab" : ""}</span>`;
    }
  }
}

window.__kesselHoverCard = show;

window.addEventListener("DOMContentLoaded", async () => {
  show(window.__KESSEL_POPUP__);
  await initTheme();
  watchCustomWallpaper(currentSettings);
});
