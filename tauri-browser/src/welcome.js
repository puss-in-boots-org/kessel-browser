// kessel://welcome: the first-run setup. A brand-new profile opens on it
// (setup.rs); Settings can run it again. It looks at the PC, suggests how
// hard Kessel should work, a look, colours (the desktop wallpaper's, if you
// like), how tabs and search behave, and a privacy level -- then saves
// everything at once. Nothing changes until "Finish"; the page itself shows
// the look as you pick it.

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings, previewSettings, beginPreview, endPreview, desktopWallpaper, imageSwatches } from "./shared/theme.js";
import { toast, escapeHtml, ENGINES } from "./shared/api.js";
import { STYLES, styleState, resolveStyle } from "./shared/styles.js";
import { WALLPAPERS, wallpaperCss, setCustomWallpaper, hasCustomWallpaper } from "./shared/glass.js";
import { paletteFromSwatches } from "./shared/wallpaper-theme.js";
import { describePc, recommendPerformance, recommendStyle, recommendDensity, PERFORMANCE, PRIVACY, SETUP_STYLES, setupPatch, prettyGpu } from "./shared/setup-profiles.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// --- What the PC is like ------------------------------------------------------------

function browserFacts() {
  let gpu = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    gpu = gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : "";
  } catch {}
  let touch = false;
  try {
    touch = window.matchMedia("(pointer: coarse)").matches;
  } catch {}
  return { gpu, touch, screen: { w: screen.width, h: screen.height } };
}

let pc = describePc();
let desktop = null; // {id, url} of the Windows wallpaper
let desktopColours = null;

// --- The answers --------------------------------------------------------------------

const answers = {
  performance: "balanced",
  style: "instrument",
  colours: "style",
  mode: "dark",
  showDesktop: false,
  density: "normal",
  search_engine: "google",
  tab_layout: "horizontal",
  restore_tabs: false,
  privacy: "standard",
};
const recommended = {};

// The look as chosen so far, shown on this page only (saved at Finish).
let previewing = false;
function preview() {
  const s = currentSettings();
  if (!s) return;
  if (!previewing) {
    beginPreview();
    previewing = true;
  }
  const patch = setupPatch(s, answers, styleState(s).all);
  previewSettings({ ui_style: patch.ui_style, ui_custom: patch.ui_custom, features: { ...s.features, ui_density: patch.features.ui_density } });
}

// --- Steps ------------------------------------------------------------------------

const STEPS = [
  { id: "hello", label: "Welcome", render: renderHello },
  { id: "speed", label: "Speed", render: renderSpeed },
  { id: "look", label: "Look", render: renderLook },
  { id: "colours", label: "Colours", render: renderColours },
  { id: "browsing", label: "Browsing", render: renderBrowsing },
  { id: "privacy", label: "Privacy", render: renderPrivacy },
  { id: "done", label: "Done", render: renderDone },
];
let at = 0;

function show(index) {
  at = Math.max(0, Math.min(STEPS.length - 1, index));
  const step = STEPS[at];
  $("steps").innerHTML = STEPS.map((_, i) => `<i class="${i <= at ? "done" : ""}"></i>`).join("");
  $("step-label").textContent = at === 0 || at === STEPS.length - 1 ? "" : `Step ${at} of ${STEPS.length - 2} · ${step.label}`;
  const main = $("main");
  main.innerHTML = "";
  const node = el(`<section class="step active"></section>`);
  step.render(node);
  main.appendChild(node);
  const last = at === STEPS.length - 1;
  $("back").style.visibility = at === 0 || last ? "hidden" : "";
  $("skip").style.visibility = last ? "hidden" : "";
  $("next").innerHTML = at === 0 ? `Let's go ${icon("arrowRight", 14)}` : at === STEPS.length - 2 ? `${icon("check", 14)} Finish` : last ? `Start browsing ${icon("arrowRight", 14)}` : `Next ${icon("arrowRight", 14)}`;
  $("hint").textContent = at === 0 ? "About a minute. You can change everything later in Settings." : "";
  window.scrollTo({ top: 0 });
  main.querySelector(".choice.selected, .choice")?.focus({ preventScroll: true });
}

// A row of big cards; `pick(id)` when one's chosen.
function choiceGrid(items, selected, pick, { className = "" } = {}) {
  const grid = el(`<div class="choices ${className}"></div>`);
  for (const item of items) {
    const card = el(`<button class="choice ${item.id === selected ? "selected" : ""}" data-id="${item.id}">
      <span class="check">${icon("check", 13)}</span>
      ${item.top || ""}
      <span class="name">${escapeHtml(item.name)}${item.badge || ""}</span>
      ${item.tag ? `<span class="tag">${escapeHtml(item.tag)}</span>` : ""}
      ${item.points ? `<ul>${item.points.map((p) => `<li>${icon("check", 12)}<span>${escapeHtml(p)}</span></li>`).join("")}</ul>` : ""}
    </button>`);
    card.addEventListener("click", () => {
      grid.querySelectorAll(".choice").forEach((c) => c.classList.toggle("selected", c === card));
      pick(item.id);
    });
    grid.appendChild(card);
  }
  return grid;
}

const recBadge = (yes) => (yes ? ` <span class="pill">Suggested</span>` : "");

function spec(iconName, value, label) {
  return `<div class="spec"><span class="ico">${icon(iconName, 16)}</span><div><b title="${escapeHtml(value)}">${escapeHtml(value)}</b><small>${escapeHtml(label)}</small></div></div>`;
}

function renderHello(node) {
  const gpu = prettyGpu(pc.gpu);
  node.innerHTML = `
    <h1>Welcome to Kessel</h1>
    <p class="lead">Let's set Kessel up for this PC. It had a look at what you're running and will suggest what suits it best &mdash; just pick, or keep the suggestions and go.</p>
    <div class="section-title">Your PC</div>
    <div class="specs">
      ${pc.cpu || pc.threads ? spec("activity", pc.cpu || `${pc.threads} threads`, pc.cpu && pc.threads ? `Processor · ${pc.threads} threads` : "Processor") : ""}
      ${pc.memoryGB ? spec("layers", `${Math.round(pc.memoryGB)} GB`, "Memory") : ""}
      ${gpu ? spec("gpu", gpu, pc.softwareGpu ? "Graphics · drawing in software" : "Graphics") : ""}
      ${pc.screen ? spec("window", `${pc.screen.w} × ${pc.screen.h}`, pc.touch ? "Screen · touch" : "Screen") : ""}
      ${spec("power", pc.battery ? "Laptop" : "Desktop", pc.battery ? (pc.onBattery ? "Running on battery now" : "Plugged in") : "No battery")}
    </div>`;
}

function renderSpeed(node) {
  const rec = recommendPerformance(pc);
  node.innerHTML = `<h2>How hard should Kessel work?</h2><p class="lead">Kessel can rest tabs you aren't looking at, so the one you are stays fast and your PC stays cool. Pick what fits how you use it.</p>`;
  node.appendChild(
    choiceGrid(
      Object.entries(PERFORMANCE).map(([id, p]) => ({ id, name: p.label, badge: recBadge(id === rec.id), tag: p.tagline, points: p.points })),
      answers.performance,
      (id) => {
        answers.performance = id;
        // A lighter setting suggests a lighter look, if you haven't picked one.
        if (!touched.style) answers.style = recommendStyle(pc, id);
      },
    ),
  );
  node.appendChild(el(`<p class="why">${icon("sparkle", 14)}<span>${escapeHtml(rec.why)}</span></p>`));
}

const touched = {};

function miniWindow(id) {
  const v = resolveStyle(currentSettings() || {}, id).values;
  return `<div class="mini" style="background:${v.bg}">
    <div class="bar" style="background:${v.chromeBg}"><i class="on" style="background:${v.tabActiveBg}"></i><i style="background:${v.surface2}"></i><em style="background:${v.addressBg}"></em></div>
    <div class="page" style="background:${v.surface}"><b style="background:${v.text}"></b><s style="background:${v.textDim}"></s><s style="background:${v.textDim};width:52%"></s><u style="background:${v.accent}"></u></div>
  </div>`;
}

function renderLook(node) {
  const rec = recommendStyle(pc, answers.performance);
  node.innerHTML = `<h2>Pick a look</h2><p class="lead">The shape of the toolbar, tabs and menus. Every style can be tuned down to the last pixel later, and there are more under Settings &rarr; Appearance.</p>`;
  node.appendChild(
    choiceGrid(
      SETUP_STYLES.filter((id) => STYLES[id]).map((id) => ({
        id,
        name: STYLES[id].name,
        badge: recBadge(id === rec) + (id === "glass" && (pc.softwareGpu || answers.performance === "light") ? ` <span class="pill soft">Heavier on graphics</span>` : ""),
        tag: shortTagline(STYLES[id].tagline),
        top: miniWindow(id),
      })),
      answers.style,
      (id) => {
        answers.style = id;
        touched.style = true;
        preview();
      },
    ),
  );
}

const shortTagline = (t) => String(t || "").split(/ -- |: /)[0];

function wallTile(id, name, css, { add = false } = {}) {
  const tile = el(`<button class="choice wall ${answers.colours === id ? "selected" : ""}" data-id="${id}">
    <span class="check">${icon("check", 13)}</span>
    <div class="pic ${add ? "add" : ""}">${add ? icon("plus", 18) : ""}</div>
    <div class="cap">${escapeHtml(name)}</div>
  </button>`);
  if (css) tile.querySelector(".pic").style.background = css;
  return tile;
}

function swatchRow(hexes) {
  return `<div class="swatches">${(hexes || []).map((h) => `<i style="background:${h}"></i>`).join("")}</div>`;
}

function renderColours(node) {
  node.innerHTML = `<h2>Colours</h2><p class="lead">Kessel can take its colours from a wallpaper &mdash; not just one accent, but the background, panels, toolbar, tabs, text and links &mdash; so it fits right in. Or keep the style's own colours.</p>`;
  const select = (id) => {
    answers.colours = id;
    node.querySelectorAll(".choice").forEach((c) => c.classList.toggle("selected", c.dataset.id === id));
    node.querySelector("#mode-line").hidden = id !== "style";
    node.querySelector("#desktop-line").hidden = id !== "desktop";
    preview();
  };

  // The desktop's wallpaper, first: what makes Kessel feel at home.
  const desk = el(`<button class="choice desktop-choice ${answers.colours === "desktop" ? "selected" : ""}" data-id="desktop" ${desktop ? "" : "disabled"}>
    <span class="check">${icon("check", 13)}</span>
    <div class="pic">${desktop ? "" : icon("window", 22)}</div>
    <div class="body">
      <span class="name">Match my desktop${recBadge(!!desktop)}</span>
      <span class="tag">${desktop ? "Kessel takes on your Windows wallpaper's colours, and changes with it when you change the wallpaper." : "Kessel couldn't read a desktop wallpaper on this PC (a plain colour, or a slideshow it can't see)."}</span>
      ${desktopColours ? swatchRow(desktopColours) : ""}
    </div>
  </button>`);
  if (desktop?.url) desk.querySelector(".pic").style.backgroundImage = `url("${desktop.url}")`;
  if (desktop) desk.addEventListener("click", () => select("desktop"));
  node.appendChild(desk);

  node.appendChild(el(`<div class="section-title">Or one of Kessel's wallpapers, behind the toolbar too</div>`));
  const walls = el(`<div class="walls"></div>`);
  for (const [id, w] of Object.entries(WALLPAPERS)) {
    const tile = wallTile(id, w.name, w.css);
    tile.addEventListener("click", () => select(id));
    walls.appendChild(tile);
  }
  const own = wallTile("custom", hasCustomWallpaper() ? "Your picture" : "Your own picture…", hasCustomWallpaper() ? wallpaperCss({ wallpaper: "custom" }) : null, { add: !hasCustomWallpaper() });
  own.addEventListener("click", () => {
    if (hasCustomWallpaper() && answers.colours !== "custom") select("custom");
    else $("own-picture").click();
  });
  walls.appendChild(own);
  const own0 = resolveStyle({ ui_style: answers.style, ui_custom: { [answers.style]: { mode: answers.mode } } }).values;
  const style = wallTile("style", "The style's own", `linear-gradient(135deg, ${own0.bg} 50%, ${own0.accent} 50%)`);
  style.addEventListener("click", () => select("style"));
  walls.appendChild(style);
  node.appendChild(walls);
  ownPicked = () => {
    show(at);
    select("custom");
  };

  const modeLine = el(`<div class="option-line" id="mode-line" ${answers.colours === "style" ? "" : "hidden"}><div><div class="t">Dark or light</div><div class="d">The style's own colours, in</div></div>
    <div class="segmented">${[["dark", "Dark"], ["light", "Light"], ["system", "Follow Windows"]].map(([id, label]) => `<button data-mode="${id}" class="${answers.mode === id ? "active" : ""}">${label}</button>`).join("")}</div></div>`);
  modeLine.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      answers.mode = b.dataset.mode;
      modeLine.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      preview();
    }),
  );
  node.appendChild(modeLine);

  const deskLine = el(`<div class="option-line" id="desktop-line" ${answers.colours === "desktop" ? "" : "hidden"}><div><div class="t">Show my desktop picture behind the toolbar too</div><div class="d">Softly blurred, so it sits quietly behind the tabs. Off keeps the bars solid, in the wallpaper's colours</div></div>
    <button class="switch ${answers.showDesktop ? "on" : ""}" role="switch" aria-checked="${answers.showDesktop}"></button></div>`);
  const sw = deskLine.querySelector(".switch");
  sw.addEventListener("click", () => {
    answers.showDesktop = !answers.showDesktop;
    sw.classList.toggle("on", answers.showDesktop);
    sw.setAttribute("aria-checked", String(answers.showDesktop));
  });
  node.appendChild(deskLine);
}

let ownPicked = () => {};
$("own-picture").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    await setCustomWallpaper(file);
    ownPicked();
  } catch (err) {
    toast(String(err.message || err));
  }
});

function renderBrowsing(node) {
  const recDensity = recommendDensity(pc);
  node.innerHTML = `<h2>Browsing</h2><p class="lead">Where you search, where your tabs go, and how big things are.</p>
    <div class="section-title">Search with</div>`;
  const engines = el(`<div class="engines"></div>`);
  for (const [id, e] of Object.entries(ENGINES)) {
    const b = el(`<button class="engine ${answers.search_engine === id ? "selected" : ""}">${escapeHtml(e.name)}</button>`);
    b.addEventListener("click", () => {
      answers.search_engine = id;
      engines.querySelectorAll(".engine").forEach((x) => x.classList.toggle("selected", x === b));
    });
    engines.appendChild(b);
  }
  node.appendChild(engines);

  node.appendChild(el(`<div class="section-title">Tabs</div>`));
  const wide = pc.screen && pc.screen.w / pc.screen.h >= 2;
  node.appendChild(
    choiceGrid(
      [
        { id: "horizontal", name: "Along the top", badge: recBadge(!wide), tag: "Like most browsers. Tabs shrink to their icons when there are many." },
        { id: "vertical", name: "Down the side", badge: recBadge(wide), tag: "Full titles, however many tabs you open. Great on wide screens." },
      ],
      answers.tab_layout,
      (id) => (answers.tab_layout = id),
    ),
  );

  const size = el(`<div class="option-line"><div><div class="t">Size</div><div class="d">Compact fits more page; Touch is big enough for a finger</div></div>
    <div class="segmented">${[["compact", "Compact"], ["normal", "Normal"], ["touch", "Touch"]].map(([id, label]) => `<button data-d="${id}" class="${answers.density === id ? "active" : ""}">${label}${id === recDensity && id !== "normal" ? `<span class="rec">· suggested</span>` : ""}</button>`).join("")}</div></div>`);
  size.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      answers.density = b.dataset.d;
      size.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      preview();
    }),
  );
  node.appendChild(size);

  const restore = el(`<div class="option-line"><div><div class="t">Reopen my tabs when Kessel starts</div><div class="d">Pick up where you left off, instead of a fresh new tab</div></div>
    <button class="switch ${answers.restore_tabs ? "on" : ""}" role="switch" aria-checked="${answers.restore_tabs}"></button></div>`);
  const sw = restore.querySelector(".switch");
  sw.addEventListener("click", () => {
    answers.restore_tabs = !answers.restore_tabs;
    sw.classList.toggle("on", answers.restore_tabs);
    sw.setAttribute("aria-checked", String(answers.restore_tabs));
  });
  node.appendChild(restore);
}

function renderPrivacy(node) {
  node.innerHTML = `<h2>Privacy</h2><p class="lead">Shields block ads and trackers on every site with the same lists Brave and uBlock Origin use. How strict should they be?</p>`;
  node.appendChild(
    choiceGrid(
      Object.entries(PRIVACY).map(([id, p]) => ({ id, name: p.label, badge: recBadge(id === "standard"), tag: p.tagline, points: p.points })),
      answers.privacy,
      (id) => (answers.privacy = id),
    ),
  );
  node.appendChild(el(`<p class="why">${icon("shield", 14)}<span>You can loosen Shields for any one site from the shield in the address bar.</span></p>`));
}

function coloursLabel() {
  if (answers.colours === "desktop") return answers.showDesktop ? "Your desktop's colours and picture" : "Your desktop wallpaper's colours";
  if (answers.colours === "style") return { dark: "Dark", light: "Light", system: "Follows Windows" }[answers.mode];
  if (answers.colours === "custom") return "Your picture's colours";
  return `${WALLPAPERS[answers.colours]?.name || "Wallpaper"} colours`;
}

function renderDone(node) {
  node.innerHTML = `<div class="done-mark">${icon("check", 30)}</div>
    <h1>You're all set</h1>
    <p class="lead">Here's what Kessel is set to. Everything's in Settings, which you can search, and you can run this setup again from there.</p>
    <div class="summary">
      ${spec("bolt", PERFORMANCE[answers.performance].label, "Speed")}
      ${spec("palette", STYLES[answers.style]?.name || answers.style, "Look")}
      ${spec("sun", coloursLabel(), "Colours")}
      ${spec("search", ENGINES[answers.search_engine]?.name || answers.search_engine, "Search")}
      ${spec("tabs", answers.tab_layout === "vertical" ? "Down the side" : "Along the top", "Tabs")}
      ${spec("shield", PRIVACY[answers.privacy].label, "Shields")}
    </div>
    <div class="option-line"><div><div class="t">Coming from another browser?</div><div class="d">Bring over bookmarks, passwords, history and open tabs from Chrome, Edge, Brave, Opera, Vivaldi or Firefox</div></div>
      <button class="btn" id="import">${icon("arrowRight", 13)} Import</button></div>`;
  node.querySelector("#import").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://settings/import" }).catch(() => {}));
}

// --- Saving -------------------------------------------------------------------------

async function finish() {
  const fresh = (await invoke("get_settings").catch(() => null)) || currentSettings() || {};
  if (answers.colours === "desktop" && answers.showDesktop && desktop) {
    try {
      const full = desktop.url ? desktop : await desktopWallpaper();
      const blob = await (await fetch(full.url)).blob();
      await setCustomWallpaper(new File([blob], "desktop", { type: blob.type }));
    } catch {
      answers.showDesktop = false;
      toast("Couldn't use the desktop picture behind the toolbar; its colours are still used");
    }
  }
  const patch = setupPatch(fresh, answers, styleState(fresh).all);
  await saveSettings({ ...fresh, ...patch });
  if (previewing) {
    endPreview();
    previewing = false;
  }
}

async function skip() {
  const fresh = (await invoke("get_settings").catch(() => null)) || currentSettings() || {};
  if (previewing) {
    endPreview();
    previewing = false;
  }
  await saveSettings({ ...fresh, features: { ...(fresh.features || {}), setup_done: true } }).catch(() => {});
  location.replace("newtab.html");
}

$("next").addEventListener("click", async () => {
  if (at === STEPS.length - 1) return location.replace("newtab.html");
  if (at === STEPS.length - 2) {
    const btn = $("next");
    btn.disabled = true;
    try {
      await finish();
    } catch (e) {
      toast(`Couldn't save: ${e}`);
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
  }
  show(at + 1);
});
$("back").addEventListener("click", () => show(at - 1));
$("skip").addEventListener("click", skip);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.target.closest("button, input")) $("next").click();
  if (e.key === "Escape") skip();
});

// --- Start ----------------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  const settings = await initTheme();
  $("brand").innerHTML = `${icon("logo", 20)}<span>Kessel</span>`;
  const [profile, desk] = await Promise.all([invoke("pc_profile").catch(() => ({})), desktopWallpaper().catch(() => null)]);
  pc = describePc(profile, browserFacts());
  desktop = desk?.url ? desk : null;
  if (desktop) {
    const swatches = await imageSwatches(desktop.url);
    desktopColours = swatches?.length ? paletteFromSwatches(swatches)?.colours || null : null;
  }

  // The suggestions, as the starting answers.
  const perf = recommendPerformance(pc).id;
  Object.assign(recommended, { performance: perf, style: recommendStyle(pc, perf), density: recommendDensity(pc) });
  answers.performance = perf;
  answers.style = recommended.style;
  answers.density = recommended.density;
  answers.colours = desktop ? "desktop" : "style";
  answers.search_engine = ENGINES[settings?.search_engine] ? settings.search_engine : "google";
  answers.tab_layout = settings?.tab_layout === "vertical" ? "vertical" : "horizontal";
  answers.restore_tabs = !!settings?.restore_tabs;
  answers.mode = resolveStyle(settings || {}).values.mode === "light" ? "light" : "dark";
  show(0);
  // The suggested look straight away, on this page.
  preview();
});
