import { icon } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { toast, formatRelativeTime, hostOf, escapeHtml, keycapsHtml, keyLabel, confirmDialog } from "./shared/api.js";
import { WALLPAPERS, setCustomWallpaper, clearCustomWallpaper, hasCustomWallpaper, wallpaperCss } from "./shared/glass.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const ACCENTS = ["#7c5cff", "#3b82f6", "#0ea5a4", "#f472b6", "#f97316", "#22c55e", "#e11d48", "#eab308"];

const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "search", label: "Search & Startup", icon: "search" },
  { id: "tabs", label: "Tabs", icon: "tabs" },
  { id: "shortcuts", label: "Keyboard & Mouse", icon: "keyboard" },
  { id: "privacy", label: "Privacy & Security", icon: "shield" },
  { id: "performance", label: "Performance", icon: "bolt" },
  { id: "pinned", label: "Pinned Sites", icon: "pin" },
  { id: "bookmarks", label: "Bookmarks", icon: "bookmark" },
  { id: "history", label: "History", icon: "history" },
  { id: "downloads", label: "Downloads", icon: "download" },
  { id: "passwords", label: "Passwords", icon: "key" },
  { id: "import", label: "Import", icon: "arrowRight" },
  { id: "about", label: "About", icon: "bolt" },
];

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function settingRow({ title, desc, controlHtml }) {
  return `<div class="setting-row"><div class="info"><div class="title">${title}</div>${desc ? `<div class="desc">${desc}</div>` : ""}</div><div class="control">${controlHtml}</div></div>`;
}

function switchHtml(id, on) {
  return `<button class="switch ${on ? "on" : ""}" id="${id}" role="switch" aria-checked="${on}"></button>`;
}

// --- Panel builders ------------------------------------------------------

function appearancePanel(settings) {
  const p = el(`<div class="panel" id="panel-appearance">
    <h2>Appearance</h2>
    <p class="sub">Make Kessel look like yours.</p>

    <div class="setting-card">
      <div class="theme-options" id="theme-options"></div>
    </div>

    <div class="setting-card">
      <div class="accent-row" id="accent-row"></div>
    </div>

    <div class="setting-card">
      ${settingRow({ title: "Liquid Glass", desc: "Translucent iOS-style toolbar and new tab page over a wallpaper", controlHtml: switchHtml("glass-toggle", settings.glass_enabled) })}
      <div id="glass-options">
        <div class="wallpaper-row" id="wallpaper-row"></div>
        ${settingRow({ title: "Frost", desc: "How much the glass blurs what's behind it", controlHtml: `<input type="range" id="glass-blur" min="0" max="40" step="1" /><span class="mono faint" id="glass-blur-value"></span>` })}
        ${settingRow({ title: "Refraction", desc: "Bend the background at the edges of buttons and tabs, like real glass", controlHtml: switchHtml("glass-refraction", settings.glass_refraction) })}
      </div>
      ${settingRow({ title: "Bookmarks bar", desc: "Show bookmarks under the address bar", controlHtml: switchHtml("bookmarks-bar-toggle", settings.bookmarks_bar) })}
      ${settingRow({ title: "Home button", desc: "A button next to reload that opens your home page", controlHtml: switchHtml("home-button-toggle", settings.show_home_button !== false) })}
      <input type="file" id="wallpaper-file" accept="image/*" hidden />
    </div>

    <div class="setting-card" id="custom-colors-card" style="display:none">
      ${settingRow({ title: "Background", controlHtml: `<input type="color" class="accent-custom" id="custom-bg" />` })}
      ${settingRow({ title: "Surface", controlHtml: `<input type="color" class="accent-custom" id="custom-surface" />` })}
      ${settingRow({ title: "Text", controlHtml: `<input type="color" class="accent-custom" id="custom-text" />` })}
    </div>

    <div class="setting-card">
      ${settingRow({ title: "Interface size", desc: "Scale text and controls across the app", controlHtml: `<input type="range" id="font-scale" min="0.85" max="1.3" step="0.05" /><span class="mono faint" id="font-scale-value"></span>` })}
      ${settingRow({ title: "Reduce motion", desc: "Turn off non-essential animation", controlHtml: switchHtml("reduce-motion", settings.reduce_motion) })}
    </div>

    <div class="setting-card" id="zoom-card">
      ${settingRow({ title: "Page zoom", desc: "The size every site starts at. Zoom a site with Ctrl and + or −, or Ctrl and the mouse wheel, and Kessel keeps that size for the site.", controlHtml: `<select class="field" id="default-zoom" style="width:110px"></select>` })}
      <div class="list-panel" id="site-zoom-list"></div>
    </div>
  </div>`);

  const zoomSelect = p.querySelector("#default-zoom");
  for (const z of ZOOM_CHOICES) {
    const opt = document.createElement("option");
    opt.value = String(z);
    opt.textContent = `${Math.round(z * 100)}%`;
    zoomSelect.appendChild(opt);
  }
  zoomSelect.value = String(ZOOM_CHOICES.find((z) => Math.abs(z - (settings.default_zoom ?? 1)) < 0.001) ?? 1);
  zoomSelect.addEventListener("change", async () => {
    await saveSettings({ default_zoom: parseFloat(zoomSelect.value) });
    toast("Applies to pages you open from now on");
  });
  renderSiteZoom(p);

  const themeOptions = p.querySelector("#theme-options");
  for (const mode of ["dark", "light", "custom"]) {
    const sw = el(`<div class="theme-swatch ${settings.theme === mode ? "selected" : ""}" data-mode="${mode}">
      <div class="theme-preview ${mode}"></div>${mode[0].toUpperCase() + mode.slice(1)}
    </div>`);
    sw.addEventListener("click", async () => {
      const next = await saveSettings({ theme: mode });
      refreshAppearance(next);
    });
    themeOptions.appendChild(sw);
  }

  const accentRow = p.querySelector("#accent-row");
  for (const color of ACCENTS) {
    const sw = el(`<div class="accent-swatch ${settings.accent === color ? "selected" : ""}" data-color="${color}" style="background:${color}"></div>`);
    sw.addEventListener("click", async () => {
      const next = await saveSettings({ accent: color });
      refreshAppearance(next);
    });
    accentRow.appendChild(sw);
  }
  const customPicker = el(`<input type="color" class="accent-custom" value="${settings.accent}" title="Custom accent color" />`);
  customPicker.addEventListener("input", async (e) => {
    const next = await saveSettings({ accent: e.target.value });
    refreshAppearance(next);
  });
  accentRow.appendChild(customPicker);

  const bg = p.querySelector("#custom-bg");
  const surface = p.querySelector("#custom-surface");
  const text = p.querySelector("#custom-text");
  bg.value = settings.custom_bg;
  surface.value = settings.custom_surface;
  text.value = settings.custom_text;
  bg.addEventListener("input", () => saveSettings({ custom_bg: bg.value }));
  surface.addEventListener("input", () => saveSettings({ custom_surface: surface.value }));
  text.addEventListener("input", () => saveSettings({ custom_text: text.value }));
  p.querySelector("#custom-colors-card").style.display = settings.theme === "custom" ? "block" : "none";

  const fontScale = p.querySelector("#font-scale");
  const fontScaleValue = p.querySelector("#font-scale-value");
  fontScale.value = settings.font_scale;
  fontScaleValue.textContent = `${Math.round(settings.font_scale * 100)}%`;
  fontScale.addEventListener("input", () => {
    fontScaleValue.textContent = `${Math.round(fontScale.value * 100)}%`;
  });
  fontScale.addEventListener("change", () => saveSettings({ font_scale: parseFloat(fontScale.value) }));

  wireGlassSettings(p, settings);

  const reduceMotion = p.querySelector("#reduce-motion");
  reduceMotion.addEventListener("click", async () => {
    const next = await saveSettings({ reduce_motion: !reduceMotion.classList.contains("on") });
    reduceMotion.classList.toggle("on", next.reduce_motion);
  });

  return p;
}

const ZOOM_CHOICES = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

// Sites you zoomed, with their zoom -- remove one to put it back to the default.
async function renderSiteZoom(p) {
  const holder = p.querySelector("#site-zoom-list");
  const levels = Object.entries(await invoke("get_zoom_levels").catch(() => ({}))).sort(([a], [b]) => a.localeCompare(b));
  holder.innerHTML = levels.length ? "" : `<div class="empty" style="padding:14px">No sites with their own zoom yet.</div>`;
  holder.style.display = "";
  for (const [host, factor] of levels) {
    const row = el(`<div class="list-row"><span class="lr-title"></span><span class="lr-sub mono"></span><button class="btn ghost icon-only sm" title="Back to the default zoom">${icon("trash", 13)}</button></div>`);
    row.querySelector(".lr-title").textContent = host.replace(/^www\./, "");
    row.querySelector(".lr-sub").textContent = `${Math.round(factor * 100)}%`;
    row.querySelector("button").addEventListener("click", async () => {
      await invoke("remove_zoom_level", { host }).catch((err) => toast(String(err)));
      renderSiteZoom(p);
    });
    holder.appendChild(row);
  }
}

function wireToggle(p, id, key) {
  const btn = p.querySelector(`#${id}`);
  btn.addEventListener("click", async () => {
    const next = await saveSettings({ [key]: !btn.classList.contains("on") });
    btn.classList.toggle("on", !!next[key]);
    refreshAppearance(next);
  });
}

function renderWallpapers(p, settings) {
  const row = p.querySelector("#wallpaper-row");
  row.innerHTML = "";
  for (const [id, wp] of Object.entries(WALLPAPERS)) {
    const sw = el(`<div class="wallpaper-swatch ${settings.wallpaper === id ? "selected" : ""}" title="${wp.name}"><div class="wp-preview"></div><span>${wp.name}</span></div>`);
    sw.querySelector(".wp-preview").style.background = wp.css;
    sw.addEventListener("click", async () => {
      const next = await saveSettings({ wallpaper: id });
      renderWallpapers(p, next);
    });
    row.appendChild(sw);
  }

  // Your own image: click to pick one, click again (once chosen) to use it.
  const hasCustom = hasCustomWallpaper();
  const custom = el(`<div class="wallpaper-swatch ${settings.wallpaper === "custom" ? "selected" : ""}" title="Use your own image">
    <div class="wp-preview custom">${hasCustom ? "" : icon("plus", 16)}</div><span>${hasCustom ? "Your image" : "Choose…"}</span></div>`);
  if (hasCustom) custom.querySelector(".wp-preview").style.background = wallpaperCss({ wallpaper: "custom" });
  custom.addEventListener("click", async () => {
    if (hasCustom && settings.wallpaper !== "custom") {
      const next = await saveSettings({ wallpaper: "custom" });
      renderWallpapers(p, next);
    } else {
      p.querySelector("#wallpaper-file").click();
    }
  });
  row.appendChild(custom);

  if (hasCustom) {
    const remove = el(`<button class="btn ghost sm" title="Remove your image">${icon("trash", 14)}</button>`);
    remove.addEventListener("click", async () => {
      clearCustomWallpaper();
      const next = settings.wallpaper === "custom" ? await saveSettings({ wallpaper: "nightfall" }) : settings;
      renderWallpapers(p, next);
    });
    row.appendChild(remove);
  }
}

function wireGlassSettings(p, settings) {
  renderWallpapers(p, settings);

  p.querySelector("#wallpaper-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      await setCustomWallpaper(file);
      // Always re-save, even if "custom" was already selected, so every
      // open page repaints with the new image.
      const next = await saveSettings({ wallpaper: "custom" });
      renderWallpapers(p, next);
      toast("Wallpaper updated");
    } catch (err) {
      toast(err.message || String(err));
    }
  });

  const blur = p.querySelector("#glass-blur");
  const blurValue = p.querySelector("#glass-blur-value");
  blur.value = settings.glass_blur;
  blurValue.textContent = `${Math.round(settings.glass_blur)}px`;
  blur.addEventListener("input", () => {
    blurValue.textContent = `${blur.value}px`;
  });
  blur.addEventListener("change", () => saveSettings({ glass_blur: parseFloat(blur.value) }));

  wireToggle(p, "glass-toggle", "glass_enabled");
  wireToggle(p, "glass-refraction", "glass_refraction");
  wireToggle(p, "bookmarks-bar-toggle", "bookmarks_bar");
  wireToggle(p, "home-button-toggle", "show_home_button");
  p.querySelector("#glass-options").style.display = settings.glass_enabled ? "block" : "none";
}

function refreshAppearance(settings) {
  const p = document.getElementById("panel-appearance");
  if (!p) return;
  p.querySelectorAll(".theme-swatch").forEach((sw) => sw.classList.toggle("selected", sw.dataset.mode === settings.theme));
  p.querySelectorAll(".accent-swatch").forEach((sw) => {
    sw.classList.toggle("selected", (sw.dataset.color || "").toLowerCase() === settings.accent.toLowerCase());
  });
  p.querySelector("#custom-colors-card").style.display = settings.theme === "custom" ? "block" : "none";
  p.querySelector("#glass-options").style.display = settings.glass_enabled ? "block" : "none";
}

function searchPanel(settings) {
  const engines = { google: "Google", bing: "Bing", duckduckgo: "DuckDuckGo", brave: "Brave", ecosia: "Ecosia", startpage: "Startpage" };
  const p = el(`<div class="panel" id="panel-search">
    <h2>Search &amp; Startup</h2>
    <p class="sub">Where Kessel looks things up, and what it opens with.</p>

    <div class="setting-card">
      ${settingRow({ title: "Default search engine", controlHtml: `<select class="field" id="engine-select" style="width:170px"></select>` })}
      ${settingRow({ title: "Homepage", desc: "Opened by new tabs and the home button", controlHtml: `<input class="field" id="homepage-input" style="width:220px" placeholder="kessel://newtab" />` })}
      ${settingRow({ title: "Keep tabs when Kessel closes", desc: "Your windows and tabs come back the next time you open Kessel, instead of a fresh new-tab page", controlHtml: switchHtml("restore-tabs", settings.restore_tabs) })}
    </div>

    <div class="setting-card">
      ${settingRow({ title: "Search suggestions", desc: "Show your search engine's suggestions as you type in the address bar. What you type is sent to it -- never from a private window.", controlHtml: switchHtml("search-suggestions", settings.search_suggestions !== false) })}
      ${settingRow({ title: "Complete addresses as you type", desc: "Type “yout” and Kessel fills in youtube.com if you've been there; press Delete to keep what you typed", controlHtml: switchHtml("autocomplete-addresses", settings.autocomplete_addresses !== false) })}
      ${settingRow({ title: "Answers in the address bar", desc: "Calculator, unit and currency conversion, definitions, the time anywhere, and more -- right as you type", controlHtml: switchHtml("address-answers", settings.address_answers !== false) })}
    </div>
  </div>`);

  for (const [id, key] of [["search-suggestions", "search_suggestions"], ["autocomplete-addresses", "autocomplete_addresses"], ["address-answers", "address_answers"]]) {
    const btn = p.querySelector(`#${id}`);
    btn.addEventListener("click", async () => {
      const next = await saveSettings({ [key]: !btn.classList.contains("on") });
      btn.classList.toggle("on", next[key] !== false);
    });
  }

  const select = p.querySelector("#engine-select");
  for (const [key, name] of Object.entries(engines)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = settings.search_engine;
  select.addEventListener("change", () => saveSettings({ search_engine: select.value }));

  const homepage = p.querySelector("#homepage-input");
  homepage.value = settings.homepage;
  homepage.addEventListener("change", () => saveSettings({ homepage: homepage.value || "kessel://newtab" }));

  wireSwitch(p, "restore-tabs", "restore_tabs");

  return p;
}

// A switch bound to a setting -- kept in step when it changes elsewhere
// (the same switch in another section, or another Settings page).
// `defaultOn`: a setting that's on unless turned off.
function wireSwitch(panel, id, key, { defaultOn = false } = {}) {
  const btn = panel.querySelector(`#${id}`);
  const isOn = (s) => (defaultOn ? s[key] !== false : !!s[key]);
  btn.addEventListener("click", async () => {
    const next = await saveSettings({ [key]: !btn.classList.contains("on") });
    btn.classList.toggle("on", isOn(next));
    btn.setAttribute("aria-checked", String(isOn(next)));
  });
  window.addEventListener("kessel-settings", () => {
    const s = currentSettings();
    if (s) btn.classList.toggle("on", isOn(s));
  });
  return btn;
}

const GROUP_COLOR_VALUES = { grey: "#9aa0a6", blue: "#5b8def", red: "#ef5b5b", yellow: "#f2c14e", green: "#4fbf7f", pink: "#f06ab0", purple: "#a878f0", cyan: "#3fc5d4", orange: "#f59a42" };

async function tabsPanel(settings) {
  const p = el(`<div class="panel" id="panel-tabs">
    <h2>Tabs</h2>
    <p class="sub">How your tabs look, what hovering one shows, groups -- and keeping them when Kessel closes.</p>

    <div class="setting-card">
      ${settingRow({ title: "Keep tabs when Kessel closes", desc: "Your windows and tabs -- pinned tabs and tab groups too -- come back the next time you open Kessel. Tabs you weren't looking at come back asleep, so starting stays quick.", controlHtml: switchHtml("tabs-restore", settings.restore_tabs) })}
    </div>

    <div class="setting-card">
      ${settingRow({ title: "Tab layout", desc: "Along the top, or in a column beside the page (it can be collapsed to icons, and dragged wider)", controlHtml: `<div class="segmented" id="tab-layout"><button data-v="horizontal">Top</button><button data-v="vertical">Side</button></div>` })}
      ${settingRow({ title: "When the tab strip is full", desc: "Shrink tabs down to their icons, or keep their titles and scroll the strip (the mouse wheel scrolls it too)", controlHtml: `<select class="field" id="tab-overflow" style="width:170px"><option value="shrink">Shrink tabs</option><option value="scroll">Keep titles, scroll</option></select>` })}
      ${settingRow({ title: "Hover cards", desc: "Resting the mouse on a tab shows its title, site and state", controlHtml: switchHtml("hover-cards", settings.tab_hover_cards !== false) })}
      ${settingRow({ title: "Page preview in hover cards", desc: "A picture of the page, taken when you leave the tab", controlHtml: switchHtml("hover-preview", settings.hover_card_preview !== false) })}
      ${settingRow({ title: "Memory use in hover cards", desc: "How much memory and CPU the tab's page is using. Tabs using a lot get an orange ring.", controlHtml: switchHtml("hover-memory", settings.hover_card_memory !== false) })}
      ${settingRow({ title: "Show when a background tab changes", desc: "A dot on a tab whose page changed its title while you were elsewhere -- a new message, a finished upload", controlHtml: switchHtml("attention-dots", settings.tab_attention_dots !== false) })}
    </div>

    <div class="setting-card">
      ${settingRow({ title: "Group tabs from the same site", desc: "Tabs of a site you have more than one of go into a group of their own, automatically. Or right-click a tab: Group tabs by site.", controlHtml: switchHtml("auto-group", !!settings.auto_group_tabs) })}
      <div class="setting-row"><div class="info"><div class="title">Saved tab groups</div><div class="desc">Right-click a group's name, Save group: it stays on the bookmarks bar, to open again any time.</div></div></div>
      <div id="saved-groups"></div>
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="desc">Sleeping and paused background tabs, and how many tabs stay awake, are in <a href="#performance" id="to-performance">Performance</a>.</div></div></div>
    </div>
  </div>`);

  wireSwitch(p, "tabs-restore", "restore_tabs");
  wireSwitch(p, "hover-cards", "tab_hover_cards", { defaultOn: true });
  wireSwitch(p, "hover-preview", "hover_card_preview", { defaultOn: true });
  wireSwitch(p, "hover-memory", "hover_card_memory", { defaultOn: true });
  wireSwitch(p, "attention-dots", "tab_attention_dots", { defaultOn: true });
  wireSwitch(p, "auto-group", "auto_group_tabs");

  const layout = p.querySelector("#tab-layout");
  const showLayout = (v) => layout.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  showLayout(settings.tab_layout || "horizontal");
  layout.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    showLayout(b.dataset.v);
    await saveSettings({ tab_layout: b.dataset.v });
  });
  const overflow = p.querySelector("#tab-overflow");
  overflow.value = settings.tab_overflow || "shrink";
  overflow.addEventListener("change", () => saveSettings({ tab_overflow: overflow.value }));
  p.querySelector("#to-performance").addEventListener("click", (e) => {
    e.preventDefault();
    history.replaceState(null, "", "#performance");
    showSection("performance", currentSettings());
  });

  const renderSaved = (groups) => {
    const box = p.querySelector("#saved-groups");
    if (!groups.length) {
      box.innerHTML = `<div class="setting-row"><div class="info"><div class="desc faint">No saved groups yet</div></div></div>`;
      return;
    }
    box.innerHTML = "";
    for (const g of groups) {
      const row = el(`<div class="setting-row saved-group-row"><div class="info"><div class="title"><span class="group-dot"></span><span class="name"></span></div><div class="desc"></div></div><div class="control"><button class="btn danger sm">Delete</button></div></div>`);
      row.querySelector(".group-dot").style.background = GROUP_COLOR_VALUES[g.color] || GROUP_COLOR_VALUES.grey;
      row.querySelector(".name").textContent = g.name || "Unnamed group";
      row.querySelector(".desc").textContent = `${g.tabs.length} tab${g.tabs.length === 1 ? "" : "s"}: ${g.tabs.slice(0, 4).map((t) => t.title || hostOf(t.url)).join(", ")}${g.tabs.length > 4 ? "…" : ""}`;
      row.querySelector("button").addEventListener("click", () => invoke("delete_saved_group", { id: g.id }).catch((err) => toast(String(err))));
      box.appendChild(row);
    }
  };
  renderSaved((await invoke("get_saved_groups").catch(() => [])) || []);
  listen("saved-groups-changed", (event) => renderSaved(event.payload || []));

  return p;
}

async function privacyPanel(settings) {
  const [blockedCount, shields, lists] = await Promise.all([
    invoke("get_blocked_count").catch(() => 0),
    invoke("shields_status").catch(() => ({ engine: { rules: 0, lists_loaded: false }, lists: [] })),
    invoke("get_adblock_lists").catch(() => ({ custom: [], allow: [] })),
  ]);

  const p = el(`<div class="panel" id="panel-privacy">
    <h2>Privacy &amp; Security</h2>
    <p class="sub">Shields (ads, trackers, fingerprinting), browsing data, and the vault's auto-lock.</p>

    <div class="setting-card">
      ${settingRow({ title: "Shields", desc: "Block ads, trackers and fingerprinting on every site. Turn them off for one site from the shield in the address bar.", controlHtml: switchHtml("adblock-toggle", settings.adblock_enabled) })}
      ${settingRow({ title: "Blocked this session", desc: `<span id="rule-count"></span>`, controlHtml: `<span class="mono muted">${blockedCount}</span>` })}
    </div>

    <div class="setting-card">
      ${settingRow({ title: "Upgrade connections to HTTPS", desc: "Opens the secure version of sites, and falls back if a site doesn't have one", controlHtml: switchHtml("https-toggle", settings.shields_https_upgrade) })}
      ${settingRow({ title: "Remove tracking from links", desc: "Strips fbclid, gclid, utm_ and other tracking parameters from pages you open", controlHtml: switchHtml("strip-toggle", settings.shields_strip_tracking) })}
      ${settingRow({ title: "Block fingerprinting", desc: "Adds invisible noise to canvas, audio and hardware details so sites can't recognise your device (new pages)", controlHtml: switchHtml("fp-toggle", settings.shields_fingerprinting) })}
      ${settingRow({ title: "Browser tracking prevention", desc: "WebView2's built-in (Edge) protection, on top of the filter lists", controlHtml: `<select class="field" id="tp-select" style="width:130px"><option value="basic">Basic</option><option value="balanced">Balanced</option><option value="strict">Strict</option><option value="off">Off</option></select>` })}
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Filter lists</div><div class="desc">The same lists Brave and uBlock Origin use. Downloaded to this PC and refreshed every few days.</div></div><div class="control"><button class="btn sm" id="update-lists-btn">Update now</button></div></div>
      <div id="filter-lists"></div>
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Custom blocked domains</div><div class="desc">Always blocked, in addition to the filter lists</div></div></div>
      <div class="list-panel" id="custom-blocklist"></div>
      <div class="add-row"><input class="field" id="add-block-domain" placeholder="example.com" /><button class="btn sm" id="add-block-btn">Add</button></div>
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Sites with Shields down</div><div class="desc">Nothing is blocked on these sites</div></div></div>
      <div class="list-panel" id="allow-list"></div>
      <div class="add-row"><input class="field" id="add-allow-domain" placeholder="example.com" /><button class="btn sm" id="add-allow-btn">Add</button></div>
    </div>

    <div class="setting-card">
      ${settingRow({ title: "Clear browsing data", desc: "History, cookies and site data, cached files and more -- for the last hour or all of it", controlHtml: `<button class="btn sm" id="clear-data-btn">${icon("broom", 13)} Clear…</button>` })}
      ${settingRow({ title: "Keep history for", desc: "Visits older than this are forgotten automatically", controlHtml: `<select class="field" id="history-days" style="width:130px"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="0">Forever</option></select>` })}
      ${settingRow({ title: "Vault auto-lock", desc: "Lock the password vault after this many minutes idle", controlHtml: `<input type="range" id="vault-timeout" min="1" max="60" step="1" /><span class="mono faint" id="vault-timeout-value"></span>` })}
    </div>
  </div>`);

  p.querySelector("#clear-data-btn").addEventListener("click", () => openClearDataDialog());
  const historyDays = p.querySelector("#history-days");
  historyDays.value = String(settings.history_days ?? 90);
  if (!historyDays.value) historyDays.value = "90";
  historyDays.addEventListener("change", async () => {
    await saveSettings({ history_days: parseInt(historyDays.value, 10) });
    toast(historyDays.value === "0" ? "History is kept until you delete it" : "Older visits are removed the next time Kessel starts");
  });

  function wireSetting(id, key, message) {
    p.querySelector(`#${id}`).addEventListener("click", async () => {
      const btn = p.querySelector(`#${id}`);
      const next = await saveSettings({ [key]: !btn.classList.contains("on") });
      btn.classList.toggle("on", !!next[key]);
      if (message) toast(message(next[key]));
    });
  }
  wireSetting("adblock-toggle", "adblock_enabled", (on) => (on ? "Shields are on" : "Shields are off"));
  wireSetting("https-toggle", "shields_https_upgrade");
  wireSetting("strip-toggle", "shields_strip_tracking");
  wireSetting("fp-toggle", "shields_fingerprinting", () => "Applies to pages you open from now on");
  const tp = p.querySelector("#tp-select");
  tp.value = settings.shields_tracking_prevention || "balanced";
  tp.addEventListener("change", () => saveSettings({ shields_tracking_prevention: tp.value }).then(() => toast("Applies to tabs you open from now on")));

  // --- Filter lists ---
  const ago = (unix) => {
    if (!unix) return "not downloaded yet";
    const mins = Math.round((Date.now() / 1000 - unix) / 60);
    if (mins < 2) return "updated just now";
    if (mins < 90) return `updated ${mins} minutes ago`;
    const hours = Math.round(mins / 60);
    return hours < 36 ? `updated ${hours} hours ago` : `updated ${Math.round(hours / 24)} days ago`;
  };
  function renderLists(status) {
    p.querySelector("#rule-count").textContent = status.engine.lists_loaded
      ? `${status.engine.rules.toLocaleString()} rules loaded`
      : "Filter lists are downloading -- using a small built-in list until then";
    const holder = p.querySelector("#filter-lists");
    holder.innerHTML = "";
    for (const list of status.lists) {
      const detail = list.error ? `Couldn't update: ${list.error}` : `${list.description} · ${ago(list.updated_at)}`;
      const row = el(settingRow({ title: list.name, desc: detail, controlHtml: switchHtml(`list-${list.id}`, list.enabled) }));
      row.querySelector(".switch").addEventListener("click", async (e) => {
        const on = !e.currentTarget.classList.contains("on");
        const current = currentSettings()?.filter_lists || [];
        const next = on ? [...new Set([...current, list.id])] : current.filter((id) => id !== list.id);
        await saveSettings({ filter_lists: next });
        e.currentTarget.classList.toggle("on", on);
        toast(on ? `Adding ${list.name}…` : `${list.name} removed`);
      });
      holder.appendChild(row);
    }
  }
  renderLists(shields);
  listen("shields-lists-changed", async () => renderLists(await invoke("shields_status")));
  p.querySelector("#update-lists-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Updating…";
    try {
      renderLists(await invoke("shields_update_lists"));
      toast("Filter lists updated");
    } catch (err) {
      toast(String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = "Update now";
    }
  });

  function renderDomainList(container, items, removeCmd) {
    container.innerHTML = items.length ? "" : `<div class="empty">None yet.</div>`;
    for (const domain of items) {
      const row = el(`<div class="list-row"><span class="lr-title"></span><button class="btn ghost icon-only sm">${icon("trash", 13)}</button></div>`);
      row.querySelector(".lr-title").textContent = domain;
      row.querySelector("button").addEventListener("click", async () => {
        await invoke(removeCmd, { domain });
        const fresh = await invoke("get_adblock_lists");
        renderDomainList(container, removeCmd === "remove_custom_blocked_domain" ? fresh.custom : fresh.allow, removeCmd);
      });
      container.appendChild(row);
    }
  }
  const customEl = p.querySelector("#custom-blocklist");
  const allowEl = p.querySelector("#allow-list");
  renderDomainList(customEl, lists.custom, "remove_custom_blocked_domain");
  renderDomainList(allowEl, lists.allow, "remove_allowed_domain");

  p.querySelector("#add-block-btn").addEventListener("click", async () => {
    const input = p.querySelector("#add-block-domain");
    if (!input.value.trim()) return;
    await invoke("add_custom_blocked_domain", { domain: input.value.trim() });
    input.value = "";
    const fresh = await invoke("get_adblock_lists");
    renderDomainList(customEl, fresh.custom, "remove_custom_blocked_domain");
  });
  p.querySelector("#add-allow-btn").addEventListener("click", async () => {
    const input = p.querySelector("#add-allow-domain");
    if (!input.value.trim()) return;
    await invoke("add_allowed_domain", { domain: input.value.trim() });
    input.value = "";
    const fresh = await invoke("get_adblock_lists");
    renderDomainList(allowEl, fresh.allow, "remove_allowed_domain");
  });

  const vaultTimeout = p.querySelector("#vault-timeout");
  const vaultTimeoutValue = p.querySelector("#vault-timeout-value");
  vaultTimeout.value = settings.vault_lock_minutes;
  vaultTimeoutValue.textContent = `${settings.vault_lock_minutes}m`;
  vaultTimeout.addEventListener("input", () => (vaultTimeoutValue.textContent = `${vaultTimeout.value}m`));
  vaultTimeout.addEventListener("change", () => saveSettings({ vault_lock_minutes: parseInt(vaultTimeout.value, 10) }));

  return p;
}

// --- Clear browsing data (Ctrl+Shift+Del) ----------------------------------

const CLEAR_RANGES = [
  ["hour", "Last hour", 3600],
  ["day", "Last 24 hours", 86400],
  ["week", "Last 7 days", 7 * 86400],
  ["month", "Last 4 weeks", 28 * 86400],
  ["all", "All time", 0],
];

const CLEAR_KINDS = [
  ["history", "Browsing history", "Pages you visited, searches, and recently closed tabs and windows", true],
  ["downloads", "Download history", "The list of files you downloaded -- the files themselves stay", true],
  ["cookies", "Cookies and other site data", "Signs you out of most sites", true],
  ["cache", "Cached images and files", "Frees up space; some sites load a little slower the next time", true],
  ["autofill", "Autofill form data", "What you typed into forms. Your saved passwords stay in the vault", false],
  ["site_settings", "Site settings", "Each site's zoom, and permissions you gave sites", false],
];

const CLEAR_PREFS_KEY = "kessel.clearData";

function loadClearPrefs() {
  try {
    return JSON.parse(localStorage.getItem(CLEAR_PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

let clearDialogOpen = false;

async function openClearDataDialog({ fromShortcut = false } = {}) {
  if (clearDialogOpen) return;
  clearDialogOpen = true;
  const prefs = loadClearPrefs();
  const accounts = (await invoke("get_accounts").catch(() => null))?.accounts ?? [];
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal clear-modal" role="dialog" aria-modal="true" aria-labelledby="clear-title">
      <h3 id="clear-title">${icon("broom", 18)} Clear browsing data</h3>
      <label class="clear-range">Time range
        <select class="field" id="clear-range">${CLEAR_RANGES.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select>
      </label>
      <div class="clear-kinds">
        ${CLEAR_KINDS.map(
          ([id, label, desc, on]) => `<label class="clear-kind"><input type="checkbox" data-kind="${id}" ${(prefs[id] ?? on) ? "checked" : ""} />
            <span><b>${label}</b><small>${desc}</small></span></label>`,
        ).join("")}
        ${
          accounts.length
            ? `<label class="clear-kind"><input type="checkbox" data-kind="accounts" ${prefs.accounts ? "checked" : ""} />
            <span><b>Also for your other accounts</b><small>${escapeHtml(accounts.map((a) => a.name).join(", "))} -- otherwise only Main's</small></span></label>`
            : ""
        }
      </div>
      <p class="clear-note" id="clear-note"></p>
      <div class="clear-actions">
        <button class="btn ghost" id="clear-cancel">Cancel</button>
        <button class="btn primary" id="clear-go">Clear data</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("open"));
  const range = backdrop.querySelector("#clear-range");
  range.value = CLEAR_RANGES.some(([id]) => id === prefs.range) ? prefs.range : "hour";
  const go = backdrop.querySelector("#clear-go");
  const note = backdrop.querySelector("#clear-note");
  const boxes = [...backdrop.querySelectorAll("input[type=checkbox]")];
  const chosen = () => Object.fromEntries(boxes.map((b) => [b.dataset.kind, b.checked]));
  const refresh = () => {
    const c = chosen();
    go.disabled = !CLEAR_KINDS.some(([id]) => c[id]);
  };
  boxes.forEach((b) => b.addEventListener("change", refresh));
  refresh();

  const close = () => {
    clearDialogOpen = false;
    backdrop.classList.remove("open");
    document.removeEventListener("keydown", onKey, true);
    setTimeout(() => backdrop.remove(), 200);
    if (location.hash === "#clear") history.replaceState(null, "", "#privacy");
  };
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#clear-cancel").addEventListener("click", close);
  go.addEventListener("click", async () => {
    const c = chosen();
    const seconds = CLEAR_RANGES.find(([id]) => id === range.value)[2];
    const request = { ...c, from: seconds ? Math.floor(Date.now() / 1000) - seconds : null };
    try {
      localStorage.setItem(CLEAR_PREFS_KEY, JSON.stringify({ ...c, range: range.value }));
    } catch {}
    go.disabled = true;
    go.innerHTML = `<span class="spinner"></span> Clearing…`;
    // Kessel's own pages keep a few things in their site storage (your
    // wallpaper, site icons, these choices): keep those across the clear.
    const kept = c.cookies ? Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])) : null;
    try {
      const report = await invoke("clear_browsing_data", { request });
      if (kept) for (const [k, v] of Object.entries(kept)) localStorage.setItem(k, v);
      if (report.failed.length) {
        note.textContent = `Couldn't clear everything: ${report.failed.join("; ")}`;
        go.disabled = false;
        go.textContent = "Try again";
        return;
      }
      close();
      toast("Browsing data cleared");
    } catch (err) {
      if (kept) for (const [k, v] of Object.entries(kept)) localStorage.setItem(k, v);
      note.textContent = String(err);
      go.disabled = false;
      go.textContent = "Clear data";
    }
  });
  (fromShortcut ? range : go).focus();
}

// --- Keyboard & mouse -----------------------------------------------------------

// A shortcut on its own key (no Ctrl or Alt) would stop you typing that
// key, so only these can go without one.
const LONE_KEYS = /^(F\d{1,2}|Browser\w+|Pause|Escape|Insert)$/;

let recordingFor = null; // { command, done(keys | null) }

async function keyboardPanel(settings) {
  const p = el(`<div class="panel" id="panel-shortcuts">
    <h2>Keyboard &amp; Mouse</h2>
    <p class="sub">Change any shortcut: click <b>+</b> and press the keys. Shortcuts marked <span class="always-tag">always</span> work even on sites that use the same keys themselves.</p>

    <div class="setting-card">
      ${settingRow({ title: "Ctrl + click opens links in the background", desc: "Off: the new tab comes to the front. Ctrl + Shift + click does the other one.", controlHtml: switchHtml("ctrl-bg", settings.ctrl_click_background) })}
      ${settingRow({ title: "Middle-click opens links in the background", desc: "Shift + middle-click does the other one", controlHtml: switchHtml("middle-bg", settings.middle_click_background) })}
    </div>

    <div class="setting-card">
      <div class="setting-row">
        <input class="field" id="shortcut-search" type="search" placeholder="Search shortcuts" style="max-width:320px" />
        <div class="control"><button class="btn sm" id="shortcuts-reset-all">Reset all</button></div>
      </div>
      <div id="shortcut-list"></div>
    </div>
  </div>`);

  for (const [id, key] of [["ctrl-bg", "ctrl_click_background"], ["middle-bg", "middle_click_background"]]) {
    const btn = p.querySelector(`#${id}`);
    btn.addEventListener("click", async () => {
      const next = await saveSettings({ [key]: !btn.classList.contains("on") });
      btn.classList.toggle("on", !!next[key]);
    });
  }

  const search = p.querySelector("#shortcut-search");
  search.addEventListener("input", () => filterShortcuts(p, search.value));
  p.querySelector("#shortcuts-reset-all").addEventListener("click", async () => {
    if (!(await confirmDialog("Put every shortcut back to Kessel's defaults?", "Reset all"))) return;
    await saveSettings({ shortcuts: {} });
    await renderShortcuts(p);
    toast("Shortcuts reset");
  });
  await renderShortcuts(p);
  return p;
}

// A re-render that came in while keys were being recorded: done once that's
// over (drawing the list anew mid-recording would throw away its chip).
let renderPending = false;

async function renderShortcuts(p) {
  const commands = await invoke("get_commands").catch(() => []);
  if (recordingFor) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const list = p.querySelector("#shortcut-list");
  list.innerHTML = "";
  let category = null;
  for (const c of commands) {
    if (c.category !== category) {
      category = c.category;
      list.appendChild(el(`<div class="shortcut-category">${escapeHtml(category)}</div>`));
    }
    const custom = JSON.stringify(c.keys) !== JSON.stringify(c.default_keys);
    const row = el(`<div class="setting-row shortcut-row" data-search="${escapeHtml(`${c.label} ${c.category} ${c.keys.map(keyLabel).join(" ")}`.toLowerCase())}">
      <div class="info"><div class="title">${escapeHtml(c.label)}${c.reserved ? ` <span class="always-tag" title="Works even on sites that use these keys themselves">always</span>` : ""}</div></div>
      <div class="control shortcut-keys"></div>
    </div>`);
    const keysEl = row.querySelector(".shortcut-keys");
    for (const k of c.keys) {
      const chip = el(`<span class="key-chip">${keycapsHtml(k)}<button class="chip-x" title="Remove this shortcut">${icon("close", 10)}</button></span>`);
      chip.querySelector("button").addEventListener("click", () => setKeys(p, commands, c, c.keys.filter((x) => x !== k)));
      keysEl.appendChild(chip);
    }
    if (!c.keys.length) keysEl.appendChild(el(`<span class="faint" style="font-size:12px">No shortcut</span>`));
    const add = el(`<button class="btn ghost icon-only sm add-key" title="Add a shortcut">${icon("plus", 14)}</button>`);
    add.addEventListener("click", () => recordFor(p, commands, c, add));
    keysEl.appendChild(add);
    if (custom) {
      const reset = el(`<button class="btn ghost sm" title="Back to ${escapeHtml(c.default_keys.map(keyLabel).join(", ") || "no shortcut")}">Reset</button>`);
      reset.addEventListener("click", () => setKeys(p, commands, c, null));
      keysEl.appendChild(reset);
    }
    list.appendChild(row);
  }
  filterShortcuts(p, p.querySelector("#shortcut-search").value);
}

function filterShortcuts(p, text) {
  const needle = text.trim().toLowerCase();
  for (const row of p.querySelectorAll(".shortcut-row")) row.hidden = !!needle && !row.dataset.search.includes(needle);
  for (const header of p.querySelectorAll(".shortcut-category")) {
    let next = header.nextElementSibling;
    let any = false;
    while (next && !next.classList.contains("shortcut-category")) {
      if (!next.hidden) any = true;
      next = next.nextElementSibling;
    }
    header.hidden = !any;
  }
}

// Saves command `c`'s keys (null = its defaults again).
async function setKeys(p, commands, c, keys, alsoChange = []) {
  const shortcuts = { ...(currentSettings()?.shortcuts || {}) };
  const store = (command, list) => {
    if (list === null || JSON.stringify(list) === JSON.stringify(command.default_keys)) delete shortcuts[command.id];
    else shortcuts[command.id] = list;
  };
  store(c, keys);
  for (const [other, list] of alsoChange) store(other, list);
  await saveSettings({ shortcuts });
  await renderShortcuts(p);
}

async function recordFor(p, commands, c, button) {
  if (recordingFor) recordingFor.done(null);
  const chip = el(`<span class="key-chip recording">Press a shortcut… <small>Esc to cancel</small></span>`);
  button.replaceWith(chip);
  const keys = await new Promise((resolve) => {
    const unlistenP = listen("shortcut-recorded", (event) => finish(event.payload.cancelled ? null : event.payload.keys));
    const onBlur = () => finish(null);
    window.addEventListener("blur", onBlur);
    function finish(value) {
      if (!recordingFor) return;
      recordingFor = null;
      window.removeEventListener("blur", onBlur);
      unlistenP.then((un) => un());
      invoke("record_shortcut", { on: false }).catch(() => {});
      resolve(value);
    }
    recordingFor = { done: finish };
    invoke("record_shortcut", { on: true }).catch((err) => {
      toast(String(err));
      finish(null);
    });
  });
  chip.replaceWith(button);
  if (renderPending) await renderShortcuts(p);
  if (!keys) return;
  const parts = keys.split("+");
  const key = parts[parts.length - 1];
  const hasCtrlOrAlt = parts.includes("Ctrl") || parts.includes("Alt");
  if (!hasCtrlOrAlt && !LONE_KEYS.test(key)) {
    toast(`Add Ctrl or Alt: ${keyLabel(keys)} on its own would stop you typing it`);
    return;
  }
  // Ctrl+Alt is AltGr on many keyboards (it types @, [, \ and € here).
  if (parts.includes("Ctrl") && parts.includes("Alt") && !LONE_KEYS.test(key)) {
    toast("Ctrl + Alt shortcuts would get in the way of AltGr -- try Ctrl + Shift instead");
    return;
  }
  if (c.keys.includes(keys)) return;
  const owner = commands.find((o) => o.id !== c.id && o.keys.includes(keys));
  if (owner) {
    const ok = await confirmDialog(`${keyLabel(keys)} already does “${owner.label}”. Use it for “${c.label}” instead?`, "Use it");
    if (!ok) return;
    await setKeys(p, commands, c, [...c.keys, keys], [[owner, owner.keys.filter((k) => k !== keys)]]);
  } else {
    await setKeys(p, commands, c, [...c.keys, keys]);
  }
  toast(`${c.label}: ${keyLabel(keys)}`);
}

function performancePanel(settings) {
  const p = el(`<div class="panel" id="panel-performance">
    <h2>Performance</h2>
    <p class="sub">Kessel gives each tab its own real webview. A tab in the background is always slowed down, like in any browser; these save more for the tabs you haven't looked at in a while.</p>

    <div class="setting-card">
      ${settingRow({
        title: "Pause background tabs",
        desc: "After this long in the background a tab's page is paused: its scripts stop until you come back (it doesn't reload). Tabs playing sound keep going.",
        controlHtml: `<select class="field" id="freeze-minutes" style="width:150px">${[0, 1, 2, 5, 10, 15, 30, 60].map((m) => `<option value="${m}">${m ? `After ${m} min` : "Never"}</option>`).join("")}</select>`,
      })}
      ${settingRow({
        title: "Put inactive tabs to sleep",
        desc: "After sitting idle this long a background tab is closed to free its memory, and quietly reloaded when you switch back to it. Tabs playing sound never sleep.",
        controlHtml: `<input type="range" id="discard-minutes" min="0" max="60" step="5" /><span class="mono faint" id="discard-minutes-value" style="min-width:52px;display:inline-block;text-align:right"></span>`,
      })}
      ${settingRow({
        title: "Tabs kept awake at most",
        desc: "Past this many open tabs, the ones you looked at longest ago go to sleep",
        controlHtml: `<select class="field" id="max-awake" style="width:150px">${[0, 3, 5, 8, 10, 15, 20, 30, 50].map((n) => `<option value="${n}">${n ? `${n} tabs` : "No limit"}</option>`).join("")}</select>`,
      })}
      ${settingRow({ title: "Save memory in background tabs", desc: "Ask the engine to use less memory for tabs you're not looking at", controlHtml: switchHtml("reduce-memory", settings.reduce_background_memory !== false) })}
    </div>

    <div class="setting-card">
      ${settingRow({ title: "Never pause or put to sleep", desc: "Sites that must keep running in the background -- a chat, a music player", controlHtml: `<input class="field" id="never-sleep-input" style="width:200px" placeholder="e.g. music.youtube.com" /><button class="btn sm" id="never-sleep-add">Add</button>` })}
      <div class="site-list" id="never-sleep-list"></div>
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="desc">Never paused or put to sleep either: the tab you're on, tabs playing sound, and Kessel's own pages (Settings, History, Downloads...). Right-click a tab to put it to sleep yourself, or use "Put other tabs to sleep" in the address bar.</div></div></div>
    </div>
  </div>`);

  const slider = p.querySelector("#discard-minutes");
  const label = p.querySelector("#discard-minutes-value");
  const describe = (v) => (v === "0" || v === 0 ? "Never" : `${v} min`);
  slider.value = settings.discard_tabs_after_minutes;
  label.textContent = describe(slider.value);
  slider.addEventListener("input", () => (label.textContent = describe(slider.value)));
  slider.addEventListener("change", () => saveSettings({ discard_tabs_after_minutes: parseInt(slider.value, 10) }));

  const freeze = p.querySelector("#freeze-minutes");
  freeze.value = String(settings.freeze_tabs_after_minutes ?? 5);
  freeze.addEventListener("change", () => saveSettings({ freeze_tabs_after_minutes: parseInt(freeze.value, 10) }));
  const maxAwake = p.querySelector("#max-awake");
  maxAwake.value = String(settings.max_awake_tabs ?? 0);
  maxAwake.addEventListener("change", () => saveSettings({ max_awake_tabs: parseInt(maxAwake.value, 10) }));
  wireSwitch(p, "reduce-memory", "reduce_background_memory", { defaultOn: true });

  // Sites that never sleep: a site per chip.
  const list = p.querySelector("#never-sleep-list");
  const input = p.querySelector("#never-sleep-input");
  const render = (sites) => {
    list.innerHTML = sites.length ? "" : `<span class="faint" style="font-size:12px">None yet</span>`;
    for (const site of sites) {
      const chip = el(`<span class="site-chip"><span></span><button title="Remove">${icon("close", 11)}</button></span>`);
      chip.querySelector("span").textContent = site;
      chip.querySelector("button").addEventListener("click", async () => {
        const next = await saveSettings({ never_sleep_sites: (currentSettings().never_sleep_sites || []).filter((s) => s !== site) });
        render(next.never_sleep_sites || []);
      });
      list.appendChild(chip);
    }
  };
  const add = async () => {
    const site = input.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (!site || !/^[a-z0-9.-]+(:\d+)?$/.test(site)) {
      if (input.value.trim()) toast("That doesn't look like a site -- e.g. music.youtube.com");
      return;
    }
    const sites = currentSettings().never_sleep_sites || [];
    input.value = "";
    if (sites.includes(site)) return;
    const next = await saveSettings({ never_sleep_sites: [...sites, site] });
    render(next.never_sleep_sites || []);
  };
  p.querySelector("#never-sleep-add").addEventListener("click", add);
  input.addEventListener("keydown", (e) => e.key === "Enter" && add());
  render(settings.never_sleep_sites || []);

  return p;
}

async function pinnedPanel() {
  const pinned = await invoke("get_pinned");
  const p = el(`<div class="panel" id="panel-pinned">
    <h2>Pinned Sites</h2>
    <p class="sub">Shown as quick-launch icons in the left control panel.</p>
    <div class="setting-card">
      <div class="list-panel" id="pinned-list-settings"></div>
      <div class="add-row"><input class="field" id="pin-url" placeholder="https://example.com" /><input class="field" id="pin-title" placeholder="Label (optional)" style="max-width:140px" /><button class="btn sm" id="pin-add-btn">Pin</button></div>
    </div>
  </div>`);

  const list = p.querySelector("#pinned-list-settings");
  function render(items) {
    list.innerHTML = items.length ? "" : `<div class="empty">Nothing pinned yet.</div>`;
    for (const item of items) {
      const row = el(`<div class="list-row"><span class="lr-title">${escapeHtml(item.title || item.url)}</span><button class="btn ghost icon-only sm">${icon("trash", 13)}</button></div>`);
      row.querySelector("button").addEventListener("click", async () => {
        await invoke("remove_pinned", { id: item.id });
        render((await invoke("get_pinned")));
      });
      list.appendChild(row);
    }
  }
  render(pinned);

  p.querySelector("#pin-add-btn").addEventListener("click", async () => {
    const urlInput = p.querySelector("#pin-url");
    const titleInput = p.querySelector("#pin-title");
    if (!urlInput.value.trim()) return;
    const url = /^https?:\/\//i.test(urlInput.value.trim()) ? urlInput.value.trim() : `https://${urlInput.value.trim()}`;
    await invoke("add_pinned", { url, title: titleInput.value.trim() || hostOf(url) });
    urlInput.value = "";
    titleInput.value = "";
    render(await invoke("get_pinned"));
  });

  return p;
}

async function bookmarksPanel() {
  const bookmarks = await invoke("get_bookmarks");
  const p = el(`<div class="panel" id="panel-bookmarks">
    <h2>Bookmarks</h2>
    <p class="sub">${bookmarks.length} saved.</p>
    <div class="setting-card"><div class="list-panel" id="bookmarks-list-settings" style="max-height:520px"></div></div>
  </div>`);
  const list = p.querySelector("#bookmarks-list-settings");
  list.innerHTML = bookmarks.length ? "" : `<div class="empty">No bookmarks yet.</div>`;
  for (const b of bookmarks) {
    const row = el(`<div class="list-row"><span class="lr-title">${escapeHtml(b.title || b.url)}</span><button class="btn ghost icon-only sm">${icon("trash", 13)}</button></div>`);
    row.querySelector("button").addEventListener("click", async () => {
      await invoke("remove_bookmark", { url: b.url });
      row.remove();
    });
    list.appendChild(row);
  }
  return p;
}

async function historyPanel() {
  const [history, closedTabs] = await Promise.all([
    invoke("query_history", { limit: 30 }).catch(() => []),
    invoke("get_closed_tabs").catch(() => []),
  ]);
  const p = el(`<div class="panel" id="panel-history">
    <h2>History</h2>
    <p class="sub">Your latest visits. The full history -- search, by day, by site -- is on its own page.</p>

    <div class="setting-card">
      ${settingRow({ title: "All history", desc: "Search it, delete pages or whole sites (Ctrl+H)", controlHtml: `<button class="btn primary sm" id="open-history-btn">${icon("history", 13)} Open history</button>` })}
    </div>

    <div class="setting-card" id="recently-closed-card" style="display:none">
      <div class="setting-row"><div class="info"><div class="title">Recently closed tabs</div></div></div>
      <div class="list-panel" id="recently-closed-list"></div>
    </div>

    <div class="setting-card">
      <div class="list-panel" id="history-list" style="max-height:440px"></div>
      <div class="add-row"><button class="btn danger sm block" id="clear-history-btn-2">Clear browsing data…</button></div>
    </div>
  </div>`);
  p.querySelector("#open-history-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://history" }));

  if (closedTabs.length) {
    p.querySelector("#recently-closed-card").style.display = "block";
    const closedList = p.querySelector("#recently-closed-list");
    for (const url of closedTabs) {
      const row = el(`<div class="list-row"><span class="lr-title">${escapeHtml(url)}</span><button class="btn ghost sm">Reopen</button></div>`);
      row.querySelector("button").addEventListener("click", async () => {
        await invoke("reopen_closed_tab_url", { url });
        toast("Reopened");
      });
      closedList.appendChild(row);
    }
  }

  const list = p.querySelector("#history-list");
  list.innerHTML = history.length ? "" : `<div class="empty">No history yet.</div>`;
  for (const h of history) {
    const row = el(`<div class="list-row"><span class="lr-title">${escapeHtml(h.title || h.url)}</span><span class="lr-sub">${formatRelativeTime(h.visited_at)}</span></div>`);
    row.title = h.url;
    list.appendChild(row);
  }
  p.querySelector("#clear-history-btn-2").addEventListener("click", () => openClearDataDialog());
  return p;
}

async function downloadsPanel() {
  const downloads = await invoke("get_downloads");
  const p = el(`<div class="panel" id="panel-downloads">
    <h2>Downloads</h2>
    <p class="sub">${downloads.length} total.</p>
    <div class="setting-card">
      <div class="list-panel" id="downloads-list-settings" style="max-height:440px"></div>
      <div class="add-row">
        <button class="btn sm" id="open-folder-btn">${icon("folder", 13)} Open folder</button>
        <button class="btn danger sm" id="clear-downloads-btn">Clear list</button>
      </div>
    </div>
  </div>`);
  const list = p.querySelector("#downloads-list-settings");
  function render(items) {
    list.innerHTML = items.length ? "" : `<div class="empty">No downloads yet.</div>`;
    for (const d of items) {
      const name = d.path.split(/[\\/]/).pop();
      const row = el(`<div class="list-row"><span class="lr-title">${escapeHtml(name)}</span><span class="lr-sub">${d.finished ? (d.success ? "Done" : "Failed") : "In progress"}</span></div>`);
      list.appendChild(row);
    }
  }
  render(downloads);
  p.querySelector("#open-folder-btn").addEventListener("click", () => invoke("open_downloads_folder"));
  p.querySelector("#clear-downloads-btn").addEventListener("click", async () => {
    await invoke("clear_downloads");
    render([]);
  });
  return p;
}

function passwordsPanel(settings) {
  const p = el(`<div class="panel" id="panel-passwords">
    <h2>Passwords</h2>
    <p class="sub">Kessel's built-in password manager keeps a locally encrypted vault, protected by a master password and optional two-factor confirmation.</p>
    <div class="setting-card">
      <div class="setting-row">
        <div class="info"><div class="title">Open password manager</div><div class="desc">Set up or unlock your vault in its own secure tab</div></div>
        <div class="control"><button class="btn primary sm" id="open-vault-btn">${icon("key", 14)} Open</button></div>
      </div>
    </div>
    <div class="setting-card">
      ${settingRow({
        title: "Offer to autofill saved passwords",
        desc: "Shows a small “fill saved password” chip when a page has a login form matching a saved site. Nothing is ever filled without you clicking it, and the match is checked against the page's real address, not anything the page claims about itself.",
        controlHtml: switchHtml("autofill-toggle", settings.vault_autofill_enabled),
      })}
    </div>
    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="desc">Encrypted with AES-256-GCM using a key derived from your master password via Argon2id. The master password itself is never stored. Two-factor (TOTP) adds a second, time-based code check on unlock.</div></div></div>
    </div>
  </div>`);
  p.querySelector("#open-vault-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://passwords" }));
  const autofillToggle = p.querySelector("#autofill-toggle");
  autofillToggle.addEventListener("click", async () => {
    const next = await saveSettings({ vault_autofill_enabled: !autofillToggle.classList.contains("on") });
    autofillToggle.classList.toggle("on", next.vault_autofill_enabled);
    toast(next.vault_autofill_enabled ? "Autofill offers enabled" : "Autofill offers disabled");
  });
  return p;
}

// Moves bookmarks, Speed Dial / New Tab shortcuts, cookies and passwords
// over from another browser on this PC (see src-tauri/src/import.rs). Only
// counts ever come back from Rust -- cookie values and passwords never reach
// this page. The one exception is a password CSV you pick yourself, which is
// parsed here and handed straight to the vault.
async function importPanel() {
  const p = el(`<div class="panel" id="panel-import">
    <h2>Import</h2>
    <p class="sub">Bring your bookmarks, Speed Dial, sign-ins and passwords over from another browser.</p>
    <div id="import-sources"><div class="setting-card"><div class="setting-row"><div class="info"><div class="desc">Looking for browsers…</div></div></div></div></div>
  </div>`);

  const [sources, vault] = await Promise.all([
    invoke("detect_browsers").catch(() => []),
    invoke("vault_status").catch(() => ({ initialized: false, unlocked: false })),
  ]);
  // Passwords land in the encrypted vault, which must be open to write to.
  const vaultNote = !vault.initialized
    ? "Create a password vault first (Passwords page), then come back."
    : !vault.unlocked
      ? "Unlock your password vault first (Passwords page), then come back."
      : "Saved into your encrypted password vault.";
  const holder = p.querySelector("#import-sources");
  holder.innerHTML = "";
  if (!sources.length) {
    holder.appendChild(el(`<div class="setting-card"><div class="setting-row"><div class="info"><div class="title">No supported browser found</div><div class="desc">Kessel can import from Opera GX, Opera, Brave and Chrome on this PC.</div></div></div></div>`));
  }
  for (const src of sources) holder.appendChild(importCard(src, vault, vaultNote));
  holder.appendChild(csvImportCard(vault, vaultNote));
  return p;
}

function importCard(src, vault, vaultNote) {
  if (src.blocked) {
    return el(`<div class="setting-card">${settingRow({ title: src.name, desc: src.blocked, controlHtml: "" })}</div>`);
  }
  const isOpera = src.browser.startsWith("Opera");
  const speedLabel = isOpera ? "Speed Dial" : "New Tab shortcuts";
  const speedDesc = isOpera || src.speed_dial
    ? `${src.speed_dial} sites, added to your pinned sites`
    : "None pinned (only shortcuts you added yourself are saved, not most-visited ones)";
  // Chrome's app-bound encryption: only Chrome itself can read its newer
  // cookies and passwords -- say so up front instead of failing silently.
  const cookieDesc = src.app_bound
    ? `${src.browser} locks most of its cookies with app-bound encryption that only ${src.browser} itself can read, so few or none will come over -- you may need to sign in again.`
    : "Stay signed in to your sites. Decrypted on this PC only and saved straight into Kessel.";
  const passwordDesc = src.app_bound
    ? `${src.passwords} saved logins, but ${src.browser} locks them the same way. Use ${src.browser}'s "Export passwords" and the file import below instead.`
    : `${src.passwords} saved logins. ${vaultNote}`;
  const card = el(`<div class="setting-card">
    ${settingRow({ title: src.name, desc: src.running ? `Close ${src.browser} first so its cookies can be read.` : "Pick what to bring over. Things you already have in Kessel are skipped.", controlHtml: "" })}
    ${settingRow({ title: "Bookmarks", desc: `${src.bookmarks} from the bookmarks bar and other bookmarks`, controlHtml: switchHtml("imp-bookmarks", src.bookmarks > 0) })}
    ${settingRow({ title: speedLabel, desc: speedDesc, controlHtml: switchHtml("imp-speed", src.speed_dial > 0) })}
    ${settingRow({ title: "Cookies", desc: cookieDesc, controlHtml: switchHtml("imp-cookies", !src.app_bound) })}
    ${settingRow({ title: "Passwords", desc: passwordDesc, controlHtml: switchHtml("imp-passwords", src.passwords > 0 && vault.unlocked && !src.app_bound) })}
    <div class="add-row" style="justify-content:space-between;align-items:center">
      <span class="faint" id="imp-result" style="font-size:12px"></span>
      <button class="btn primary sm" id="imp-go">Import from ${src.name}</button>
    </div>
  </div>`);
  for (const sw of card.querySelectorAll(".switch")) {
    sw.addEventListener("click", () => sw.classList.toggle("on"));
  }
  const go = card.querySelector("#imp-go");
  const result = card.querySelector("#imp-result");
  go.addEventListener("click", async () => {
    const choice = {
      source: src.id,
      bookmarks: card.querySelector("#imp-bookmarks").classList.contains("on"),
      speed_dial: card.querySelector("#imp-speed").classList.contains("on"),
      cookies: card.querySelector("#imp-cookies").classList.contains("on"),
      passwords: card.querySelector("#imp-passwords").classList.contains("on"),
    };
    if (!choice.bookmarks && !choice.speed_dial && !choice.cookies && !choice.passwords) return;
    go.disabled = true;
    result.textContent = "Importing…";
    try {
      const r = await invoke("import_from_browser", { choice });
      const locked = (n) => (n ? `, ${n} locked by ${src.browser}` : "");
      const parts = [];
      if (choice.bookmarks) parts.push(`${r.bookmarks_added} bookmarks${r.bookmarks_existing ? ` (${r.bookmarks_existing} already here)` : ""}`);
      if (choice.speed_dial) parts.push(`${r.speed_dial_added} ${speedLabel.toLowerCase()}${r.speed_dial_existing ? ` (${r.speed_dial_existing} already here)` : ""}`);
      if (choice.cookies) parts.push(r.cookie_error ? `cookies failed: ${r.cookie_error}` : `${r.cookies_imported} cookies (${r.cookies_skipped} expired or not transferable${locked(r.cookies_app_bound)})`);
      if (choice.passwords) parts.push(r.password_error ? `passwords failed: ${r.password_error}` : `${r.passwords_added} passwords${r.passwords_existing ? ` (${r.passwords_existing} already saved)` : ""}${r.passwords_app_bound ? ` -- ${r.passwords_app_bound} locked, use the file import below` : ""}`);
      result.textContent = `Imported ${parts.join(", ")}.`;
      toast(r.cookie_error || r.password_error ? "Import finished with a problem" : "Import complete");
    } catch (err) {
      result.textContent = String(err);
    } finally {
      go.disabled = false;
    }
  });
  return card;
}

// --- Passwords from an exported CSV file -------------------------------------

function csvImportCard(vault, vaultNote) {
  const card = el(`<div class="setting-card">
    ${settingRow({
      title: "Passwords from a file",
      desc: `For browsers that lock their passwords (like Chrome): in Chrome open Google Password Manager → Settings → Export passwords; Brave, Edge and Firefox can export the same kind of .csv file. ${vaultNote} Delete the exported file afterwards -- it holds your passwords in plain text.`,
      controlHtml: `<button class="btn sm" id="csv-pick" ${vault.unlocked ? "" : "disabled"}>Choose .csv file…</button>`,
    })}
    <div class="add-row" style="padding-top:0;border-top:none"><span class="faint" id="csv-result" style="font-size:12px"></span></div>
    <input type="file" id="csv-file" accept=".csv,text/csv" hidden />
  </div>`);
  const file = card.querySelector("#csv-file");
  const result = card.querySelector("#csv-result");
  card.querySelector("#csv-pick").addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const picked = file.files[0];
    file.value = "";
    if (!picked) return;
    result.textContent = "Importing…";
    try {
      const logins = loginsFromCsv(await picked.text());
      const [added, existing, skipped] = await invoke("vault_import_csv", { source: picked.name, logins });
      result.textContent = `Imported ${added} passwords${existing ? `, ${existing} already saved` : ""}${skipped ? `, ${skipped} skipped (not a website or no password)` : ""}. You can delete ${picked.name} now.`;
      toast("Passwords imported");
    } catch (err) {
      result.textContent = err?.message || String(err);
    }
  });
  return card;
}

// Minimal RFC 4180 CSV reader: quoted fields may contain commas, quotes
// ("") and line breaks -- all of which real passwords and notes do.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[++i];
      else quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f !== ""));
}

// Chrome/Brave/Edge export name,url,username,password,note; Firefox uses
// url,username,password,... too, with other exporters varying the names.
function loginsFromCsv(text) {
  const [header = [], ...rows] = parseCsv(text.replace(/^﻿/, ""));
  const column = (...names) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const url = column("url", "origin", "website", "login_uri");
  const user = column("username", "login", "user", "login_username");
  const pass = column("password", "login_password");
  if (url < 0 || pass < 0) throw new Error("This doesn't look like a browser password export (it has no url and password columns).");
  return rows.map((r) => ({ url: r[url] || "", username: user >= 0 ? r[user] || "" : "", password: r[pass] || "" }));
}

async function aboutPanel() {
  const info = await invoke("about_info").catch(() => ({}));
  const row = (title, value) => `<div class="setting-row"><div class="info"><div class="title">${title}</div></div><div class="control muted about-value">${escapeHtml(value || "")}</div></div>`;
  const p = el(`<div class="panel" id="panel-about">
    <h2>About Kessel</h2>
    <p class="sub">A real, working custom browser.</p>
    <div class="setting-card">
      ${row("Version", info.version ? `Kessel ${info.version}` : "")}
      ${row("Engine", info.engine ? `Microsoft Edge WebView2 ${info.engine}` : "Microsoft Edge WebView2")}
      ${row("Built with", info.tauri ? `Tauri ${info.tauri}` : "Tauri 2")}
      ${row("Profile", info.profile)}
      ${row("Profile folder", info.profile_dir)}
    </div>
    <div class="setting-card">
      ${settingRow({ title: "Help and keyboard shortcuts", desc: "Everything Kessel can do, and how (F1)", controlHtml: `<button class="btn sm" id="open-help-btn">${icon("help", 13)} Open help</button>` })}
    </div>
    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="desc">Shields block ads and trackers with the same filter lists Brave and uBlock Origin use, on every request a page makes, and hide the empty spaces ads leave behind.</div></div></div>
    </div>
  </div>`);
  p.querySelector("#open-help-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://help" }));
  return p;
}

// --- Shell ------------------------------------------------------------

async function buildPanel(id, settings) {
  switch (id) {
    case "appearance": return appearancePanel(settings);
    case "search": return searchPanel(settings);
    case "tabs": return await tabsPanel(settings);
    case "shortcuts": return await keyboardPanel(settings);
    case "privacy": return await privacyPanel(settings);
    case "performance": return performancePanel(settings);
    case "pinned": return await pinnedPanel();
    case "bookmarks": return await bookmarksPanel();
    case "history": return await historyPanel();
    case "downloads": return await downloadsPanel();
    case "passwords": return passwordsPanel(settings);
    case "import": return await importPanel();
    case "about": return await aboutPanel();
    default: return el(`<div class="panel"></div>`);
  }
}

async function showSection(id, settings) {
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.id === id));
  const content = document.getElementById("settings-content");
  const existing = document.getElementById(`panel-${id}`);
  if (existing) {
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    existing.classList.add("active");
    return;
  }
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const panel = await buildPanel(id, settings);
  panel.classList.add("active");
  content.appendChild(panel);
}

window.addEventListener("DOMContentLoaded", async () => {
  const settings = await initTheme();

  const nav = document.getElementById("nav-items");
  for (const section of SECTIONS) {
    const item = el(`<div class="nav-item" data-id="${section.id}">${icon(section.icon, 15)}<span>${section.label}</span></div>`);
    item.addEventListener("click", () => {
      history.replaceState(null, "", `#${section.id}`);
      showSection(section.id, currentSettings());
    });
    nav.appendChild(item);
  }

  // kessel://settings/<section> opens at that section (settings.html#<section>);
  // kessel://settings/clear is Privacy with Clear browsing data open.
  async function followHash() {
    const hash = location.hash.replace("#", "");
    if (hash === "clear") {
      await showSection("privacy", currentSettings());
      openClearDataDialog({ fromShortcut: true });
      return;
    }
    await showSection(SECTIONS.some((s) => s.id === hash) ? hash : "appearance", currentSettings());
  }
  await followHash();
  window.addEventListener("hashchange", followHash);

  // Shortcuts changed elsewhere (another Settings, or a reset) show here too.
  listen("settings-changed", () => {
    const panel = document.getElementById("panel-shortcuts");
    if (panel && !recordingFor) renderShortcuts(panel);
  });
});
