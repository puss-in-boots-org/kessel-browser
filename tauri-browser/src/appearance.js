// Settings -> Appearance: pick one of the UI styles and change anything
// about it. The styles, their options and how they're applied live in
// shared/styles.js; this is only the panel.
//
// Every control is generated from OPTIONS, so a new option only needs adding
// there. A change shows on this page at once and is saved a moment later,
// which broadcasts it to every other Kessel page (the toolbar, new tabs,
// menus) -- see shared/theme.js.

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings, previewSettings, beginPreview, endPreview } from "./shared/theme.js";
import { toast, confirmDialog, escapeHtml } from "./shared/api.js";
import { STYLES, STYLE_IDS, GROUPS, OPTIONS, OPTION_MAP, FONTS, resolveStyle, styleState, isHexColor, backdropCss, fontStack, mixHex } from "./shared/styles.js";
import { WALLPAPERS, setCustomWallpaper, clearCustomWallpaper, hasCustomWallpaper, wallpaperCss } from "./shared/glass.js";

const OPEN_KEY = "kessel.appearance.open";

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const S = () => currentSettings() || {};
const current = () => resolveStyle(S());
const storageKey = (opt, mode) => (opt.perMode ? `${opt.key}@${mode}` : opt.key);
const same = (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);
const isChanged = (r, opt) => !same(r.values[opt.key], r.defaults[opt.key]);
const visible = (opt, r) => (!opt.showIf || opt.showIf(r.values, r.id)) && !(opt.notFor || []).includes(r.id);
const groupApplies = (group, id) => !group.only || group.only.includes(id);

// --- Saving -------------------------------------------------------------------
// Sliders and colour pickers fire many times a second: this page shows each
// value straight away, and the save (a disk write plus a broadcast to every
// page) goes out once the value settles.

let pending = null;
let saveTimer = null;
let previewing = false;

function save(patch, { live = false } = {}) {
  pending = { ...(pending || {}), ...patch };
  if (!previewing) {
    beginPreview();
    previewing = true;
  }
  previewSettings(patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, live ? 180 : 0);
  refresh();
}

async function flush() {
  const patch = pending;
  pending = null;
  if (patch) await saveSettings(patch).catch((e) => toast(String(e)));
  if (!pending && previewing) {
    endPreview();
    previewing = false;
  }
}

function saveStyle(id, custom, extra = {}, options) {
  const all = { ...styleState(S()).all, [id]: custom };
  save({ ui_style: id, ui_custom: all, ...extra }, options);
}

// --- Undo / redo ----------------------------------------------------------------

const undoStack = [];
const redoStack = [];
let lastUndo = { key: null, at: 0 };

function snapshot() {
  const s = S();
  const state = styleState(s);
  return { ui_style: state.id, ui_custom: structuredClone(state.all), ui_presets: structuredClone(presetsOf(s)) };
}

// Repeated changes to the same option (a slider drag) are one step.
function pushUndo(key = null) {
  const now = Date.now();
  if (key && key === lastUndo.key && now - lastUndo.at < 1500) {
    lastUndo.at = now;
    return;
  }
  lastUndo = { key, at: now };
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  lastUndo = { key: null, at: 0 };
  save(undoStack.pop());
  rebuild();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  lastUndo = { key: null, at: 0 };
  save(redoStack.pop());
  rebuild();
}

// --- Setting values ---------------------------------------------------------------

function setOption(key, value, { live = false } = {}) {
  const r = current();
  const opt = OPTION_MAP[key];
  pushUndo(key);
  const custom = { ...r.custom };
  const k = storageKey(opt, r.mode);
  if (same(value, r.defaults[key])) delete custom[k];
  else custom[k] = value;
  saveStyle(r.id, custom, {}, { live });
}

function resetOptions(keys) {
  const r = current();
  pushUndo();
  const custom = { ...r.custom };
  for (const key of keys) delete custom[storageKey(OPTION_MAP[key], r.mode)];
  saveStyle(r.id, custom);
}

// Only values Kessel understands, of the right kind and in range -- for
// imported looks and saved ones alike.
function sanitize(values) {
  const out = {};
  if (!values || typeof values !== "object") return out;
  for (const [rawKey, value] of Object.entries(values)) {
    const [key, mode] = rawKey.split("@");
    const opt = OPTION_MAP[key];
    if (!opt || (opt.perMode ? !["dark", "light"].includes(mode) : mode !== undefined)) continue;
    switch (opt.type) {
      case "color":
        if (isHexColor(value)) out[rawKey] = value;
        break;
      case "range":
        if (typeof value === "number" && isFinite(value)) out[rawKey] = Math.min(opt.max, Math.max(opt.min, value));
        break;
      case "toggle":
        if (typeof value === "boolean") out[rawKey] = value;
        break;
      case "choice":
        if (opt.choices.some(([v]) => v === value)) out[rawKey] = value;
        break;
      case "font":
        if (value === "same" ? opt.withSame : FONTS.some(([id]) => id === value)) out[rawKey] = value;
        break;
      case "wallpaper":
        if (value === "custom" || WALLPAPERS[value]) out[rawKey] = value;
        break;
      default:
        if (typeof value === "string") out[rawKey] = value.slice(0, 50000);
    }
  }
  return out;
}

function presetsOf(settings) {
  return Array.isArray(settings.ui_presets) ? settings.ui_presets : [];
}

// --- Controls -------------------------------------------------------------------
// Each returns {node, update(r)}; update() puts the current value back in
// unless you're busy with the control.

const busy = (node) => node.contains(document.activeElement) && document.activeElement.tagName !== "BUTTON";

function formatNumber(opt, value) {
  const digits = opt.step < 0.01 ? 3 : opt.step < 0.1 ? 2 : opt.step < 1 ? 1 : 0;
  return String(Number(Number(value).toFixed(digits)));
}

function colorControl(opt) {
  const node = el(`<div class="k-color"><input type="color" /><input class="field k-hex" maxlength="7" spellcheck="false" /></div>`);
  const [picker, hex] = node.querySelectorAll("input");
  picker.addEventListener("input", () => {
    hex.value = picker.value;
    setOption(opt.key, picker.value, { live: true });
  });
  hex.addEventListener("change", () => {
    const raw = hex.value.trim();
    const value = raw.startsWith("#") ? raw : `#${raw}`;
    if (isHexColor(value)) setOption(opt.key, value.toLowerCase());
    else toast("Colours look like #7c5cff");
  });
  return {
    node,
    update(r) {
      const value = r.values[opt.key];
      if (document.activeElement !== picker) picker.value = value;
      if (document.activeElement !== hex) hex.value = value;
    },
  };
}

function rangeControl(opt) {
  const node = el(`<div class="k-range"><input type="range" min="${opt.min}" max="${opt.max}" step="${opt.step}" /><input class="field k-num" type="number" min="${opt.min}" max="${opt.max}" step="${opt.step}" /><span class="k-unit">${opt.unit || ""}</span></div>`);
  const [slider, number] = node.querySelectorAll("input");
  const paintFill = (value) => slider.style.setProperty("--k-fill", `${((value - opt.min) / (opt.max - opt.min)) * 100}%`);
  slider.addEventListener("input", () => {
    number.value = formatNumber(opt, slider.value);
    paintFill(slider.value);
    setOption(opt.key, parseFloat(slider.value), { live: true });
  });
  number.addEventListener("change", () => {
    const value = parseFloat(number.value);
    if (isFinite(value)) setOption(opt.key, Math.min(opt.max, Math.max(opt.min, value)));
  });
  return {
    node,
    update(r) {
      const value = r.values[opt.key];
      if (document.activeElement !== slider) {
        slider.value = value;
        paintFill(value);
      }
      if (document.activeElement !== number) number.value = formatNumber(opt, value);
    },
  };
}

function toggleControl(opt) {
  const node = el(`<button class="switch" role="switch"></button>`);
  node.addEventListener("click", () => setOption(opt.key, !node.classList.contains("on")));
  return {
    node,
    update(r) {
      const on = !!r.values[opt.key];
      node.classList.toggle("on", on);
      node.setAttribute("aria-checked", String(on));
    },
  };
}

function choiceControl(opt) {
  const short = opt.choices.length <= 4 && opt.choices.reduce((n, [, label]) => n + label.length, 0) <= 30;
  if (short) {
    const node = el(`<div class="segmented"></div>`);
    for (const [value, label] of opt.choices) {
      const b = document.createElement("button");
      b.textContent = label;
      b.dataset.value = value;
      b.addEventListener("click", () => setOption(opt.key, value));
      node.appendChild(b);
    }
    return {
      node,
      update(r) {
        node.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === r.values[opt.key]));
      },
    };
  }
  const node = el(`<select class="field k-select"></select>`);
  for (const [value, label] of opt.choices) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    node.appendChild(o);
  }
  node.addEventListener("change", () => setOption(opt.key, node.value));
  return {
    node,
    update(r) {
      if (!busy(node)) node.value = r.values[opt.key];
    },
  };
}

const FONT_GROUPS = [
  ["Sans serif", ["system", "segoe", "inter", "bahnschrift", "helvetica", "verdana", "tahoma", "trebuchet", "calibri", "candara", "corbel", "century", "franklin", "arialblack", "impact"]],
  ["Serif", ["georgia", "cambria", "constantia", "palatino", "bookantiqua", "garamond", "times", "bookman"]],
  ["Monospace", ["cascadia", "consolas", "courier", "lucida"]],
  ["Handwritten & display", ["segoeprint", "segoescript", "inkfree", "gabriola", "comic"]],
  ["Other", ["custom"]],
];

function fontControl(opt) {
  const node = el(`<select class="field k-select k-font"></select>`);
  const names = Object.fromEntries(FONTS.map(([id, name]) => [id, name]));
  if (opt.withSame) {
    const o = document.createElement("option");
    o.value = "same";
    o.textContent = "Same as the interface";
    node.appendChild(o);
  }
  for (const [label, ids] of FONT_GROUPS) {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const id of ids) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = names[id];
      if (id !== "custom") o.style.fontFamily = fontStack(id);
      group.appendChild(o);
    }
    node.appendChild(group);
  }
  node.addEventListener("change", () => setOption(opt.key, node.value));
  return {
    node,
    update(r) {
      const value = r.values[opt.key];
      if (!busy(node)) node.value = value;
      node.style.fontFamily = value === "same" ? "" : fontStack(value, r.values.fontCustom);
    },
  };
}

function textControl(opt) {
  const node = el(`<input class="field k-text" spellcheck="false" />`);
  let timer = null;
  node.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => setOption(opt.key, node.value), 400);
  });
  return {
    node,
    update(r) {
      if (!busy(node)) node.value = r.values[opt.key] || "";
    },
  };
}

function codeControl(opt) {
  const node = el(`<div class="k-code">
    <textarea class="field" spellcheck="false" rows="9"></textarea>
    <div class="k-code-foot faint">Applied as you type, to every Kessel page</div>
  </div>`);
  const area = node.querySelector("textarea");
  area.placeholder = `/* for example */\nhtml[data-page="toolbar"] .tab.active { font-weight: 700; }\n.section h2 { letter-spacing: 0.2em; }`;
  let timer = null;
  area.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => setOption(opt.key, area.value, { live: true }), 350);
  });
  // Tab indents instead of leaving the box.
  area.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
    area.dispatchEvent(new Event("input"));
  });
  return {
    node,
    update(r) {
      if (!busy(node)) area.value = r.values[opt.key] || "";
    },
  };
}

let wallpaperInput = null;

function wallpaperControl(opt) {
  const node = el(`<div class="wallpaper-row"></div>`);
  if (!wallpaperInput) {
    wallpaperInput = el(`<input type="file" accept="image/*" hidden />`);
    document.body.appendChild(wallpaperInput);
    wallpaperInput.addEventListener("change", async () => {
      const file = wallpaperInput.files[0];
      wallpaperInput.value = "";
      if (!file) return;
      try {
        await setCustomWallpaper(file);
        setOption("wallpaper", "custom");
        // Saved again even when "custom" was already chosen, so every page
        // repaints with the new image.
        save({});
        toast("Wallpaper updated");
      } catch (err) {
        toast(err.message || String(err));
      }
    });
  }
  function render(r) {
    node.innerHTML = "";
    const selected = r.values[opt.key];
    for (const [id, wp] of Object.entries(WALLPAPERS)) {
      const sw = el(`<button class="wallpaper-swatch ${selected === id ? "selected" : ""}"><div class="wp-preview"></div><span></span></button>`);
      sw.title = wp.name;
      sw.querySelector("span").textContent = wp.name;
      sw.querySelector(".wp-preview").style.background = wp.css;
      sw.addEventListener("click", () => setOption(opt.key, id));
      node.appendChild(sw);
    }
    const hasCustom = hasCustomWallpaper();
    const custom = el(`<button class="wallpaper-swatch ${selected === "custom" ? "selected" : ""}" title="Use your own image">
      <div class="wp-preview custom">${hasCustom ? "" : icon("plus", 16)}</div><span>${hasCustom ? "Your image" : "Choose…"}</span></button>`);
    if (hasCustom) custom.querySelector(".wp-preview").style.background = wallpaperCss({ wallpaper: "custom" });
    custom.addEventListener("click", () => {
      if (hasCustom && selected !== "custom") setOption(opt.key, "custom");
      else wallpaperInput.click();
    });
    node.appendChild(custom);
    if (hasCustom) {
      const remove = el(`<button class="btn ghost sm" title="Remove your image">${icon("trash", 14)}</button>`);
      remove.addEventListener("click", () => {
        clearCustomWallpaper();
        if (selected === "custom") setOption(opt.key, "nightfall");
        else render(current());
      });
      node.appendChild(remove);
    }
  }
  let shown = null;
  return {
    node,
    update(r) {
      const key = `${r.values[opt.key]}|${hasCustomWallpaper()}`;
      if (key === shown) return;
      shown = key;
      render(r);
    },
  };
}

const CONTROLS = { color: colorControl, range: rangeControl, toggle: toggleControl, choice: choiceControl, font: fontControl, text: textControl, code: codeControl, wallpaper: wallpaperControl };

// --- Rows, groups and the updaters that keep them current ---------------------------

let updaters = [];

function optionRow(opt) {
  const wide = opt.type === "code" || opt.type === "wallpaper";
  const row = el(`<div class="k-row ${wide ? "wide" : ""}" data-key="${opt.key}">
    <div class="info">
      <div class="title"><span class="k-row-label"></span><button class="k-reset" title="Back to this style's default">${icon("refresh", 12)}</button></div>
      ${opt.desc ? `<div class="desc"></div>` : ""}
    </div>
    <div class="control"></div>
  </div>`);
  row.querySelector(".k-row-label").textContent = opt.label;
  if (opt.desc) row.querySelector(".desc").textContent = opt.desc;
  row.dataset.search = `${opt.label} ${opt.desc || ""} ${opt.key} ${(opt.choices || []).map(([, l]) => l).join(" ")}`.toLowerCase();
  const control = CONTROLS[opt.type](opt);
  row.querySelector(".control").appendChild(control.node);
  row.querySelector(".k-reset").addEventListener("click", () => resetOptions([opt.key]));
  updaters.push((r) => {
    const show = visible(opt, r);
    row.hidden = !show;
    row.classList.toggle("changed", isChanged(r, opt));
    if (show) control.update(r);
  });
  return row;
}

function loadOpen() {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY)) || {};
  } catch {
    return {};
  }
}

function groupCard({ id, title, desc, iconName, keys, openByDefault = false }) {
  const isOpen = loadOpen()[id] ?? openByDefault;
  const card = el(`<section class="setting-card k-group ${isOpen ? "open" : ""}" data-group="${id}">
    <header class="k-group-head" tabindex="0">
      <span class="k-group-icon">${icon(iconName, 16)}</span>
      <div class="k-group-title"><span class="k-label"></span><small></small></div>
      <span class="k-changed-pill" hidden></span>
      <button class="btn ghost sm icon-only k-group-reset" title="Reset everything in this group">${icon("refresh", 14)}</button>
      <span class="k-chevron">${icon("chevronDown", 16)}</span>
    </header>
    <div class="k-group-body"></div>
  </section>`);
  card.querySelector(".k-label").textContent = title;
  card.querySelector("small").textContent = desc || "";
  const body = card.querySelector(".k-group-body");
  const opts = keys.map((k) => OPTION_MAP[k]).filter(Boolean);
  for (const opt of opts) body.appendChild(optionRow(opt));
  const toggle = () => {
    card.classList.toggle("open");
    const state = loadOpen();
    state[id] = card.classList.contains("open");
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(state));
    } catch {}
  };
  const head = card.querySelector(".k-group-head");
  head.addEventListener("click", (e) => {
    if (!e.target.closest(".k-group-reset")) toggle();
  });
  head.addEventListener("keydown", (e) => {
    if (e.target === head && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggle();
    }
  });
  card.querySelector(".k-group-reset").addEventListener("click", () => {
    const r = current();
    const changed = opts.filter((o) => isChanged(r, o));
    if (!changed.length) return;
    resetOptions(changed.map((o) => o.key));
    toast(`${title}: back to ${STYLES[r.id].name}'s defaults`);
  });
  updaters.push((r) => {
    const n = opts.filter((o) => isChanged(r, o)).length;
    const pill = card.querySelector(".k-changed-pill");
    pill.hidden = n === 0;
    pill.textContent = `${n} changed`;
    card.querySelector(".k-group-reset").hidden = n === 0;
    if (id === "palette") card.querySelector("small").textContent = `Every colour of the interface in ${r.mode} mode -- switch the mode to edit the other set`;
  });
  return card;
}

// --- The style gallery -------------------------------------------------------------

function mockLook(id) {
  const r = resolveStyle(S(), id);
  const v = r.values;
  const backdrop = v.background === "wallpaper" ? wallpaperCss({ wallpaper: v.wallpaper }) : v.background === "solid" ? v.bg : backdropCss(v);
  const half = (n) => `${Math.round(n / 2)}px`;
  const tabRadius = { pill: "999px", rounded: half(v.tabRadius), folder: `${half(v.tabRadius)} ${half(v.tabRadius)} 0 0`, slanted: `${half(v.tabRadius)} ${half(v.tabRadius)} 0 0` }[v.tabShape] || "0";
  const addrRadius = { pill: "999px", rounded: half(v.addressRadius) }[v.addressShape] || "0";
  const stripe = {
    accent: v.accent,
    gradient: `linear-gradient(90deg, ${v.accent}, ${v.accent2})`,
    hazard: "repeating-linear-gradient(-45deg, #f5c400 0 5px, #16181b 5px 10px)",
    rainbow: "linear-gradient(90deg, #ff5f6d, #ffc371, #47e891, #3ab0ff, #a86bff)",
    rule: `linear-gradient(${v.text}, ${v.text}) top / 100% 1px no-repeat, linear-gradient(${v.text}, ${v.text}) bottom / 100% 1px no-repeat`,
  }[v.stripeTop];
  const vars = {
    "--m-bg": v.bg,
    "--m-chrome": v.chromeBg,
    "--m-rail": v.railBg,
    "--m-surface": v.surface,
    "--m-tab": v.tabActiveBg,
    "--m-addr": v.addressBg,
    "--m-text": v.text,
    "--m-dim": v.textDim,
    "--m-border": v.neonBorders ? mixHex(v.accent, v.bg, 55) : v.border,
    "--m-accent": v.accent,
    "--m-accent2": v.accent2,
    "--m-fill": v.accentGradient ? `linear-gradient(90deg, ${v.accent}, ${v.accent2})` : v.accent,
    "--m-font": fontStack(v.font, v.fontCustom),
    "--m-r": half(v.radius),
    "--m-tab-r": tabRadius,
    "--m-addr-r": addrRadius,
    "--m-bw": v.borderWidth > 0 ? `${Math.max(1, Math.round(v.borderWidth / 1.5))}px` : "0px",
    "--m-bs": v.borderStyle === "double" && v.borderWidth >= 3 ? "double" : "solid",
    "--m-backdrop": backdrop,
    "--m-alpha": v.background !== "solid" && id !== "glass" ? `${v.chromeOpacity}%` : "100%",
    "--m-glow": `${Math.round(v.glow / 2)}px`,
    "--m-stripe": stripe || "none",
  };
  const flags = {
    "m-glass": id === "glass",
    "m-light": r.mode === "light",
    "m-scan": v.scanlines > 0,
    "m-grain": v.grain > 0,
    "m-vignette": v.vignette > 0,
    "m-chamfer-tab": v.tabShape === "chamfer",
    "m-chamfer-addr": v.addressShape === "chamfer",
    "m-line-tab": v.tabShape === "underline",
    "m-glow": v.glow > 0,
    "m-bevel": v.bevel > 0,
    "m-hud": v.hudBrackets,
    "m-rivets": v.rivets,
    "m-dividers": v.dividers,
    "m-stripe": !!stripe,
  };
  return { r, vars, flags };
}

function styleCard(id) {
  const style = STYLES[id];
  const card = el(`<button class="style-card" data-style="${id}">
    <div class="mock">
      <div class="m-backdrop"></div>
      <div class="m-rail"><i class="m-logo"></i><i></i><i></i><i></i></div>
      <div class="m-main">
        <div class="m-tabs"><span class="m-tab on"><b></b></span><span class="m-tab"><b></b></span><span class="m-tab"><b></b></span></div>
        <div class="m-nav"><i></i><i></i><span class="m-addr"><em></em></span></div>
        <div class="m-page"><span class="m-title">Aa</span><span class="m-lines"><i></i><i></i><i></i></span><span class="m-btn"></span></div>
      </div>
    </div>
    <div class="style-meta"><b></b><small></small><span class="style-changed"></span></div>
    <span class="style-check">${icon("check", 13)}</span>
  </button>`);
  card.querySelector(".style-meta b").textContent = style.name;
  card.querySelector(".style-meta small").textContent = style.tagline;
  card.addEventListener("click", () => {
    if (current().id === id) return;
    pushUndo();
    save({ ui_style: id, ui_custom: styleState(S()).all });
    rebuild();
  });
  let shown = null;
  updaters.push((r) => {
    card.classList.toggle("selected", r.id === id);
    const look = mockLook(id);
    const changes = Object.keys(look.r.custom).length;
    card.querySelector(".style-changed").textContent = changes ? `${changes} change${changes === 1 ? "" : "s"}` : "";
    const key = JSON.stringify([look.vars, look.flags]);
    if (key === shown) return;
    shown = key;
    const mock = card.querySelector(".mock");
    for (const [k, value] of Object.entries(look.vars)) mock.style.setProperty(k, value);
    for (const [k, on] of Object.entries(look.flags)) mock.classList.toggle(k, on);
  });
  return card;
}

// --- Presets, saved looks, import/export, surprise ------------------------------------

function applyValues(id, values, message) {
  pushUndo();
  saveStyle(id, sanitize(values));
  rebuild();
  if (message) toast(message);
}

function presetsCard() {
  const card = el(`<div class="setting-card k-presets">
    <div class="k-presets-head"><span class="k-label">Presets</span><small class="faint k-presets-note"></small></div>
    <div class="k-preset-row k-builtin"></div>
    <div class="k-presets-head k-mine-head"><span class="k-label">Your looks</span><small class="faint">Saved with “Save look” -- any style</small></div>
    <div class="k-preset-row k-mine"></div>
  </div>`);
  let shown = null;
  updaters.push((r) => {
    const key = JSON.stringify([r.id, presetsOf(S()), r.custom]);
    if (key === shown) return;
    shown = key;
    card.querySelector(".k-presets-note").textContent = `Starting points for ${STYLES[r.id].name}. They replace your changes to it -- Undo brings them back.`;
    const builtin = card.querySelector(".k-builtin");
    builtin.innerHTML = "";
    const mine = JSON.stringify(r.custom);
    for (const preset of STYLES[r.id].presets) {
      const values = sanitize(preset.values);
      const chip = el(`<button class="k-preset"><span class="k-swatches"></span><span class="k-preset-name"></span></button>`);
      chip.querySelector(".k-preset-name").textContent = preset.name;
      const look = resolveStyle({ ui_style: r.id, ui_custom: { [r.id]: values } }).values;
      chip.querySelector(".k-swatches").innerHTML = [look.bg, look.surface, look.accent, look.accent2].map((c) => `<i style="background:${c}"></i>`).join("");
      chip.classList.toggle("active", JSON.stringify(values) === mine);
      chip.addEventListener("click", () => applyValues(r.id, values, `${preset.name} applied`));
      builtin.appendChild(chip);
    }
    const saved = presetsOf(S()).filter((p) => STYLES[p.style]);
    const user = card.querySelector(".k-mine");
    user.innerHTML = "";
    card.querySelector(".k-mine-head").hidden = !saved.length;
    user.hidden = !saved.length;
    for (const preset of saved) {
      const chip = el(`<span class="k-preset k-saved"><button class="k-preset-apply"><span class="k-style-tag"></span><span class="k-preset-name"></span></button><button class="k-preset-x" title="Delete this look">${icon("close", 11)}</button></span>`);
      chip.querySelector(".k-style-tag").textContent = STYLES[preset.style].name;
      chip.querySelector(".k-preset-name").textContent = preset.name;
      chip.querySelector(".k-preset-apply").addEventListener("click", () => applyValues(preset.style, preset.values, `${preset.name} applied`));
      chip.querySelector(".k-preset-x").addEventListener("click", async () => {
        if (!(await confirmDialog(`Delete the look “${preset.name}”?`, "Delete"))) return;
        pushUndo();
        save({ ui_presets: presetsOf(S()).filter((p) => p.id !== preset.id) });
      });
      user.appendChild(chip);
    }
  });
  return card;
}

// A small modal with a form; resolves with the form's body element, or null.
function formDialog({ title, bodyHtml, okLabel, onOpen }) {
  return new Promise((resolve) => {
    const backdrop = el(`<div class="modal-backdrop open"><div class="modal k-dialog"><h3></h3><div class="k-dialog-body">${bodyHtml}</div>
      <div class="k-dialog-actions"><button class="btn ghost" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok"></button></div></div></div>`);
    backdrop.querySelector("h3").textContent = title;
    backdrop.querySelector("[data-act=ok]").textContent = okLabel;
    document.body.appendChild(backdrop);
    const body = backdrop.querySelector(".k-dialog-body");
    const done = (value) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    function onKey(e) {
      if (e.key === "Escape") done(null);
      if (e.key === "Enter" && e.target.tagName === "INPUT") done(body);
    }
    backdrop.querySelector("[data-act=cancel]").addEventListener("click", () => done(null));
    backdrop.querySelector("[data-act=ok]").addEventListener("click", () => done(body));
    backdrop.addEventListener("click", (e) => e.target === backdrop && done(null));
    document.addEventListener("keydown", onKey);
    onOpen?.(body);
  });
}

async function saveLook() {
  const r = current();
  const body = await formDialog({
    title: "Save this look",
    bodyHtml: `<label class="label">Name</label><input class="field" maxlength="40" placeholder="My ${escapeHtml(STYLES[r.id].name)}" />`,
    okLabel: "Save",
    onOpen: (b) => b.querySelector("input").focus(),
  });
  if (!body) return;
  const name = body.querySelector("input").value.trim() || `My ${STYLES[r.id].name}`;
  pushUndo();
  const preset = { id: `look-${Date.now().toString(36)}`, name, style: r.id, values: structuredClone(r.custom) };
  save({ ui_presets: [...presetsOf(S()), preset] });
  toast(`Saved “${name}”`);
}

function exportLook() {
  const r = current();
  const data = { kessel: "ui-style", version: 1, style: r.id, values: r.custom };
  navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(
    () => toast("Look copied -- paste it into Import on any Kessel"),
    () => toast("Couldn't copy -- clipboard unavailable")
  );
}

async function importLook() {
  const body = await formDialog({
    title: "Import a look",
    bodyHtml: `<p class="faint k-dialog-note">Paste a look copied with Export. It replaces your changes to that style -- Undo brings them back.</p><textarea class="field k-import" rows="9" spellcheck="false" placeholder='{ "kessel": "ui-style", ... }'></textarea>`,
    okLabel: "Import",
    onOpen: (b) => b.querySelector("textarea").focus(),
  });
  if (!body) return;
  let data = null;
  try {
    data = JSON.parse(body.querySelector("textarea").value);
  } catch {}
  if (!data || !STYLES[data.style] || typeof data.values !== "object") return toast("That isn't a Kessel look -- copy one with Export");
  applyValues(data.style, data.values, `Imported a ${STYLES[data.style].name} look`);
}

async function resetStyle() {
  const r = current();
  if (!Object.keys(r.custom).length) return toast(`${STYLES[r.id].name} is already as designed`);
  if (!(await confirmDialog(`Put ${STYLES[r.id].name} back exactly as designed? Your other styles keep their changes.`, "Reset"))) return;
  applyValues(r.id, {}, `${STYLES[r.id].name} reset`);
}

function hslHex(h, s, l) {
  s /= 100;
  l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// A random look within the current style: new accents, shapes, type and
// effects -- the style's own palette and your colours stay, so it still
// reads as itself.
function surprise() {
  const r = current();
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const chance = (p) => Math.random() < p;
  const choices = (key) => OPTION_MAP[key].choices.map(([v]) => v);
  const hue = Math.floor(Math.random() * 360);
  const values = {
    accent: hslHex(hue, 75 + Math.random() * 20, 55 + Math.random() * 10),
    accent2: hslHex((hue + 120 + Math.random() * 120) % 360, 80, 60),
    accentGradient: chance(0.5),
    gradientAngle: pick([90, 120, 135, 160, 200]),
    font: pick(["system", "segoe", "bahnschrift", "century", "georgia", "palatino", "garamond", "cascadia", "trebuchet", "corbel", "franklin"]),
    radius: pick([0, 2, 4, 6, 8, 12, 16, 20]),
    tabShape: pick(choices("tabShape")),
    tabIndicator: pick(choices("tabIndicator")),
    addressShape: pick(choices("addressShape")),
    iconShape: pick(choices("iconShape")),
    windowControls: pick(choices("windowControls")),
    stripeTop: pick(["none", "none", "accent", "gradient", "rainbow"]),
    glow: pick([0, 0, 8, 14, 22]),
    bevel: pick([0, 0, 0, 40, 70]),
    gloss: pick([0, 0, 30, 60]),
    grain: pick([0, 0, 0, 10, 20]),
    scanlines: pick([0, 0, 0, 12]),
    vignette: pick([0, 0, 20, 35]),
    hudBrackets: chance(0.2),
    neonBorders: chance(0.2),
    rivets: chance(0.12),
    ornaments: chance(0.12),
    easing: pick(choices("easing")),
    tabAnimation: pick(choices("tabAnimation")),
    background: r.id === "glass" ? pick(["wallpaper", "wallpaper", "gradient", "pattern"]) : pick(["solid", "solid", "gradient", "pattern", "wallpaper"]),
    wallpaper: pick(Object.keys(WALLPAPERS)),
    pattern: pick(choices("pattern")),
    patternOpacity: pick([6, 10, 16]),
    bgGradientA: hslHex(hue, 55, 12 + Math.random() * 10),
    bgGradientB: hslHex((hue + 50 + Math.random() * 80) % 360, 60, 18 + Math.random() * 12),
    bgGradientAngle: pick([90, 135, 160, 180, 210]),
  };
  if (r.id === "glass") {
    Object.assign(values, {
      glassTintColor: pick(["#ffffff", "#ffffff", hslHex(hue, 80, 85), "#000000"]),
      glassTint: pick([60, 100, 150, 220]),
      glassBlur: pick([6, 14, 22, 30]),
      glassRim: pick([60, 100, 160]),
    });
  }
  const custom = {};
  for (const [key, value] of Object.entries(values)) if (!same(value, r.defaults[key])) custom[key] = value;
  for (const [key, value] of Object.entries(r.custom)) if (key.includes("@") || key === "mode") custom[key] = value;
  applyValues(r.id, custom, "Here's something new -- Undo if it's not for you");
}

// --- Search and "changed only" ---------------------------------------------------------

let filterText = "";
let changedOnly = false;

function applyFilter(root) {
  const q = filterText.trim().toLowerCase();
  const filtering = !!q || changedOnly;
  const r = current();
  let any = false;
  root.querySelectorAll(".k-group").forEach((card) => {
    const rows = [...card.querySelectorAll(".k-row")];
    // Options that match show on their own; a group whose name matches
    // but none of its options do shows whole ("texture", "tabs").
    const direct = q && rows.some((row) => !row.hidden && row.dataset.search.includes(q));
    const groupMatch = !!q && !direct && (card.dataset.search || "").includes(q);
    let inCard = false;
    rows.forEach((row) => {
      const opt = OPTION_MAP[row.dataset.key];
      const matches = (!q || groupMatch || row.dataset.search.includes(q)) && (!changedOnly || isChanged(r, opt));
      row.classList.toggle("filtered-out", !matches);
      if (matches && !row.hidden) inCard = true;
    });
    // The essentials repeat options found below: hidden while filtering.
    const hide = filtering && (!inCard || card.dataset.group === "essentials");
    card.classList.toggle("filtered-out", hide);
    card.classList.toggle("force-open", filtering && inCard);
    if (inCard && !hide) any = true;
  });
  root.querySelector(".k-no-results").hidden = !filtering || any;
}

// --- The section ------------------------------------------------------------------------

let section = null;

function build() {
  updaters = [];
  const r = current();
  const node = el(`<div class="k-style-section">
    <div class="style-gallery"></div>
    <div class="k-bar">
      <div class="k-search">${icon("search", 14)}<input class="field" spellcheck="false" /></div>
      <div class="k-actions">
        <button class="btn sm" data-act="changed" title="Show only what you changed">${icon("edit", 13)}<span>Changed</span></button>
        <button class="btn sm icon-only" data-act="undo" title="Undo (Ctrl+Z)">${icon("undo", 14)}</button>
        <button class="btn sm icon-only k-redo" data-act="redo" title="Redo (Ctrl+Y)">${icon("undo", 14)}</button>
        <button class="btn sm" data-act="surprise" title="A random look within this style">${icon("dice", 14)}<span>Surprise me</span></button>
        <button class="btn sm" data-act="save" title="Keep this look to come back to">${icon("save", 14)}<span>Save look</span></button>
        <button class="btn sm icon-only" data-act="export" title="Export: copy this look to share it">${icon("copy", 14)}</button>
        <button class="btn sm icon-only" data-act="import" title="Import a look">${icon("download", 14)}</button>
        <button class="btn sm icon-only danger" data-act="reset" title="Reset this style">${icon("refresh", 14)}</button>
      </div>
    </div>
    <div class="k-groups"></div>
    <div class="empty k-no-results" hidden>No option matches that.</div>
  </div>`);
  node.querySelector(".k-search input").placeholder = `Search ${OPTIONS.length} options…`;

  const gallery = node.querySelector(".style-gallery");
  for (const id of STYLE_IDS) gallery.appendChild(styleCard(id));
  node.insertBefore(presetsCard(), node.querySelector(".k-bar"));

  const groups = node.querySelector(".k-groups");
  groups.appendChild(groupCard({ id: "essentials", title: `${STYLES[r.id].name} essentials`, desc: "The options that shape this style the most", iconName: "bolt", keys: STYLES[r.id].quick, openByDefault: true }));
  for (const group of GROUPS) {
    if (!groupApplies(group, r.id)) continue;
    const keys = OPTIONS.filter((o) => o.group === group.id).map((o) => o.key);
    const card = groupCard({ id: group.id, title: group.title, desc: group.desc, iconName: group.icon, keys });
    card.dataset.search = `${group.title} ${group.desc}`.toLowerCase();
    groups.appendChild(card);
  }

  const search = node.querySelector(".k-search input");
  search.value = filterText;
  search.addEventListener("input", () => {
    filterText = search.value;
    applyFilter(node);
  });
  const act = (name) => node.querySelector(`[data-act="${name}"]`);
  act("changed").classList.toggle("toggled", changedOnly);
  act("changed").addEventListener("click", () => {
    changedOnly = !changedOnly;
    act("changed").classList.toggle("toggled", changedOnly);
    applyFilter(node);
  });
  act("undo").addEventListener("click", undo);
  act("redo").addEventListener("click", redo);
  act("surprise").addEventListener("click", surprise);
  act("save").addEventListener("click", saveLook);
  act("export").addEventListener("click", exportLook);
  act("import").addEventListener("click", importLook);
  act("reset").addEventListener("click", resetStyle);
  updaters.push(() => {
    act("undo").disabled = !undoStack.length;
    act("redo").disabled = !redoStack.length;
    applyFilter(node);
  });
  return node;
}

function refresh() {
  if (!section) return;
  const r = current();
  for (const update of updaters) update(r);
}

// Built again when the style changes (its essentials and groups differ).
let builtFor = null;
function rebuild() {
  if (!section) return;
  const id = current().id;
  if (builtFor !== id) {
    builtFor = id;
    const next = build();
    section.replaceWith(next);
    section = next;
  }
  refresh();
}

export function buildStyleSection() {
  section = build();
  builtFor = current().id;
  refresh();
  // Changes made elsewhere (another Settings page, Windows' dark mode...)
  // show here too.
  window.addEventListener("kessel-settings", () => {
    if (!previewing) rebuild();
  });
  document.addEventListener("keydown", (e) => {
    if (!section?.isConnected || !section.closest(".panel.active")) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && key === "z") {
      e.preventDefault();
      undo();
    } else if (e.ctrlKey && (key === "y" || (e.shiftKey && key === "z"))) {
      e.preventDefault();
      redo();
    }
  });
  return section;
}
