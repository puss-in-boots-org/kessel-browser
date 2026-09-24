import { icon } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { toast, formatRelativeTime, hostOf } from "./shared/api.js";
import { WALLPAPERS, setCustomWallpaper, clearCustomWallpaper, hasCustomWallpaper, wallpaperCss } from "./shared/glass.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const ACCENTS = ["#7c5cff", "#3b82f6", "#0ea5a4", "#f472b6", "#f97316", "#22c55e", "#e11d48", "#eab308"];

const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "search", label: "Search & Startup", icon: "search" },
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
  </div>`);

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
      ${settingRow({ title: "Restore tabs on launch", desc: "Reopen last session's tabs instead of a fresh one", controlHtml: switchHtml("restore-tabs", settings.restore_tabs) })}
    </div>
  </div>`);

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

  const restoreTabs = p.querySelector("#restore-tabs");
  restoreTabs.addEventListener("click", async () => {
    const next = await saveSettings({ restore_tabs: !restoreTabs.classList.contains("on") });
    restoreTabs.classList.toggle("on", next.restore_tabs);
  });

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
      ${settingRow({ title: "Vault auto-lock", desc: "Lock the password vault after this many minutes idle", controlHtml: `<input type="range" id="vault-timeout" min="1" max="60" step="1" /><span class="mono faint" id="vault-timeout-value"></span>` })}
      ${settingRow({ title: "Clear browsing history", desc: "Removes all recorded history permanently", controlHtml: `<button class="btn danger sm" id="clear-history-btn">Clear</button>` })}
    </div>
  </div>`);

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
  wireSetting("fp-toggle", "shields_fingerprinting", () => "Applies from the next page load");
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

  p.querySelector("#clear-history-btn").addEventListener("click", async () => {
    await invoke("clear_history");
    toast("History cleared");
  });

  return p;
}

function performancePanel(settings) {
  const p = el(`<div class="panel" id="panel-performance">
    <h2>Performance</h2>
    <p class="sub">Kessel gives each tab its own real webview -- background tabs cost real memory until this reclaims it.</p>

    <div class="setting-card">
      ${settingRow({
        title: "Discard inactive tabs",
        desc: "A background tab's webview is destroyed after sitting idle this long, and quietly recreated -- reloading the page from scratch -- if you switch back to it. Doesn't check for audio/video playing, so a tab making sound can still be discarded.",
        controlHtml: `<input type="range" id="discard-minutes" min="0" max="60" step="5" /><span class="mono faint" id="discard-minutes-value" style="min-width:52px;display:inline-block;text-align:right"></span>`,
      })}
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="desc">Settings and Passwords are never discarded (they're single-instance pages), and neither is whichever tab is currently active.</div></div></div>
    </div>
  </div>`);

  const slider = p.querySelector("#discard-minutes");
  const label = p.querySelector("#discard-minutes-value");
  const describe = (v) => (v === "0" || v === 0 ? "Never" : `${v} min`);
  slider.value = settings.discard_tabs_after_minutes;
  label.textContent = describe(slider.value);
  slider.addEventListener("input", () => (label.textContent = describe(slider.value)));
  slider.addEventListener("change", () => saveSettings({ discard_tabs_after_minutes: parseInt(slider.value, 10) }));

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
      const row = el(`<div class="list-row"><span class="lr-title">${item.title || item.url}</span><button class="btn ghost icon-only sm">${icon("trash", 13)}</button></div>`);
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
    const row = el(`<div class="list-row"><span class="lr-title">${b.title || b.url}</span><button class="btn ghost icon-only sm">${icon("trash", 13)}</button></div>`);
    row.querySelector("button").addEventListener("click", async () => {
      await invoke("remove_bookmark", { url: b.url });
      row.remove();
    });
    list.appendChild(row);
  }
  return p;
}

async function historyPanel() {
  const [history, closedTabs] = await Promise.all([invoke("get_history"), invoke("get_closed_tabs")]);
  const p = el(`<div class="panel" id="panel-history">
    <h2>History</h2>
    <p class="sub">Most recent visits first.</p>

    <div class="setting-card" id="recently-closed-card" style="display:none">
      <div class="setting-row"><div class="info"><div class="title">Recently closed tabs</div></div></div>
      <div class="list-panel" id="recently-closed-list"></div>
    </div>

    <div class="setting-card">
      <div class="list-panel" id="history-list" style="max-height:440px"></div>
      <div class="add-row"><button class="btn danger sm block" id="clear-history-btn-2">Clear all history</button></div>
    </div>
  </div>`);

  if (closedTabs.length) {
    p.querySelector("#recently-closed-card").style.display = "block";
    const closedList = p.querySelector("#recently-closed-list");
    for (const url of closedTabs) {
      const row = el(`<div class="list-row"><span class="lr-title">${url}</span><button class="btn ghost sm">Reopen</button></div>`);
      row.querySelector("button").addEventListener("click", async () => {
        await invoke("reopen_closed_tab_url", { url });
        toast("Reopened");
      });
      closedList.appendChild(row);
    }
  }

  const list = p.querySelector("#history-list");
  list.innerHTML = history.length ? "" : `<div class="empty">No history yet.</div>`;
  for (const h of history.slice(0, 300)) {
    const row = el(`<div class="list-row"><span class="lr-title">${h.title || h.url}</span><span class="lr-sub">${formatRelativeTime(h.visited_at)}</span></div>`);
    list.appendChild(row);
  }
  p.querySelector("#clear-history-btn-2").addEventListener("click", async () => {
    await invoke("clear_history");
    list.innerHTML = `<div class="empty">No history yet.</div>`;
    toast("History cleared");
  });
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
      const row = el(`<div class="list-row"><span class="lr-title">${name}</span><span class="lr-sub">${d.finished ? (d.success ? "Done" : "Failed") : "In progress"}</span></div>`);
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
  const version = await window.__TAURI__.app.getVersion().catch(() => "");
  return el(`<div class="panel" id="panel-about">
    <h2>About Kessel</h2>
    <p class="sub">A real, working custom browser.</p>
    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Version</div></div><div class="control mono muted">${version}</div></div>
      <div class="setting-row"><div class="info"><div class="title">Engine</div></div><div class="control muted">Tauri 2 + your OS's native WebView</div></div>
    </div>
    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="desc">Ad blocking works at the navigation level (blocking known ad/tracker domains outright) plus cosmetic hiding injected into every page. It cannot intercept individual sub-resource requests the way a browser-extension blocker can -- that hook isn't available for external sites in Tauri's current stable APIs.</div></div></div>
    </div>
  </div>`);
}

// --- Shell ------------------------------------------------------------

async function buildPanel(id, settings) {
  switch (id) {
    case "appearance": return appearancePanel(settings);
    case "search": return searchPanel(settings);
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
    item.addEventListener("click", () => showSection(section.id, currentSettings()));
    nav.appendChild(item);
  }

  const hash = location.hash.replace("#", "");
  await showSection(SECTIONS.some((s) => s.id === hash) ? hash : "appearance", settings);
});
