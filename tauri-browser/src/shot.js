// kessel://shot?k=<key> (shot.html): the screenshot you just took
// (tools.rs keeps it under `k`), to draw on before you save or copy it.
// Everything drawn is a list of steps over the picture, so undo and redo
// are just moving along the list. Your last tool, colour and thickness are
// remembered (settings.features.shot_editor).

import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { toast } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const svg = (d) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TOOLS = [
  { id: "pen", title: "Pen", icon: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>') },
  { id: "marker", title: "Highlighter", icon: svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>') },
  { id: "arrow", title: "Arrow", icon: svg('<path d="M5 19 19 5"/><path d="M9 5h10v10"/>') },
  { id: "rect", title: "Box", icon: svg('<rect x="4" y="6" width="16" height="12" rx="1.5"/>') },
  { id: "text", title: "Text", icon: svg('<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>') },
  { id: "blur", title: "Blur (hide something)", icon: svg('<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/>') },
  { id: "crop", title: "Crop", icon: svg('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>') },
];
const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#ffffff", "#111111"];

const canvas = $("canvas");
const ctx = canvas.getContext("2d");
let base = null; // the screenshot, as an image
let steps = [];
let undone = [];
let draft = null; // the step being drawn
let mime = "image/png";

function prefs() {
  return { tool: "arrow", color: "#ff3b30", size: 5, ...(currentSettings()?.features?.shot_editor || {}) };
}
let tool, color, size;
let prefsTimer = null;
function rememberPrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const features = currentSettings()?.features || {};
    saveSettings({ features: { ...features, shot_editor: { tool, color, size } } }).catch(() => {});
  }, 600);
}

// The picture's area left after the crops.
function view() {
  let v = { x: 0, y: 0, w: base.naturalWidth, h: base.naturalHeight };
  for (const s of steps) if (s.kind === "crop") v = s.rect;
  return v;
}

function normRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function drawStep(c, s) {
  c.save();
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.lineWidth = s.size;
  switch (s.kind) {
    case "pen":
    case "marker": {
      if (s.kind === "marker") {
        c.globalAlpha = 0.35;
        c.lineWidth = s.size * 4;
        c.lineCap = "butt";
      }
      c.beginPath();
      s.points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
      break;
    }
    case "arrow": {
      const { a, b } = s;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(12, s.size * 4);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x - Math.cos(angle) * head * 0.6, b.y - Math.sin(angle) * head * 0.6);
      c.stroke();
      c.beginPath();
      c.moveTo(b.x, b.y);
      c.lineTo(b.x - head * Math.cos(angle - 0.45), b.y - head * Math.sin(angle - 0.45));
      c.lineTo(b.x - head * Math.cos(angle + 0.45), b.y - head * Math.sin(angle + 0.45));
      c.closePath();
      c.fill();
      break;
    }
    case "rect": {
      const r = s.rect;
      c.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case "text": {
      c.font = `600 ${Math.round(s.size * 4 + 8)}px system-ui, "Segoe UI", sans-serif`;
      c.textBaseline = "top";
      // A thin outline in the opposite shade, so it reads on anything.
      c.lineWidth = Math.max(2, s.size / 2);
      c.strokeStyle = s.color === "#111111" ? "#ffffff" : "rgba(0,0,0,.55)";
      s.text.split("\n").forEach((line, i) => {
        const y = s.at.y + i * (s.size * 4 + 12);
        c.strokeText(line, s.at.x, y);
        c.fillText(line, s.at.x, y);
      });
      break;
    }
    case "blur": {
      // Big pixels: what's under it can't be read back.
      const r = s.rect;
      if (r.w < 2 || r.h < 2) break;
      const cell = Math.max(8, Math.round(Math.min(r.w, r.h) / 12));
      const small = new OffscreenCanvas(Math.max(1, Math.round(r.w / cell)), Math.max(1, Math.round(r.h / cell)));
      const sc = small.getContext("2d");
      sc.drawImage(c.canvas, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
      c.imageSmoothingEnabled = false;
      c.drawImage(small, 0, 0, small.width, small.height, r.x, r.y, r.w, r.h);
      break;
    }
    case "crop-draft": {
      const r = s.rect;
      c.fillStyle = "rgba(0,0,0,.45)";
      c.fillRect(0, 0, c.canvas.width, r.y);
      c.fillRect(0, r.y + r.h, c.canvas.width, c.canvas.height);
      c.fillRect(0, r.y, r.x, r.h);
      c.fillRect(r.x + r.w, r.y, c.canvas.width, r.h);
      c.setLineDash([6, 4]);
      c.strokeStyle = "#fff";
      c.lineWidth = 1.5;
      c.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
  }
  c.restore();
}

// The whole picture, full size, with every step (crops aside).
function paintFull() {
  const full = new OffscreenCanvas(base.naturalWidth, base.naturalHeight);
  const c = full.getContext("2d");
  c.drawImage(base, 0, 0);
  for (const s of steps) if (s.kind !== "crop") drawStep(c, s);
  return full;
}

function render() {
  if (!base) return;
  const v = view();
  const full = paintFull();
  if (draft && draft.kind !== "crop-draft") drawStep(full.getContext("2d"), draft);
  canvas.width = v.w;
  canvas.height = v.h;
  ctx.drawImage(full, v.x, v.y, v.w, v.h, 0, 0, v.w, v.h);
  if (draft?.kind === "crop-draft") {
    ctx.save();
    ctx.translate(-v.x, -v.y);
    drawStep(ctx, { ...draft, rect: draft.rect });
    ctx.restore();
  }
  $("undo").disabled = !steps.length;
  $("redo").disabled = !undone.length;
}

// Where the pointer is on the full-size picture.
function point(e) {
  const r = canvas.getBoundingClientRect();
  const v = view();
  return { x: v.x + ((e.clientX - r.left) / r.width) * canvas.width, y: v.y + ((e.clientY - r.top) / r.height) * canvas.height };
}

function commit(step) {
  steps.push(step);
  undone = [];
  render();
}

function wireCanvas() {
  let start = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !base) return;
    const p = point(e);
    if (tool === "text") return startText(e, p);
    canvas.setPointerCapture(e.pointerId);
    start = p;
    if (tool === "pen" || tool === "marker") draft = { kind: tool, color, size, points: [p] };
    else if (tool === "arrow") draft = { kind: "arrow", color, size, a: p, b: p };
    else if (tool === "crop") draft = { kind: "crop-draft", rect: normRect(p, p) };
    else draft = { kind: tool, color, size, rect: normRect(p, p) };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!draft || !start) return;
    const p = point(e);
    if (draft.points) draft.points.push(p);
    else if (draft.kind === "arrow") draft.b = p;
    else draft.rect = normRect(start, p);
    render();
  });
  canvas.addEventListener("pointerup", () => {
    if (!draft) return;
    const d = draft;
    draft = null;
    start = null;
    if (d.kind === "crop-draft") {
      if (d.rect.w >= 8 && d.rect.h >= 8) commit({ kind: "crop", rect: { x: Math.round(d.rect.x), y: Math.round(d.rect.y), w: Math.round(d.rect.w), h: Math.round(d.rect.h) } });
      else render();
      return;
    }
    if (d.kind === "arrow" && Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) < 4) return render();
    if (d.rect && (d.rect.w < 3 || d.rect.h < 3)) return render();
    commit(d);
  });
}

function startText(e, p) {
  const box = $("text-input");
  const wrap = $("wrap").getBoundingClientRect();
  box.style.display = "block";
  box.style.left = `${e.clientX - wrap.left}px`;
  box.style.top = `${e.clientY - wrap.top}px`;
  box.style.color = color;
  box.textContent = "";
  box.focus();
  const done = () => {
    box.removeEventListener("blur", done);
    box.style.display = "none";
    const text = box.innerText.replace(/\n+$/, "");
    if (text.trim()) commit({ kind: "text", color, size, at: p, text: text.slice(0, 2000) });
  };
  box.addEventListener("blur", done);
  box.onkeydown = (ev) => {
    if (ev.key === "Escape") {
      box.textContent = "";
      box.blur();
    } else if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      box.blur();
    }
  };
}

function undo() {
  if (!steps.length) return;
  undone.push(steps.pop());
  render();
}
function redo() {
  if (!undone.length) return;
  steps.push(undone.pop());
  render();
}

function buildBar() {
  const p = prefs();
  tool = TOOLS.some((t) => t.id === p.tool) ? p.tool : "arrow";
  color = p.color;
  size = Number(p.size) || 5;
  const tools = $("tools");
  for (const t of TOOLS) {
    const b = document.createElement("button");
    b.className = `tool${t.id === tool ? " on" : ""}`;
    b.title = t.title;
    b.innerHTML = t.icon;
    b.addEventListener("click", () => {
      tool = t.id;
      tools.querySelectorAll(".tool").forEach((x) => x.classList.toggle("on", x === b));
      rememberPrefs();
    });
    tools.appendChild(b);
  }
  const colors = $("colors");
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.className = `swatch${c === color ? " on" : ""}`;
    b.style.background = c;
    b.title = c;
    b.addEventListener("click", () => {
      color = c;
      colors.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("on", x === b));
      rememberPrefs();
    });
    colors.appendChild(b);
  }
  $("size").value = size;
  $("size").addEventListener("input", (e) => {
    size = Number(e.target.value);
    rememberPrefs();
  });
  $("undo").innerHTML = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>');
  $("redo").innerHTML = svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>');
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  document.addEventListener("keydown", (e) => {
    if (document.activeElement === $("text-input")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    }
  });
  $("copy").addEventListener("click", copy);
  $("save").addEventListener("click", save);
}

async function blobOf(type) {
  render();
  return await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
}

async function copy() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": await blobOf("image/png") })]);
    toast("Copied");
  } catch {
    toast("Couldn't copy -- clipboard unavailable");
  }
}

async function save() {
  const jpeg = mime === "image/jpeg";
  const blob = await blobOf(jpeg ? "image/jpeg" : "image/png");
  const data = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(blob);
  });
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".");
  const path = await invoke("save_image", { data, jpeg, name: `Screenshot ${stamp}` }).catch((err) => toast(String(err)));
  if (path) toast(`Saved to ${path}`);
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  buildBar();
  wireCanvas();
  const key = new URLSearchParams(location.search).get("k") || "";
  const shot = key ? await invoke("shot_image", { key }).catch(() => null) : null;
  if (!shot?.data) {
    $("stage").innerHTML = `<div id="empty">This screenshot isn't here any more -- take another (Ctrl+Shift+S).</div>`;
    return;
  }
  mime = shot.mime === "image/jpeg" ? "image/jpeg" : "image/png";
  base = new Image();
  base.onload = render;
  base.src = `data:${mime};base64,${shot.data}`;
});
