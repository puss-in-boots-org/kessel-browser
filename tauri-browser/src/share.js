// The share popup (see share.html): the page's QR code, and copying or
// sending its link.

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";

const { invoke } = window.__TAURI__.core;
const info = window.__KESSEL_POPUP__ || { url: "", title: "" };
const $ = (id) => document.getElementById(id);

const close = () => invoke("close_popup").catch(() => {});

function done(message) {
  const el = $("done");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(close, 700);
}

// The QR code as a PNG, for the clipboard.
async function qrPng() {
  const svg = $("qr").querySelector("svg");
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, 512, 512);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function button(id, iconName, label, action) {
  const b = $(id);
  b.innerHTML = `${icon(iconName, 14)}<span></span>`;
  b.querySelector("span").textContent = label;
  b.addEventListener("click", async () => {
    try {
      await action();
    } catch (err) {
      done(`Couldn't: ${err?.message || err}`);
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  watchCustomWallpaper(currentSettings);
  $("title").textContent = info.title || info.url;
  $("url").textContent = info.url;
  // The SVG comes from Kessel itself (qrcode, see suggest.rs), not the page.
  $("qr").innerHTML = await invoke("qr_code", { text: info.url }).catch(() => "");

  button("copy-link", "link", "Copy link", async () => {
    await navigator.clipboard.writeText(info.url);
    done("Link copied");
  });
  button("copy-qr", "qr", "Copy QR code", async () => {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": await qrPng() })]);
    done("QR code copied");
  });
  button("copy-markdown", "code", "Copy as Markdown", async () => {
    const title = (info.title || info.url).replace(/[[\]]/g, "\\$&");
    await navigator.clipboard.writeText(`[${title}](${info.url})`);
    done("Markdown link copied");
  });
  button("share", "share", "Share…", async () => {
    await invoke("share_page", { url: info.url, title: info.title });
    close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  window.addEventListener("blur", () => setTimeout(() => !document.hasFocus() && close(), 150));
});
