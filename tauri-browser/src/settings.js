import { icon } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { toast, formatRelativeTime, hostOf } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;

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

  const reduceMotion = p.querySelector("#reduce-motion");
  reduceMotion.addEventListener("click", async () => {
    const next = await saveSettings({ reduce_motion: !reduceMotion.classList.contains("on") });
    reduceMotion.classList.toggle("on", next.reduce_motion);
  });

  return p;
}

function refreshAppearance(settings) {
  const p = document.getElementById("panel-appearance");
  if (!p) return;
  p.querySelectorAll(".theme-swatch").forEach((sw) => sw.classList.toggle("selected", sw.dataset.mode === settings.theme));
  p.querySelectorAll(".accent-swatch").forEach((sw) => {
    sw.classList.toggle("selected", (sw.dataset.color || "").toLowerCase() === settings.accent.toLowerCase());
  });
  p.querySelector("#custom-colors-card").style.display = settings.theme === "custom" ? "block" : "none";
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
  const blockedCount = await invoke("get_blocked_count").catch(() => 0);
  const builtinCount = await invoke("builtin_blocklist_count").catch(() => 0);
  const lists = await invoke("get_adblock_lists").catch(() => ({ custom: [], allow: [] }));

  const p = el(`<div class="panel" id="panel-privacy">
    <h2>Privacy &amp; Security</h2>
    <p class="sub">Ad/tracker blocking, browsing data, and the vault's auto-lock.</p>

    <div class="setting-card">
      ${settingRow({ title: "Block ads & trackers", desc: `${builtinCount}+ known domains, blocked at the navigation level`, controlHtml: switchHtml("adblock-toggle", settings.adblock_enabled) })}
      ${settingRow({ title: "Blocked this session", controlHtml: `<span class="mono muted">${blockedCount}</span>` })}
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Custom blocked domains</div><div class="desc">Always blocked, in addition to the built-in list</div></div></div>
      <div class="list-panel" id="custom-blocklist"></div>
      <div class="add-row"><input class="field" id="add-block-domain" placeholder="example.com" /><button class="btn sm" id="add-block-btn">Add</button></div>
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Allowed sites</div><div class="desc">Never blocked, even if matched by a rule above</div></div></div>
      <div class="list-panel" id="allow-list"></div>
      <div class="add-row"><input class="field" id="add-allow-domain" placeholder="example.com" /><button class="btn sm" id="add-allow-btn">Add</button></div>
    </div>

    <div class="setting-card">
      ${settingRow({ title: "Vault auto-lock", desc: "Lock the password vault after this many minutes idle", controlHtml: `<input type="range" id="vault-timeout" min="1" max="60" step="1" /><span class="mono faint" id="vault-timeout-value"></span>` })}
      ${settingRow({ title: "Clear browsing history", desc: "Removes all recorded history permanently", controlHtml: `<button class="btn danger sm" id="clear-history-btn">Clear</button>` })}
    </div>
  </div>`);

  p.querySelector("#adblock-toggle").addEventListener("click", async () => {
    const btn = p.querySelector("#adblock-toggle");
    const next = await saveSettings({ adblock_enabled: !btn.classList.contains("on") });
    btn.classList.toggle("on", next.adblock_enabled);
    toast(next.adblock_enabled ? "Ad blocking enabled" : "Ad blocking disabled");
  });

  function renderDomainList(container, items, removeCmd) {
    container.innerHTML = items.length ? "" : `<div class="empty">None yet.</div>`;
    for (const domain of items) {
      const row = el(`<div class="list-row"><span class="lr-title">${domain}</span><button class="btn ghost icon-only sm">${icon("trash", 13)}</button></div>`);
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

function aboutPanel() {
  return el(`<div class="panel" id="panel-about">
    <h2>About Kessel</h2>
    <p class="sub">A real, working custom browser.</p>
    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Version</div></div><div class="control mono muted">0.6.0</div></div>
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
    case "about": return aboutPanel();
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
