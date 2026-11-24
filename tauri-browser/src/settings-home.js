// Settings' front page and its search. The Overview holds the handful of
// choices most people come to Settings for -- how hard Kessel works,
// Shields, colours, dark or light, search -- and the way into the setup
// (kessel://welcome); the search finds any setting on any page by what it's
// called or what it does, and takes you straight to it.

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";
import { toast, escapeHtml, ENGINES } from "./shared/api.js";
import { resolveStyle, STYLES } from "./shared/styles.js";
import { PERFORMANCE, PRIVACY, currentPerformance, currentPrivacy, performancePatch } from "./shared/setup-profiles.js";

const { invoke } = window.__TAURI__.core;

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const CAT_INFO = {
  look: { icon: "palette", desc: "Style, colours, text size" },
  browsing: { icon: "globe", desc: "Search, tabs, shortcuts, extensions" },
  privacy: { icon: "shield", desc: "Shields, cookies, permissions" },
  yours: { icon: "bookmark", desc: "Bookmarks, passwords, import" },
  system: { icon: "bolt", desc: "Speed, network, version" },
};

// One of the current style's options (Settings -> Appearance), changed.
function setStyleOption(patch) {
  const s = currentSettings() || {};
  const r = resolveStyle(s);
  const custom = { ...r.custom, ...patch };
  return saveSettings({ ui_style: r.id, ui_custom: { ...r.all, [r.id]: custom } });
}

function segmented(items, active) {
  return `<div class="segmented">${items.map(([id, label]) => `<button data-id="${id}" class="${id === active ? "active" : ""}">${escapeHtml(label)}</button>`).join("")}</div>`;
}

function row(title, desc, control, id = "") {
  return `<div class="setting-row" ${id ? `id="${id}"` : ""}><div class="info"><div class="title">${title}</div>${desc ? `<div class="desc">${desc}</div>` : ""}</div><div class="control">${control}</div></div>`;
}

export function homePanel(settings, { sections = window.__settingsSections || [], categories = window.__settingsCategories || [] } = {}) {
  const p = el(`<div class="panel" id="panel-home">
    <div class="home-hero">
      <div class="home-hero-icon">${icon("sparkle", 22)}</div>
      <div class="home-hero-text">
        <h2>Set Kessel up for this PC</h2>
        <p>A one-minute guide that looks at your hardware and suggests how fast, how private and how it should look &mdash; including colours from your desktop wallpaper.</p>
      </div>
      <button class="btn primary" id="run-setup">${icon("arrowRight", 13)} Run setup</button>
    </div>

    <h3 class="home-title">Quick settings</h3>
    <div class="setting-card" id="quick-card"></div>

    <h3 class="home-title">Everything else</h3>
    <div class="home-cats" id="home-cats"></div>
  </div>`);

  p.querySelector("#run-setup").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://welcome" }).catch((e) => toast(String(e))));

  const card = p.querySelector("#quick-card");
  const render = () => {
    const s = currentSettings() || settings || {};
    const r = resolveStyle(s);
    const perf = currentPerformance(s);
    const shields = s.adblock_enabled === false ? "off" : currentPrivacy(s);
    card.innerHTML = [
      row("Speed", perf ? escapeHtml(PERFORMANCE[perf].tagline) : "Set by hand under System &rarr; Performance", segmented(Object.entries(PERFORMANCE).map(([id, x]) => [id, x.label]), perf), "quick-speed"),
      row("Shields", shields === "off" ? "Off: ads and trackers aren't blocked" : shields ? escapeHtml(PRIVACY[shields].tagline) : "Set by hand under Privacy &amp; security", segmented([...Object.entries(PRIVACY).map(([id, x]) => [id, x.label]), ["off", "Off"]], shields), "quick-shields"),
      row(
        "Colours from the wallpaper",
        `The whole interface in your wallpaper's colours &mdash; ${escapeHtml(STYLES[r.id]?.name || "")} style`,
        `${r.values.wallTheme ? segmented([["kessel", "Kessel's"], ["desktop", "Desktop's"]], r.values.wallSource) : ""}<button class="switch ${r.values.wallTheme ? "on" : ""}" id="quick-wall" role="switch" aria-checked="${!!r.values.wallTheme}"></button>`,
        "quick-colours",
      ),
      row("Dark or light", "", segmented([["dark", "Dark"], ["light", "Light"], ["system", "Windows"], ...(r.values.wallTheme ? [["wallpaper", "Wallpaper"]] : [])], r.values.mode), "quick-mode"),
      row("Search engine", "Used by the address bar and new tabs", `<select class="field" id="quick-engine" style="width:160px">${Object.entries(ENGINES).map(([id, e]) => `<option value="${id}" ${id === s.search_engine ? "selected" : ""}>${escapeHtml(e.name)}</option>`).join("")}</select>`),
      row("Reopen my tabs", "Bring back your windows and tabs when Kessel starts", `<button class="switch ${s.restore_tabs ? "on" : ""}" id="quick-restore" role="switch" aria-checked="${!!s.restore_tabs}"></button>`),
    ].join("");

    const fail = (e) => toast(String(e));
    card.querySelectorAll("#quick-speed .segmented button").forEach((b) => b.addEventListener("click", () => saveSettings(performancePatch(b.dataset.id, currentSettings())).then(render, fail)));
    card.querySelectorAll("#quick-shields .segmented button").forEach((b) =>
      b.addEventListener("click", () => saveSettings(b.dataset.id === "off" ? { adblock_enabled: false } : PRIVACY[b.dataset.id].settings).then(render, fail)),
    );
    card.querySelectorAll("#quick-colours .segmented button").forEach((b) => b.addEventListener("click", () => setStyleOption({ wallSource: b.dataset.id }).then(render, fail)));
    card.querySelector("#quick-wall").addEventListener("click", () => {
      const on = !resolveStyle(currentSettings() || {}).values.wallTheme;
      const patch = { wallTheme: on };
      if (!on && resolveStyle(currentSettings() || {}).values.mode === "wallpaper") patch.mode = "dark";
      setStyleOption(patch).then(render, fail);
    });
    card.querySelectorAll("#quick-mode .segmented button").forEach((b) => b.addEventListener("click", () => setStyleOption({ mode: b.dataset.id }).then(render, fail)));
    card.querySelector("#quick-engine").addEventListener("change", (e) => saveSettings({ search_engine: e.target.value }).catch(fail));
    card.querySelector("#quick-restore").addEventListener("click", () => saveSettings({ restore_tabs: !currentSettings()?.restore_tabs }).then(render, fail));
  };
  render();
  // Changed somewhere else (the toolbar, another Settings): show it here.
  window.addEventListener("kessel-settings", () => {
    if (!p.contains(document.activeElement) || document.activeElement === document.body) render();
  });

  const cats = p.querySelector("#home-cats");
  for (const cat of categories.filter((c) => CAT_INFO[c.id])) {
    const list = sections.filter((x) => x.cat === cat.id);
    const tile = el(`<div class="home-cat">
      <div class="home-cat-head"><span class="home-cat-icon">${icon(CAT_INFO[cat.id].icon, 16)}</span><div><b>${escapeHtml(cat.label)}</b><small>${escapeHtml(CAT_INFO[cat.id].desc)}</small></div></div>
      <div class="home-cat-links">${list.map((x) => `<a href="#${x.id}">${icon(x.icon, 12)}<span>${escapeHtml(x.label)}</span></a>`).join("")}</div>
    </div>`);
    cats.appendChild(tile);
  }
  return p;
}

// --- Search -------------------------------------------------------------------------

function words(q) {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

function mark(text, ws) {
  let html = escapeHtml(text);
  for (const w of ws) {
    const re = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    html = html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, txt) => (tag ? tag : txt.replace(re, "<mark>$1</mark>")));
  }
  return html;
}

// What each built section says about itself: one entry per setting.
function indexPanels(sections) {
  const out = [];
  for (const section of sections) {
    if (section.id === "home" || section.id === "features") continue;
    const panel = document.getElementById(`panel-${section.id}`);
    if (!panel) continue;
    for (const node of panel.querySelectorAll(".setting-row, .k-row, .k-group")) {
      if (node.closest("[hidden]")) continue;
      let title;
      let desc;
      if (node.classList.contains("k-group")) {
        title = node.querySelector(".k-group-head .k-label")?.textContent;
        desc = node.querySelector(".k-group-head small")?.textContent;
      } else {
        title = node.querySelector(".info .title")?.textContent;
        desc = node.querySelector(".info .desc")?.textContent;
      }
      title = (title || "").trim();
      if (!title) continue;
      out.push({ section, node, title, desc: (desc || "").trim() });
    }
  }
  return out;
}

export function buildSearch({ sections, buildAll, showSection }) {
  window.__settingsSections = sections;
  const nav = document.getElementById("settings-nav");
  const box = el(`<div class="nav-search">${icon("search", 14)}<input class="field" id="settings-q" type="search" placeholder="Search settings" autocomplete="off" spellcheck="false" /><kbd>/</kbd></div>`);
  nav.querySelector("h1").after(box);
  const input = box.querySelector("input");
  const content = document.getElementById("settings-content");
  const results = el(`<div class="panel" id="panel-results"></div>`);
  content.prepend(results);

  let built = null;
  let timer = 0;
  let last = null;

  async function run() {
    const q = input.value.trim();
    if (!q) return clear(false);
    document.body.classList.add("searching");
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p === results));
    if (!built) {
      results.innerHTML = `<p class="sub" style="margin-top:20px"><span class="spinner"></span> Looking through every page…</p>`;
      built = buildAll();
    }
    await built;
    if (input.value.trim() !== q) return;
    const ws = words(q);
    const matches = (text) => ws.every((w) => text.toLowerCase().includes(w));
    const pages = sections.filter((x) => matches(`${x.label} ${x.keywords || ""}`));
    // A setting matches by what it says; a page by its name and what's on it.
    const seen = new Set();
    const hits = indexPanels(sections).filter((h) => {
      if (!matches(`${h.title} ${h.desc}`)) return false;
      // The same option shown twice on one page (Appearance's essentials and its own group): once.
      const key = `${h.section.id}\n${h.title}\n${h.desc}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Title matches before description-only ones.
    hits.sort((a, b) => Number(!ws.every((w) => a.title.toLowerCase().includes(w))) - Number(!ws.every((w) => b.title.toLowerCase().includes(w))));
    const shown = hits.slice(0, 60);
    results.innerHTML = `<h2>${shown.length || pages.length ? `Results for “${escapeHtml(q)}”` : `Nothing found for “${escapeHtml(q)}”`}</h2>
      <p class="sub">${shown.length ? `${hits.length} setting${hits.length === 1 ? "" : "s"}${hits.length > shown.length ? `, the first ${shown.length} shown` : ""}` : "Try another word -- or look in All features, which lists everything Kessel can do."}</p>`;
    if (pages.length) {
      const chips = el(`<div class="result-pages"></div>`);
      for (const x of pages) {
        const chip = el(`<button class="result-page">${icon(x.icon, 13)}<span>${escapeHtml(x.label)}</span></button>`);
        chip.addEventListener("click", () => go(x.id));
        chips.appendChild(chip);
      }
      results.appendChild(chips);
    }
    let cardFor = null;
    let current = null;
    for (const h of shown) {
      if (h.section !== current) {
        current = h.section;
        cardFor = el(`<div class="setting-card result-card"><div class="k-card-title">${icon(h.section.icon, 12)} ${escapeHtml(h.section.label)}</div></div>`);
        results.appendChild(cardFor);
      }
      const r = el(`<button class="result-row"><div class="info"><div class="title">${mark(h.title, ws)}</div>${h.desc ? `<div class="desc">${mark(h.desc, ws)}</div>` : ""}</div>${icon("chevronRight", 14)}</button>`);
      r.addEventListener("click", () => go(h.section.id, h.node));
      cardFor.appendChild(r);
    }
    if (!shown.length && !pages.length) {
      const all = el(`<button class="btn">${icon("help", 13)} Open All features</button>`);
      all.addEventListener("click", () => go("features"));
      results.appendChild(all);
    }
  }

  async function go(id, node = null) {
    last = id;
    history.replaceState(null, "", `#${id}`);
    await showSection(id);
    if (!node) return;
    // Open what it's folded inside (Appearance's option groups).
    node.closest(".k-group")?.classList.add("open");
    if (node.classList.contains("k-group")) node.classList.add("open");
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.remove("search-hit");
      void node.offsetWidth;
      node.classList.add("search-hit");
      setTimeout(() => node.classList.remove("search-hit"), 2200);
    });
  }

  function clear(resetInput = true) {
    if (resetInput) input.value = "";
    if (!document.body.classList.contains("searching")) return;
    document.body.classList.remove("searching");
    results.classList.remove("active");
    const id = last || location.hash.replace("#", "") || "home";
    showSection(sections.some((x) => x.id === id) ? id : "home");
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 140);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      clear();
      input.blur();
    }
    if (e.key === "Enter") results.querySelector(".result-row, .result-page")?.click();
  });
  // "/" or Ctrl+F: straight to the search.
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f")) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
  window.addEventListener("hashchange", () => {
    last = location.hash.replace("#", "") || last;
  });
  return { clear: () => clear(), focus: () => input.focus() };
}
