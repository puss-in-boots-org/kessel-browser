// Settings for the newer features, all kept in settings.features (store.rs):
// search engines and keywords, startup pages (Search & Startup), Page tools
// (screenshots, reader view, page filters, De-AMP, mouse gestures, each
// site's tweaks), Network (proxy, engine switches) and the settings backup
// (About). settings.js builds the rest of the page and hands its helpers in.

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";
import { toast, escapeHtml, confirmDialog } from "./shared/api.js";
import { allEngines, extraEngines, BUILTIN_KEYWORDS, DEFAULT_EXTRA_ENGINES } from "./shared/search.js";

const { invoke } = window.__TAURI__.core;

const features = () => currentSettings()?.features || {};
function saveFeature(key, value) {
  const next = { ...features() };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return saveSettings({ features: next });
}

function selectHtml(id, options, width = 180) {
  return `<select class="field" id="${id}" style="width:${width}px">${options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}</select>`;
}

const FILTERS = [["", "None"], ["dark", "Dark (invert the page)"], ["grayscale", "Grayscale"], ["sepia", "Sepia"], ["invert", "Invert colours"], ["contrast", "More contrast"], ["dim", "Dimmer"]];

// --- Search & Startup ------------------------------------------------------------------

// The search engines card and the startup pages card, added to the Search &
// Startup panel; the default engine list there gets your engines too.
export function searchExtras(panel, { el, settingRow }) {
  const select = panel.querySelector("#engine-select");
  const fillEngines = () => {
    const s = currentSettings() || {};
    select.innerHTML = allEngines(s).map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join("");
    select.value = allEngines(s).some((e) => e.id === s.search_engine) ? s.search_engine : "google";
  };
  fillEngines();

  const card = el(`<div class="setting-card" id="engines-card">
    <div class="k-card-title"><span class="k-label">Search engines and keywords</span></div>
    <p style="margin:2px 18px 8px;font-size:12px;line-height:1.5;color:var(--text-faint)">Type a keyword and a space before your search -- <span class="mono">yt cats</span> -- to search with that engine. In an engine's address, <span class="mono">%s</span> is what you searched for.</p>
    <div class="list-panel" id="engines-list" style="max-height:none"></div>
    <div id="offered-engines"></div>
    <div class="setting-row"><div class="info"></div><div class="control">
      <button class="btn sm" id="engine-add">${icon("plus", 13)}<span>Add a search engine</span></button>
      <button class="btn sm ghost" id="engine-reset">Reset to Kessel's</button>
    </div></div>
  </div>`);
  const startup = el(`<div class="setting-card">
    ${settingRow({ title: "Pages to start with", desc: "One address per line, opened when Kessel starts -- unless it's bringing back your last tabs. Leave empty for the new-tab page.", controlHtml: "" })}
    <div style="padding:0 14px 12px"><textarea class="field mono" id="startup-pages" rows="3" style="width:100%;resize:vertical" spellcheck="false" placeholder="https://example.com"></textarea>
    <div style="margin-top:8px"><button class="btn sm" id="startup-use-tabs">Use my open tabs</button></div></div>
  </div>`);
  panel.querySelector(".setting-card").after(card);
  card.after(startup);

  const list = card.querySelector("#engines-list");
  const render = () => {
    const s = currentSettings() || {};
    const keywords = { ...BUILTIN_KEYWORDS, ...(features().engine_keywords || {}) };
    list.innerHTML = "";
    for (const e of allEngines(s)) {
      const row = el(`<div class="list-row" style="gap:8px">
        <input class="field" data-k="name" style="width:150px" />
        <input class="field mono" data-k="keyword" style="width:70px" placeholder="keyword" spellcheck="false" />
        <input class="field mono" data-k="url" style="flex:1;min-width:0" spellcheck="false" />
        <button class="btn ghost icon-only sm" title="Remove">${icon("trash", 13)}</button>
      </div>`);
      const [name, keyword, url] = row.querySelectorAll("input");
      const remove = row.querySelector("button");
      name.value = e.name;
      keyword.value = e.builtin ? keywords[e.id] || "" : e.keyword;
      if (e.builtin) {
        name.disabled = true;
        url.disabled = true;
        url.value = "Built in";
        remove.style.visibility = "hidden";
        keyword.addEventListener("change", () => saveFeature("engine_keywords", { ...(features().engine_keywords || {}), [e.id]: keyword.value.trim().toLowerCase() }));
      } else {
        url.value = e.template;
        const update = (patch) => saveFeature("search_engines", extraEngines(currentSettings()).map((x) => (x.id === e.id ? { ...x, ...patch } : x)));
        name.addEventListener("change", () => name.value.trim() && update({ name: name.value.trim() }));
        keyword.addEventListener("change", () => update({ keyword: keyword.value.trim().toLowerCase() }));
        url.addEventListener("change", () => {
          const v = url.value.trim();
          if (!/^https?:\/\//i.test(v)) return toast("An engine's address starts with https://");
          update({ url: v });
        });
        remove.addEventListener("click", async () => {
          await saveFeature("search_engines", extraEngines(currentSettings()).filter((x) => x.id !== e.id));
          render();
          fillEngines();
        });
      }
      list.appendChild(row);
    }
  };
  render();
  // Sites' own search engines (OpenSearch), noticed as you browsed.
  const offered = card.querySelector("#offered-engines");
  const renderOffered = () => {
    const have = new Set(extraEngines(currentSettings()).map((e) => e.url));
    const list = Object.entries(features().offered_engines || {}).filter(([, e]) => e?.url && !e.dismissed && !have.has(e.url)).sort(([a], [b]) => a.localeCompare(b));
    offered.innerHTML = list.length ? `<div class="k-card-title" style="margin-top:6px"><span class="k-label">Offered by sites you visited</span></div>` : "";
    for (const [site, e] of list.slice(0, 30)) {
      const row = el(`<div class="list-row"><span class="lr-title"></span><span class="lr-sub mono"></span><span><button class="btn sm">Add</button><button class="btn ghost icon-only sm" title="Don't offer it">${icon("close", 12)}</button></span></div>`);
      row.querySelector(".lr-title").textContent = e.name;
      row.querySelector(".lr-sub").textContent = site;
      const [add, dismiss] = row.querySelectorAll("button");
      add.addEventListener("click", async () => {
        const keyword = site.split(".")[0].slice(0, 12);
        const taken = new Set(allEngines(currentSettings()).map((x) => x.keyword));
        await saveFeature("search_engines", [...extraEngines(currentSettings()), { id: `site-${site}`, name: e.name, url: e.url, keyword: taken.has(keyword) ? "" : keyword }]);
        render();
        renderOffered();
        fillEngines();
      });
      dismiss.addEventListener("click", async () => {
        const next = { ...(features().offered_engines || {}) };
        next[site] = { ...e, dismissed: true };
        await saveFeature("offered_engines", next);
        renderOffered();
      });
      offered.appendChild(row);
    }
  };
  renderOffered();
  card.querySelector("#engine-add").addEventListener("click", async () => {
    const id = `custom-${Date.now().toString(36)}`;
    await saveFeature("search_engines", [...extraEngines(currentSettings()), { id, name: "New engine", url: "https://example.com/search?q=%s", keyword: "" }]);
    render();
    fillEngines();
    list.lastElementChild?.querySelector("input")?.select();
  });
  card.querySelector("#engine-reset").addEventListener("click", async () => {
    if (!(await confirmDialog("Reset search engines? Your own engines and keywords go; Kessel's come back.", "Reset"))) return;
    const next = { ...features() };
    delete next.engine_keywords;
    next.search_engines = DEFAULT_EXTRA_ENGINES;
    await saveSettings({ features: next });
    render();
    fillEngines();
  });

  const pages = startup.querySelector("#startup-pages");
  pages.value = (features().startup_pages || []).join("\n");
  const savePages = (text) => {
    const urls = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const bad = urls.filter((u) => !/^(https?|kessel):\/\//i.test(u));
    if (bad.length) toast(`Skipped ${bad[0]}${bad.length > 1 ? ` and ${bad.length - 1} more` : ""} -- addresses start with https://`);
    return saveFeature("startup_pages", urls.filter((u) => !bad.includes(u)).slice(0, 20));
  };
  pages.addEventListener("change", () => savePages(pages.value));
  startup.querySelector("#startup-use-tabs").addEventListener("click", async () => {
    const data = await invoke("tab_search_list").catch(() => null);
    const urls = (data?.windows || []).filter((w) => !w.private).flatMap((w) => (w.tabs || []).map((t) => t.url)).filter((u) => /^https?:\/\//.test(u || ""));
    if (!urls.length) return toast("No web pages open");
    pages.value = [...new Set(urls)].slice(0, 20).join("\n");
    await savePages(pages.value);
  });
}

// --- Tabs ------------------------------------------------------------------------------

export function tabSoundCard({ el, settingRow, switchHtml }) {
  const card = el(`<div class="setting-card">
    ${settingRow({ title: "Only the tab you're on plays sound", desc: "Other tabs are muted while you're away from them, and play again when you go back. A tab you unmute yourself keeps playing.", controlHtml: switchHtml("mute-background", !!features().mute_background) })}
    ${settingRow({ title: "Close tabs you've forgotten", desc: "Tabs you haven't looked at for this long close by themselves -- not pinned ones or ones playing sound. They stay in recently closed and history. Counted while Kessel is open.", controlHtml: selectHtml("auto-close-days", [["0", "Never"], ["1", "After a day"], ["3", "After 3 days"], ["7", "After a week"], ["14", "After 2 weeks"], ["30", "After a month"]], 170) })}
  </div>`);
  const autoClose = card.querySelector("#auto-close-days");
  autoClose.value = String(features().auto_close_days || 0);
  autoClose.addEventListener("change", () => saveFeature("auto_close_days", Number(autoClose.value) || undefined));
  const btn = card.querySelector("#mute-background");
  btn.addEventListener("click", async () => {
    const on = !btn.classList.contains("on");
    await saveFeature("mute_background", on);
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", String(on));
  });
  return card;
}

// --- Privacy: forget sites ---------------------------------------------------------------

export function forgetSitesCard({ el, settingRow, switchHtml }) {
  const card = el(`<div class="setting-card">
    ${settingRow({ title: "Forget these sites when you close them", desc: "When the last tab showing one of these sites closes, its cookies and site data go -- you're signed out and it forgets you. One site per line, like example.com (its subdomains too).", controlHtml: "" })}
    <div style="padding:0 14px 12px"><textarea class="field mono" id="forget-sites" rows="3" style="width:100%;resize:vertical" spellcheck="false" placeholder="example.com"></textarea></div>
    ${settingRow({ title: "Say when a site was forgotten", controlHtml: switchHtml("forget-notice", features().forget_sites_notice !== false) })}
  </div>`);
  const text = card.querySelector("#forget-sites");
  text.value = (features().forget_sites || []).join("\n");
  text.addEventListener("change", () => {
    const sites = text.value
      .split(/[\s,]+/)
      .map((l) => l.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
      .filter((l) => /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(l));
    text.value = [...new Set(sites)].join("\n");
    saveFeature("forget_sites", [...new Set(sites)]);
  });
  const notice = card.querySelector("#forget-notice");
  notice.addEventListener("click", async () => {
    const on = !notice.classList.contains("on");
    await saveFeature("forget_sites_notice", on);
    notice.classList.toggle("on", on);
  });
  return card;
}

// --- Page tools ----------------------------------------------------------------------

const GESTURE_NAMES = { L: "←", R: "→", U: "↑", D: "↓" };
const DEFAULT_GESTURES = { L: "back", R: "forward", UD: "reload", DR: "close-tab", U: "new-tab", DL: "reopen-closed-tab", RL: "prev-tab", LR: "next-tab" };
const drawn = (g) => [...g].map((c) => GESTURE_NAMES[c] || c).join(" ");

export async function toolsPanel(settings, { el, settingRow, switchHtml }) {
  const f = features();
  const shot = { format: "png", action: "both", folder: "", ...(f.screenshot || {}) };
  const p = el(`<div class="panel" id="panel-tools">
    <h2>Page tools</h2>
    <p class="sub">Screenshots, reader view, mouse gestures, and changes you make to sites -- your own style, a colour filter, elements you've hidden, auto-reload.</p>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Screenshots</span></div>
      ${settingRow({ title: "When you take one", desc: "Ctrl+Shift+S for what's in view; “Screenshot of the whole page” in the command palette (F2)", controlHtml: selectHtml("shot-action", [["both", "Save and copy"], ["save", "Save it"], ["copy", "Copy it"], ["edit", "Open it in the editor"]], 190) })}
      ${settingRow({ title: "Format", controlHtml: selectHtml("shot-format", [["png", "PNG (sharp)"], ["jpeg", "JPEG (smaller)"]], 170) })}
      ${settingRow({ title: "Save to", desc: "Empty: Pictures\\Kessel", controlHtml: `<input class="field mono" id="shot-folder" style="width:240px" spellcheck="false" />` })}
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Highlights and notes</span></div>
      ${settingRow({ title: "Highlight colour", desc: "Select text and press Ctrl+Shift+H, or right-click it -> Highlight. Click a highlight for its colour, a note, or to remove it. Kept on this computer, never from private windows.", controlHtml: selectHtml("hl-color", [["yellow", "Yellow"], ["green", "Green"], ["blue", "Blue"], ["pink", "Pink"], ["orange", "Orange"]], 130) })}
      ${settingRow({ title: "“Highlight” in the right-click menu", controlHtml: switchHtml("menu-highlight", f.page_menu?.highlight !== false) })}
      <div class="list-panel" id="hl-list" style="max-height:320px"></div>
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Feeds</span></div>
      ${settingRow({ title: "Your feeds", desc: "Follow a site with “Follow this site's feed” in the command palette (F2), or add one on the feeds page. Kessel fetches them itself -- no account.", controlHtml: `<button class="btn sm" id="open-feeds">Open feeds</button>` })}
      ${settingRow({ title: "Check for new items", controlHtml: selectHtml("feeds-every", [["15", "Every 15 minutes"], ["30", "Every 30 minutes"], ["60", "Every hour"], ["180", "Every 3 hours"], ["720", "Twice a day"]], 190) })}
      ${settingRow({ title: "Open items", controlHtml: selectHtml("feeds-open", [["tab", "In a new tab"], ["same", "In the feeds tab"]], 190) })}
      ${settingRow({ title: "Hide items you've read", controlHtml: switchHtml("feeds-hide-read", f.feeds_hide_read === true) })}
      ${settingRow({ title: "Items kept per feed", controlHtml: selectHtml("feeds-max", [["50", "50"], ["100", "100"], ["200", "200"], ["500", "500"]], 100) })}
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Save as PDF</span></div>
      ${settingRow({ title: "Landscape", desc: "“Save as PDF” is in the command palette (F2)", controlHtml: switchHtml("pdf-landscape", !!f.pdf?.landscape) })}
      ${settingRow({ title: "Background colours and pictures", controlHtml: switchHtml("pdf-backgrounds", f.pdf?.backgrounds !== false) })}
      ${settingRow({ title: "Title, address and page numbers", controlHtml: switchHtml("pdf-headers", !!f.pdf?.headers) })}
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Right-click menu in pages</span></div>
      ${settingRow({ title: "Peek at link", desc: "A link in a small window over the page; “Back to tabs” in it keeps it", controlHtml: switchHtml("menu-peek", f.page_menu?.peek !== false) })}
      ${settingRow({ title: "Search the web for selected text", desc: "With your default search engine, in a new tab", controlHtml: switchHtml("menu-search", f.page_menu?.search !== false) })}
      ${settingRow({ title: "Search the web for an image", controlHtml: switchHtml("menu-image", f.page_menu?.image_search !== false) })}
      ${settingRow({ title: "Search images with", controlHtml: selectHtml("image-search", [["google", "Google Lens"], ["bing", "Bing Visual Search"], ["yandex", "Yandex Images"], ["tineye", "TinEye"]], 190) })}
      ${settingRow({ title: "Translate", desc: "Selected text, or the whole page (with Google), in a new tab", controlHtml: switchHtml("menu-translate", f.page_menu?.translate !== false) })}
      ${settingRow({ title: "Translate text with", controlHtml: selectHtml("translate-service", [["google", "Google Translate"], ["bing", "Microsoft Translator"], ["deepl", "DeepL"]], 190) })}
      ${settingRow({ title: "Translate into", desc: "Kessel's language unless you pick one", controlHtml: selectHtml("translate-to", [["", "Kessel's language"], ["en", "English"], ["hu", "Hungarian"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["cs", "Czech"], ["sk", "Slovak"], ["ro", "Romanian"], ["uk", "Ukrainian"], ["ru", "Russian"], ["tr", "Turkish"], ["ja", "Japanese"], ["ko", "Korean"], ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"]], 190) })}
      ${settingRow({ title: "Define a selected word", desc: "From Wiktionary; your search engine if it has no entry", controlHtml: switchHtml("menu-define", f.page_menu?.define !== false) })}
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Command chains</span></div>
      <p style="margin:2px 18px 8px;font-size:12px;line-height:1.5;color:var(--text-faint)">Several commands in one go -- from the command palette (F2), or a mouse gesture below.</p>
      <div id="chain-list"></div>
      <div class="setting-row"><div class="info"></div><div class="control"><button class="btn sm" id="chain-add">${icon("plus", 13)}<span>New chain</span></button></div></div>
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Reading and pages</span></div>
      ${settingRow({ title: "Colour filter for every site", desc: "Each site can have its own below", controlHtml: selectHtml("page-filter", FILTERS, 200) })}
      ${settingRow({ title: "Skip AMP pages", desc: "An AMP copy of a page (Google's cut-down version) goes to the site's real page", controlHtml: switchHtml("deamp", f.deamp !== false) })}
      ${settingRow({ title: "Offer saved copies of missing pages", desc: "When a page is gone (not found), a button opens the Wayback Machine's copy of it", controlHtml: switchHtml("wayback", f.wayback !== false) })}
      ${settingRow({ title: "Reader view", desc: "F9 shows a page's article on its own. Its font, size, width, colours and read-aloud voice are in its Aa menu.", controlHtml: `<button class="btn sm" id="reader-reset">Reset its look</button>` })}
      ${settingRow({ title: "Command palette remembers", desc: "How many commands you ran lately it lists first (F2)", controlHtml: selectHtml("palette-recent", [["0", "None"], ["3", "3"], ["5", "5"], ["10", "10"]], 100) })}
      ${settingRow({ title: "Auto-reload choices", desc: "The intervals the auto-reload menu offers, in seconds", controlHtml: `<input class="field mono" id="reload-choices" style="width:240px" spellcheck="false" />` })}
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Mouse gestures</span></div>
      ${settingRow({ title: "Mouse gestures", desc: "Hold the right mouse button in a page and draw: ← back, → forward, and the ones below", controlHtml: switchHtml("gestures-on", f.gestures_enabled !== false) })}
      <div class="list-panel" id="gesture-list" style="max-height:none"></div>
      <div class="setting-row"><div class="info"><div class="desc">Up to four strokes, like ↓ → (type them as D R). A gesture can run any command.</div></div><div class="control">
        <input class="field mono" id="gesture-new" style="width:90px" placeholder="D R" spellcheck="false" />
        <select class="field" id="gesture-new-cmd" style="width:200px"></select>
        <button class="btn sm" id="gesture-add">${icon("plus", 13)}<span>Add</span></button>
        <button class="btn sm ghost" id="gesture-reset">Reset</button>
      </div></div>
    </div>

    <div class="setting-card" id="site-tweaks-card">
      <div class="k-card-title"><span class="k-label">Your changes to sites</span></div>
      <p style="margin:2px 18px 8px;font-size:12px;line-height:1.5;color:var(--text-faint)">Pick a site to give it its own style (CSS), a colour filter, or auto-reload -- or to bring back what you hid with “Hide an element”.</p>
      <div class="setting-row"><div class="info"><div class="title">Site</div></div><div class="control">
        <input class="field" id="tweak-site" list="tweak-sites" style="width:240px" placeholder="example.com" spellcheck="false" />
        <datalist id="tweak-sites"></datalist>
      </div></div>
      <div id="tweak-editor"></div>
    </div>
  </div>`);

  // Screenshots
  const shotAction = p.querySelector("#shot-action");
  const shotFormat = p.querySelector("#shot-format");
  const shotFolder = p.querySelector("#shot-folder");
  shotAction.value = shot.action;
  shotFormat.value = shot.format;
  shotFolder.value = shot.folder;
  const saveShot = () => saveFeature("screenshot", { action: shotAction.value, format: shotFormat.value, folder: shotFolder.value.trim() });
  for (const c of [shotAction, shotFormat, shotFolder]) c.addEventListener("change", saveShot);

  // Save as PDF
  const pdfSwitch = (id, key, defaultOn) => {
    const btn = p.querySelector(`#${id}`);
    btn.addEventListener("click", async () => {
      const on = !btn.classList.contains("on");
      await saveFeature("pdf", { landscape: false, backgrounds: true, headers: false, ...(features().pdf || {}), [key]: on });
      btn.classList.toggle("on", on);
    });
    return defaultOn;
  };
  pdfSwitch("pdf-landscape", "landscape");
  pdfSwitch("pdf-backgrounds", "backgrounds");
  pdfSwitch("pdf-headers", "headers");

  // Highlights
  const hlColor = p.querySelector("#hl-color");
  hlColor.value = f.highlight_color || "yellow";
  hlColor.addEventListener("change", () => saveFeature("highlight_color", hlColor.value));
  const hlList = p.querySelector("#hl-list");
  const renderHighlights = async () => {
    const pages = Object.entries((await invoke("highlights_all").catch(() => ({}))) || {});
    pages.sort(([, a], [, b]) => Math.max(...b.map((h) => h.at || 0)) - Math.max(...a.map((h) => h.at || 0)));
    hlList.innerHTML = pages.length ? "" : `<div style="padding:10px 12px;font-size:12px;opacity:.6">No highlights yet.</div>`;
    for (const [url, list] of pages.slice(0, 200)) {
      const row = el(`<div class="list-row" style="display:block">
        <div style="display:flex;gap:8px;align-items:center"><a class="lr-title" style="flex:1;color:inherit" href="#"></a><span class="lr-sub"></span><button class="btn ghost icon-only sm" title="Remove this page's highlights">${icon("trash", 13)}</button></div>
        <div class="quotes" style="margin-top:4px"></div></div>`);
      const title = row.querySelector(".lr-title");
      title.textContent = list[0]?.title || url;
      title.addEventListener("click", (e) => {
        e.preventDefault();
        invoke("open_url", { url, how: "tab" }).catch((err) => toast(String(err)));
      });
      row.querySelector(".lr-sub").textContent = `${list.length}`;
      row.querySelector("button").addEventListener("click", async () => {
        await invoke("highlight_delete", { url, id: null }).catch((err) => toast(String(err)));
        renderHighlights();
      });
      const quotes = row.querySelector(".quotes");
      for (const h of list.slice(0, 5)) {
        const q = el(`<div style="font-size:11.5px;opacity:.75;margin:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>`);
        q.textContent = `“${h.exact.replace(/\s+/g, " ").slice(0, 140)}”${h.note ? ` -- ${h.note.replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
        quotes.appendChild(q);
      }
      hlList.appendChild(row);
    }
  };
  renderHighlights();

  // Feeds
  p.querySelector("#open-feeds").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://feeds" }));
  for (const [id, key, fallback] of [["feeds-every", "feeds_refresh_minutes", "60"], ["feeds-open", "feeds_open", "tab"], ["feeds-max", "feeds_max_items", "100"]]) {
    const sel = p.querySelector(`#${id}`);
    sel.value = String(f[key] ?? fallback);
    sel.addEventListener("change", () => saveFeature(key, /^\d+$/.test(sel.value) ? Number(sel.value) : sel.value));
  }

  // Right-click menu
  for (const [id, key] of [["menu-peek", "peek"], ["menu-search", "search"], ["menu-image", "image_search"], ["menu-highlight", "highlight"], ["menu-translate", "translate"], ["menu-define", "define"]]) {
    const btn = p.querySelector(`#${id}`);
    btn.addEventListener("click", async () => {
      const on = !btn.classList.contains("on");
      await saveFeature("page_menu", { ...(features().page_menu || {}), [key]: on });
      btn.classList.toggle("on", on);
    });
  }
  const imageSearch = p.querySelector("#image-search");
  imageSearch.value = f.image_search || "google";
  imageSearch.addEventListener("change", () => saveFeature("image_search", imageSearch.value));
  for (const [id, key, fallback] of [["translate-service", "translate_service", "google"], ["translate-to", "translate_to", ""]]) {
    const sel = p.querySelector(`#${id}`);
    sel.value = f[key] || fallback;
    sel.addEventListener("change", () => saveFeature(key, sel.value));
  }

  // Reading and pages
  const filter = p.querySelector("#page-filter");
  filter.value = f.page_filter || "";
  filter.addEventListener("change", () => saveFeature("page_filter", filter.value || undefined));
  const featureSwitch = (id, key) => {
    const btn = p.querySelector(`#${id}`);
    btn.addEventListener("click", async () => {
      const on = !btn.classList.contains("on");
      await saveFeature(key, on);
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-checked", String(on));
    });
  };
  featureSwitch("deamp", "deamp");
  featureSwitch("wayback", "wayback");
  featureSwitch("feeds-hide-read", "feeds_hide_read");
  featureSwitch("gestures-on", "gestures_enabled");
  p.querySelector("#reader-reset").addEventListener("click", async () => {
    await saveFeature("reader", undefined);
    toast("Reader view looks like it did at first");
  });
  const recent = p.querySelector("#palette-recent");
  recent.value = String(f.palette_recent ?? 5);
  recent.addEventListener("change", () => saveFeature("palette_recent", Number(recent.value)));
  const reloadChoices = p.querySelector("#reload-choices");
  reloadChoices.value = (Array.isArray(f.reload_intervals) ? f.reload_intervals : [15, 30, 60, 300, 900, 1800]).join(", ");
  reloadChoices.addEventListener("change", () => {
    const list = reloadChoices.value.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 5 && n <= 86400);
    saveFeature("reload_intervals", list.length ? [...new Set(list)].sort((a, b) => a - b) : undefined);
  });

  // Gestures
  const commands = (await invoke("get_commands").catch(() => [])).filter((c) => !c.reserved);
  const commandName = (id) => {
    const chain = /^chain:(\d+)$/.exec(id);
    if (chain) return `Chain: ${(Array.isArray(features().command_chains) && features().command_chains[+chain[1]]?.name) || "gone"}`;
    return commands.find((c) => c.id === id)?.label || id;
  };
  const chains = () => (Array.isArray(features().command_chains) ? features().command_chains : []);
  const newCmd = p.querySelector("#gesture-new-cmd");
  const fillGestureCommands = () => {
    newCmd.innerHTML =
      chains().map((c, i) => `<option value="chain:${i}">Chain: ${escapeHtml(c.name || "")}</option>`).join("") +
      commands.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join("");
  };
  fillGestureCommands();

  // Command chains: a name and its steps.
  const chainList = p.querySelector("#chain-list");
  const saveChains = async (list) => {
    await saveFeature("command_chains", list);
    fillGestureCommands();
  };
  const renderChains = () => {
    chainList.innerHTML = chains().length ? "" : `<div style="padding:4px 18px 10px;font-size:12px;opacity:.6">No chains yet.</div>`;
    chains().forEach((chain, i) => {
      const row = el(`<div class="setting-row" style="display:block">
        <div style="display:flex;gap:8px;align-items:center">
          <input class="field" style="flex:1" placeholder="Name" />
          <button class="btn ghost icon-only sm" title="Remove this chain">${icon("trash", 13)}</button>
        </div>
        <div class="steps" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>
        <select class="field" style="margin-top:8px;width:260px"><option value="">Add a step…</option>${commands.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join("")}</select>
      </div>`);
      const [name] = row.querySelectorAll("input");
      name.value = chain.name || "";
      const update = (patch) => saveChains(chains().map((c, j) => (j === i ? { ...c, ...patch } : c)));
      name.addEventListener("change", () => update({ name: name.value.trim() || "Chain" }));
      row.querySelector("button").addEventListener("click", async () => {
        await saveChains(chains().filter((_, j) => j !== i));
        renderChains();
      });
      const steps = row.querySelector(".steps");
      (chain.steps || []).forEach((id, k) => {
        const chip = el(`<span class="btn sm" style="cursor:default">${k + 1}. <span></span> <span class="x" style="cursor:pointer;opacity:.6" title="Remove step">✕</span></span>`);
        chip.querySelector("span").textContent = commandName(id);
        chip.querySelector(".x").addEventListener("click", async () => {
          await update({ steps: chain.steps.filter((_, n) => n !== k) });
          renderChains();
        });
        steps.appendChild(chip);
      });
      row.querySelector("select").addEventListener("change", async (e) => {
        if (!e.target.value) return;
        await update({ steps: [...(chain.steps || []), e.target.value].slice(0, 20) });
        renderChains();
      });
      chainList.appendChild(row);
    });
  };
  renderChains();
  p.querySelector("#chain-add").addEventListener("click", async () => {
    await saveChains([...chains(), { name: `Chain ${chains().length + 1}`, steps: [] }]);
    renderChains();
    chainList.querySelector(".setting-row:last-child input")?.select();
  });
  const gestureList = p.querySelector("#gesture-list");
  const gestures = () => (features().gestures && typeof features().gestures === "object" ? features().gestures : DEFAULT_GESTURES);
  const renderGestures = () => {
    gestureList.innerHTML = "";
    for (const [g, id] of Object.entries(gestures())) {
      const row = el(`<div class="list-row"><span class="lr-title"><span class="mono" style="display:inline-block;min-width:80px"></span><span class="cmd"></span></span><button class="btn ghost icon-only sm" title="Remove">${icon("trash", 13)}</button></div>`);
      row.querySelector(".mono").textContent = drawn(g);
      row.querySelector(".cmd").textContent = commandName(id);
      row.querySelector("button").addEventListener("click", async () => {
        const next = { ...gestures() };
        delete next[g];
        await saveFeature("gestures", next);
        renderGestures();
      });
      gestureList.appendChild(row);
    }
  };
  renderGestures();
  p.querySelector("#gesture-add").addEventListener("click", async () => {
    const input = p.querySelector("#gesture-new");
    const g = input.value.toUpperCase().replace(/←/g, "L").replace(/→/g, "R").replace(/↑/g, "U").replace(/↓/g, "D").replace(/[^LRUD]/g, "").replace(/(.)\1+/g, "$1");
    if (!g || g.length > 4) return toast("Type one to four strokes: L R U D");
    await saveFeature("gestures", { ...gestures(), [g]: newCmd.value });
    input.value = "";
    renderGestures();
  });
  p.querySelector("#gesture-reset").addEventListener("click", async () => {
    await saveFeature("gestures", undefined);
    renderGestures();
  });

  // Each site's tweaks
  const siteInput = p.querySelector("#tweak-site");
  const editor = p.querySelector("#tweak-editor");
  const fillSites = () => {
    p.querySelector("#tweak-sites").innerHTML = Object.keys(features().site_tweaks || {}).sort().map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");
  };
  const showSite = (site) => {
    site = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    editor.innerHTML = "";
    if (!site) return;
    const t = (features().site_tweaks || {})[site] || {};
    const box = el(`<div>
      ${settingRow({ title: "Colour filter", controlHtml: selectHtml("tweak-filter", [["", "Same as every site"], ["none", "None"], ...FILTERS.slice(1)], 200) })}
      ${settingRow({ title: "Reload every", desc: "Seconds; 0 for never (at least 5)", controlHtml: `<input class="field mono" id="tweak-reload" type="number" min="0" step="5" style="width:100px" />` })}
      <div class="setting-row" style="display:block"><div class="info"><div class="title">Your style for ${escapeHtml(site)}</div><div class="desc">CSS added to every page of the site</div></div>
        <textarea class="field mono" id="tweak-css" rows="6" style="width:100%;margin-top:8px;resize:vertical" spellcheck="false" placeholder="body { font-size: 18px !important; }"></textarea></div>
      <div class="list-panel" id="tweak-zapped" style="max-height:220px"></div>
      <div class="setting-row"><div class="info"></div><div class="control"><button class="btn sm danger" id="tweak-clear">Remove all changes to this site</button></div></div>
    </div>`);
    const save = async (patch) => {
      const all = { ...(features().site_tweaks || {}) };
      const next = { ...(all[site] || {}), ...patch };
      for (const k of Object.keys(next)) if (next[k] === "" || next[k] === 0 || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
      if (Object.keys(next).length) all[site] = next;
      else delete all[site];
      await saveFeature("site_tweaks", all);
      fillSites();
    };
    const filterSel = box.querySelector("#tweak-filter");
    filterSel.value = t.filter || "";
    filterSel.addEventListener("change", () => save({ filter: filterSel.value }));
    const reload = box.querySelector("#tweak-reload");
    reload.value = t.reload || 0;
    reload.addEventListener("change", () => {
      const n = Math.round(Number(reload.value) || 0);
      save({ reload: n >= 5 ? Math.min(n, 86400) : 0 });
    });
    const css = box.querySelector("#tweak-css");
    css.value = t.css || "";
    css.addEventListener("change", () => save({ css: css.value.slice(0, 100000) }));
    const zappedList = box.querySelector("#tweak-zapped");
    const renderZapped = () => {
      const zapped = ((features().site_tweaks || {})[site] || {}).zapped || [];
      zappedList.innerHTML = zapped.length ? "" : `<div class="empty" style="padding:10px 12px;font-size:12px;opacity:.6">Nothing hidden on this site. “Hide an element” in the command palette (F2) picks one.</div>`;
      for (const selector of zapped) {
        const row = el(`<div class="list-row"><span class="lr-title mono"></span><button class="btn ghost sm">Show again</button></div>`);
        row.querySelector(".lr-title").textContent = selector;
        row.querySelector("button").addEventListener("click", async () => {
          await save({ zapped: zapped.filter((z) => z !== selector) });
          renderZapped();
        });
        zappedList.appendChild(row);
      }
    };
    renderZapped();
    box.querySelector("#tweak-clear").addEventListener("click", async () => {
      const all = { ...(features().site_tweaks || {}) };
      delete all[site];
      await saveFeature("site_tweaks", all);
      fillSites();
      showSite(site);
    });
    editor.appendChild(box);
  };
  fillSites();
  siteInput.addEventListener("change", () => showSite(siteInput.value));
  // Opened from "Change this site" (the command palette): that site.
  const openFor = () => {
    let site = "";
    try {
      site = localStorage.getItem("kessel-edit-site") || "";
      localStorage.removeItem("kessel-edit-site");
    } catch {}
    if (site) {
      siteInput.value = site;
      showSite(site);
    }
  };
  openFor();
  window.addEventListener("hashchange", openFor);
  window.addEventListener("focus", openFor);
  return p;
}

// --- Network ---------------------------------------------------------------------------

export function networkPanel(settings, { el, settingRow }) {
  const f = features();
  const proxy = { mode: "system", server: "", bypass: "", pac: "", ...(f.proxy || {}) };
  const p = el(`<div class="panel" id="panel-network">
    <h2>Network</h2>
    <p class="sub">How Kessel connects. These are part of how the engine starts, so they apply after a restart.</p>
    <div class="setting-card">
      ${settingRow({ title: "Proxy", desc: "Where Kessel's connections go", controlHtml: selectHtml("proxy-mode", [["system", "Windows' setting"], ["direct", "No proxy"], ["fixed", "This proxy server"], ["pac", "A setup script (PAC)"]], 200) })}
      <div id="proxy-fixed">
        ${settingRow({ title: "Proxy server", desc: "host:port, or socks5://host:port -- one per protocol like http=a:80;https=b:443", controlHtml: `<input class="field mono" id="proxy-server" style="width:260px" spellcheck="false" placeholder="127.0.0.1:8080" />` })}
        ${settingRow({ title: "Not for", desc: "Addresses that skip the proxy, separated by commas", controlHtml: `<input class="field mono" id="proxy-bypass" style="width:260px" spellcheck="false" placeholder="localhost, *.lan" />` })}
      </div>
      <div id="proxy-pac">
        ${settingRow({ title: "Script address", controlHtml: `<input class="field mono" id="proxy-pac-url" style="width:260px" spellcheck="false" placeholder="http://wpad/wpad.dat" />` })}
      </div>
    </div>
    <div class="setting-card">
      ${settingRow({ title: "Engine switches", desc: "For experiments: Chromium command-line switches, separated by spaces (like --enable-features=…). A wrong one can stop pages from working -- empty this to undo.", controlHtml: "" })}
      <div style="padding:0 14px 12px"><textarea class="field mono" id="engine-flags" rows="3" style="width:100%;resize:vertical" spellcheck="false" placeholder="--enable-features=ParallelDownloading"></textarea></div>
    </div>
    <div class="setting-card">
      ${settingRow({ title: "Apply", desc: "Kessel restarts and brings your tabs back", controlHtml: `<button class="btn sm" id="net-restart">${icon("refresh", 13)}<span>Restart now</span></button>` })}
    </div>
  </div>`);
  const mode = p.querySelector("#proxy-mode");
  const server = p.querySelector("#proxy-server");
  const bypass = p.querySelector("#proxy-bypass");
  const pac = p.querySelector("#proxy-pac-url");
  mode.value = proxy.mode;
  server.value = proxy.server;
  bypass.value = proxy.bypass;
  pac.value = proxy.pac;
  const showMode = () => {
    p.querySelector("#proxy-fixed").style.display = mode.value === "fixed" ? "" : "none";
    p.querySelector("#proxy-pac").style.display = mode.value === "pac" ? "" : "none";
  };
  showMode();
  const save = () => {
    showMode();
    saveFeature("proxy", { mode: mode.value, server: server.value.trim(), bypass: bypass.value.trim(), pac: pac.value.trim() });
  };
  for (const c of [mode, server, bypass, pac]) c.addEventListener("change", save);
  const flags = p.querySelector("#engine-flags");
  flags.value = f.engine_flags || "";
  flags.addEventListener("change", () => {
    const bad = flags.value.split(/\s+/).filter((x) => x && !x.startsWith("--"));
    if (bad.length) toast(`Left out ${bad[0]} -- switches start with --`);
    saveFeature("engine_flags", flags.value.trim() || undefined);
  });
  p.querySelector("#net-restart").addEventListener("click", () => invoke("restart_kessel").catch((err) => toast(String(err))));
  return p;
}

// --- Backup ----------------------------------------------------------------------------

export function backupCard({ el, settingRow }) {
  const card = el(`<div class="setting-card">
    ${settingRow({ title: "Back up your settings", desc: "Every setting -- appearance, shortcuts, search engines, your changes to sites -- in one file. No passwords, history or bookmarks.", controlHtml: `<button class="btn sm" id="settings-export">Save to a file…</button><button class="btn sm" id="settings-import">Restore…</button>` })}
  </div>`);
  card.querySelector("#settings-export").addEventListener("click", async () => {
    const path = await invoke("export_settings").catch((err) => toast(String(err)));
    if (path) toast(`Saved to ${path}`);
  });
  card.querySelector("#settings-import").addEventListener("click", async () => {
    if (!(await confirmDialog("Restore settings from a file? Your current settings are replaced by the file's.", "Choose file"))) return;
    const done = await invoke("import_settings").catch((err) => toast(String(err)));
    if (done) {
      toast("Settings restored");
      setTimeout(() => location.reload(), 600);
    }
  });
  return card;
}

// --- Site permissions ----------------------------------------------------------------------

const PERMISSION_KINDS = [
  ["camera", "Camera", "ask"],
  ["microphone", "Microphone", "ask"],
  ["location", "Location", "ask"],
  ["notifications", "Notifications", "ask"],
  ["clipboard", "Reading what you copied", "ask"],
  ["downloads", "Several downloads at once", "ask"],
  ["files", "Editing files on your computer", "ask"],
  ["midi", "MIDI devices", "ask"],
  ["fonts", "Your installed fonts", "ask"],
  ["windows", "Placing windows on your screens", "ask"],
  ["sensors", "Motion sensors", "allow"],
  ["autoplay", "Playing sound on its own", "allow"],
];
const ANSWERS = [["ask", "Ask"], ["allow", "Allow"], ["block", "Block"]];
// What a site's pages may do, which Kessel keeps itself -- never asked
// (permissions.rs CONTENT): allowed or blocked.
const CONTENT_KINDS = [
  ["javascript", "JavaScript", "allow"],
  ["images", "Images", "allow"],
  ["popups", "Pop-ups (windows a page opens without a click)", "block"],
  ["redirects", "Sending you to another site on its own", "allow"],
  ["sound", "Sound", "allow"],
  ["third_party", "Content from other sites", "allow"],
  ["fullscreen", "Full screen", "allow"],
];
const ALLOW_BLOCK = [["allow", "Allow"], ["block", "Block"]];
const isContentKind = (kind) => CONTENT_KINDS.some((k) => k[0] === kind);

export function permissionsPanel(settings, { el, settingRow, switchHtml }) {
  const f = features();
  const p = el(`<div class="panel" id="panel-permissions">
    <h2>Site permissions</h2>
    <p class="sub">What sites may use. Kessel asks the first time (under the address bar); your answers for each site are below, and you can change them any time.</p>
    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">For every site</span></div>
      <div id="perm-defaults"></div>
      ${settingRow({ title: "Remember my answer", desc: "The prompt's “Remember for this site” starts ticked. Answers from private windows are never kept.", controlHtml: switchHtml("perm-remember", f.permission_remember !== false) })}
    </div>
    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Site content, for every site</span></div>
      <div class="setting-row"><div class="info"><div class="desc">Never asked about -- change one site from the lock in the address bar, or below. JavaScript and sound take effect when the page loads again.</div></div></div>
      <div id="perm-content"></div>
    </div>
    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Sites you've answered</span></div>
      <div class="setting-row"><div class="info"></div><div class="control"><input class="field" id="perm-q" placeholder="Find a site" style="width:220px" spellcheck="false" /></div></div>
      <div id="perm-sites"></div>
    </div>
  </div>`);
  const defaults = p.querySelector("#perm-defaults");
  for (const [kind, label, fallback] of PERMISSION_KINDS) {
    const row = el(settingRow({ title: label, controlHtml: selectHtml(`perm-default-${kind}`, ANSWERS, 120) }));
    const sel = row.querySelector("select");
    sel.value = f.permission_defaults?.[kind] || fallback;
    sel.addEventListener("change", () => saveFeature("permission_defaults", { ...(features().permission_defaults || {}), [kind]: sel.value }));
    defaults.appendChild(row);
  }
  const content = p.querySelector("#perm-content");
  for (const [kind, label, fallback] of CONTENT_KINDS) {
    const row = el(settingRow({ title: label, controlHtml: selectHtml(`perm-default-${kind}`, ALLOW_BLOCK, 120) }));
    const sel = row.querySelector("select");
    sel.value = f.permission_defaults?.[kind] || fallback;
    sel.addEventListener("change", () => saveFeature("permission_defaults", { ...(features().permission_defaults || {}), [kind]: sel.value }));
    content.appendChild(row);
  }
  const remember = p.querySelector("#perm-remember");
  remember.addEventListener("click", async () => {
    const on = !remember.classList.contains("on");
    await saveFeature("permission_remember", on);
    remember.classList.toggle("on", on);
  });
  const sites = p.querySelector("#perm-sites");
  const labelOf = (kind) => [...PERMISSION_KINDS, ...CONTENT_KINDS].find((k) => k[0] === kind)?.[1] || kind;
  const render = () => {
    const q = p.querySelector("#perm-q").value.trim().toLowerCase();
    const all = Object.entries(features().site_permissions || {}).filter(([site, own]) => own && Object.keys(own).length && (!q || site.includes(q))).sort(([a], [b]) => a.localeCompare(b));
    sites.innerHTML = all.length ? "" : `<div style="padding:4px 18px 12px;font-size:12px;opacity:.6">${q ? "No site matches." : "No answers yet."}</div>`;
    for (const [site, own] of all.slice(0, 300)) {
      const box = el(`<div class="setting-row" style="display:block">
        <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:13px"></b><button class="btn sm ghost">Reset this site</button></div>
        <div class="kinds" style="display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:8px"></div></div>`);
      box.querySelector("b").textContent = site;
      box.querySelector("button").addEventListener("click", async () => {
        const next = { ...(features().site_permissions || {}) };
        delete next[site];
        await saveFeature("site_permissions", next);
        render();
      });
      const kinds = box.querySelector(".kinds");
      for (const [kind, answer] of Object.entries(own)) {
        const item = el(`<label style="display:flex;align-items:center;gap:6px;font-size:12px"><span></span>${selectHtml("", isContentKind(kind) ? [["default", "Default"], ...ALLOW_BLOCK] : ANSWERS, 90)}</label>`);
        item.querySelector("span").textContent = labelOf(kind);
        const sel = item.querySelector("select");
        sel.value = answer;
        sel.addEventListener("change", async () => {
          const next = { ...(features().site_permissions || {}) };
          next[site] = { ...next[site], [kind]: sel.value };
          // "Ask" (or a content setting's "Default") for a site is the same
          // as no answer.
          if (sel.value === "ask" || sel.value === "default") delete next[site][kind];
          await saveFeature("site_permissions", next);
        });
        kinds.appendChild(item);
      }
      sites.appendChild(box);
    }
  };
  p.querySelector("#perm-q").addEventListener("input", render);
  window.addEventListener("kessel-settings", () => {
    if (!p.contains(document.activeElement)) render();
  });
  render();
  return p;
}

// --- Downloads -------------------------------------------------------------------------------

export function downloadsExtras(panel, { el, settingRow, switchHtml }) {
  const f = features();
  const card = el(`<div class="setting-card">
    ${settingRow({ title: "Save downloads to", desc: "Empty: your Downloads folder", controlHtml: `<input class="field mono" id="dl-dir" style="width:260px" spellcheck="false" placeholder="C:\\Users\\you\\Downloads" />` })}
    ${settingRow({ title: "Ask where to save each file", desc: "A Save As window for every download", controlHtml: switchHtml("dl-ask", f.download_ask === true) })}
  </div>`);
  const dir = card.querySelector("#dl-dir");
  dir.value = f.download_dir || "";
  dir.addEventListener("change", () => saveFeature("download_dir", dir.value.trim() || undefined));
  const ask = card.querySelector("#dl-ask");
  ask.addEventListener("click", async () => {
    const on = !ask.classList.contains("on");
    await saveFeature("download_ask", on);
    ask.classList.toggle("on", on);
  });
  panel.querySelector(".setting-card").before(card);
}
