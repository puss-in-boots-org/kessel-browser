// Settings -> Extensions and Settings -> Side panel (settings.js builds the
// rest of the page and hands its helpers in).

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";
import { toast, escapeHtml, formatRelativeTime, confirmDialog } from "./shared/api.js";
import { permissionLines, SOURCE_NAMES, applyExtensionTheme } from "./shared/extension-info.js";
import { RAIL_ITEMS, DEFAULT_RAIL_ITEMS, AI_PROVIDERS, WORKSPACE_COLORS, WORKSPACE_ICONS } from "./shared/sidebar-panels.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Developer mode is a way of looking at the list: kept in this page.
function developerMode() {
  try {
    return localStorage.getItem("kessel-extension-developer") === "1";
  } catch {
    return false;
  }
}

function setDeveloperMode(on) {
  try {
    localStorage.setItem("kessel-extension-developer", on ? "1" : "0");
  } catch {}
}

export async function extensionsPanel(settings, { el, settingRow, switchHtml, wireSwitch }) {
  const p = el(`<div class="panel" id="panel-extensions">
    <h2>Extensions</h2>
    <p class="sub">Extensions from the Chrome Web Store and Edge Add-ons, run by the browser engine itself. Open one's page in a store and click “Add to Kessel” in the address bar -- or add one from a file here. Their buttons are under the puzzle in the address bar.</p>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Get extensions</div><div class="desc">Most Chrome extensions work. The engine doesn't run old “Manifest V2” ones any more (neither does Chrome), and extensions stay out of private windows.</div></div>
        <div class="control" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn sm" id="ext-cws">${icon("globe", 13)}<span>Chrome Web Store</span></button>
          <button class="btn sm" id="ext-edge">${icon("globe", 13)}<span>Edge Add-ons</span></button>
          <button class="btn sm" id="ext-file">${icon("file", 13)}<span>From a file…</span></button>
        </div>
      </div>
      ${settingRow({ title: "Update extensions automatically", desc: "Kessel looks for new versions a little after it starts, then every few hours. One that asks for more than before waits for you to look it over.", controlHtml: `<button class="btn sm" id="ext-update">${icon("refresh", 13)}<span>Update now</span></button>${switchHtml("ext-auto", settings.extensions_auto_update !== false)}` })}
      ${settingRow({ title: "Developer mode", desc: "Load an extension from its folder, reload it after changing its files, and pack one up for a store.", controlHtml: `<button class="btn sm" id="ext-unpacked" hidden>${icon("folder", 13)}<span>Load unpacked…</span></button>${switchHtml("ext-dev", developerMode())}` })}
    </div>

    <div id="ext-pending"></div>
    <div id="ext-list"></div>
    <div id="ext-themes"></div>
  </div>`);

  wireSwitch(p, "ext-auto", "extensions_auto_update", { defaultOn: true });
  const dev = p.querySelector("#ext-dev");
  const showDev = () => {
    const on = developerMode();
    dev.classList.toggle("on", on);
    // (.btn's own display would win over [hidden].)
    p.querySelector("#ext-unpacked").style.display = on ? "" : "none";
  };
  dev.addEventListener("click", () => {
    setDeveloperMode(!developerMode());
    showDev();
    render();
  });
  showDev();

  const open = (url) => invoke("open_url", { url, how: "tab" }).catch((err) => toast(String(err)));
  p.querySelector("#ext-cws").addEventListener("click", () => open("https://chromewebstore.google.com/"));
  p.querySelector("#ext-edge").addEventListener("click", () => open("https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home"));
  p.querySelector("#ext-update").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    const names = await invoke("update_extensions", {}).catch((err) => (toast(String(err)), null));
    b.disabled = false;
    if (names) toast(names.length ? `Updated ${names.join(", ")}` : "Your extensions are up to date");
  });
  p.querySelector("#ext-unpacked").addEventListener("click", async () => {
    const added = await invoke("load_unpacked_extension", {}).catch((err) => (toast(String(err)), null));
    if (added) toast(added.error ? `${added.name} was loaded, but couldn't run: ${added.error}` : `${added.name} is loaded`);
  });
  p.querySelector("#ext-file").addEventListener("click", async () => {
    const preview = await invoke("preview_extension_file", {}).catch((err) => (toast(String(err)), null));
    if (preview) showPending(preview);
  });

  // A package (from a file, or a new version) to look over before it's added.
  function showPending(preview) {
    const box = p.querySelector("#ext-pending");
    const x = preview.extension;
    const lines = x.theme ? [] : permissionLines(x);
    const card = el(`<div class="setting-card">
      <div class="k-card-title"><span class="k-label">Ready to add</span></div>
      <div class="setting-row"><div class="info"><div class="title"></div><div class="desc"></div></div>
        <div class="control" style="gap:6px"><button class="btn sm">Cancel</button><button class="btn sm primary">${x.theme ? "Use theme" : preview.have ? "Update" : "Add extension"}</button></div>
      </div>
    </div>`);
    card.querySelector(".title").textContent = `${x.name} ${x.version}${preview.have ? ` (you have ${preview.have})` : ""}`;
    card.querySelector(".desc").textContent = x.theme ? "A theme: Kessel takes on its colours." : lines.length ? `It will be able to: ${lines.join("; ")}.` : "It asks for nothing that reaches your data.";
    const [cancel, add] = card.querySelectorAll("button");
    cancel.addEventListener("click", () => {
      invoke("cancel_extension_install", { token: preview.token }).catch(() => {});
      box.replaceChildren();
    });
    add.addEventListener("click", async () => {
      add.disabled = true;
      const done = await invoke("confirm_extension_install", { token: preview.token }).catch((err) => (toast(String(err)), null));
      box.replaceChildren();
      if (done?.theme) await applyExtensionTheme(done.id);
      if (done) toast(done.error ? `${done.name} was added, but couldn't run: ${done.error}` : `${done.name} is in Kessel`);
    });
    box.replaceChildren(card);
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function render() {
    const all = await invoke("list_extensions").catch(() => []);
    const list = p.querySelector("#ext-list");
    const themes = p.querySelector("#ext-themes");
    const exts = all.filter((x) => !x.theme);
    list.replaceChildren();
    if (!exts.length) list.append(el(`<div class="setting-card"><div class="setting-row"><div class="info"><div class="desc">No extensions yet.</div></div></div></div>`));
    for (const x of exts) list.append(extensionCard(x));
    themes.replaceChildren();
    const installedThemes = all.filter((x) => x.theme);
    if (installedThemes.length) {
      const card = el(`<div class="setting-card"><div class="k-card-title"><span class="k-label">Themes</span></div></div>`);
      for (const t of installedThemes) {
        const row = el(settingRow({ title: escapeHtml(t.name), desc: `From the ${escapeHtml(SOURCE_NAMES[t.source] || "store")}. Its colours go onto the style you use.`, controlHtml: `<button class="btn sm">Use</button><button class="btn danger sm">Remove</button>` }));
        const [use, remove] = row.querySelectorAll("button");
        use.addEventListener("click", async () => toast((await applyExtensionTheme(t.id)) ? `Using the theme “${t.name}”` : "That theme has no colours Kessel can use"));
        remove.addEventListener("click", () => invoke("remove_extension", { id: t.id }).catch((err) => toast(String(err))));
        card.append(row);
      }
      themes.append(card);
    }
  }

  function extensionCard(x) {
    const card = el(`<div class="setting-card ext-card">
      <div class="setting-row">
        <div class="info" style="display:flex;gap:12px;align-items:flex-start">
          <span class="ext-logo" style="width:32px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text-dim)"></span>
          <div style="min-width:0"><div class="title"></div><div class="desc ext-desc"></div><div class="desc ext-status"></div></div>
        </div>
        <div class="control">${switchHtml(`ext-on-${x.id}`, x.enabled)}</div>
      </div>
      <details class="ext-details"><summary class="desc" style="cursor:pointer;padding:0 16px 12px">Details, site access, remove</summary><div class="ext-more"></div></details>
    </div>`);
    const logo = card.querySelector(".ext-logo");
    if (x.icon) logo.append(Object.assign(document.createElement("img"), { src: x.icon, alt: "", width: 32, height: 32 }));
    else logo.innerHTML = icon("puzzle", 24);
    card.querySelector(".title").textContent = `${x.name}  ${x.version}`;
    card.querySelector(".ext-desc").textContent = x.description || `From the ${SOURCE_NAMES[x.source] || "store"}`;
    const status = [];
    if (x.error) status.push(`<span style="color:var(--danger)">Couldn't run: ${escapeHtml(x.error)}</span>`);
    if (x.flagged === "malware") status.push(`<span style="color:var(--danger)">The Chrome Web Store took it down as malware${x.enabled ? "" : ", so Kessel turned it off"}. Remove it unless you're sure.</span>`);
    if (x.flagged === "removed") status.push(`<span style="color:var(--warning)">It's no longer in its store -- it may have been taken down. It won't get updates.</span>`);
    if (x.restart) status.push(`<span style="color:var(--warning)">Restart Kessel to finish its last change.</span>`);
    if (x.pending) status.push(`<span style="color:var(--warning)">Version ${escapeHtml(x.pending)} asks for more than this one -- <a href="#" class="ext-review">look it over</a>.</span>`);
    card.querySelector(".ext-status").innerHTML = status.join("<br>");
    card.querySelector(".ext-review")?.addEventListener("click", async (e) => {
      e.preventDefault();
      const preview = await invoke("preview_store_extension", { store: x.source, id: x.id }).catch((err) => (toast(String(err)), null));
      if (preview) showPending(preview);
    });
    const toggle = card.querySelector(`#ext-on-${x.id}`);
    toggle.addEventListener("click", () => invoke("set_extension_enabled", { id: x.id, enabled: !toggle.classList.contains("on") }).catch((err) => toast(String(err))));

    const more = card.querySelector(".ext-more");
    const lines = permissionLines(x);
    more.append(el(`<div class="setting-row"><div class="info"><div class="title">It can</div><div class="desc">${lines.length ? lines.map(escapeHtml).join("<br>") : "Nothing that reaches your data"}</div></div></div>`));
    if (x.source !== "folder" && x.hosts.length) {
      const access = el(`<div class="setting-row"><div class="info"><div class="title">Site access</div><div class="desc">Where its scripts for pages may run -- at once. What it may fetch from sites follows once Kessel restarts.</div>
        <textarea class="field ext-sites" rows="3" placeholder="One site a line: example.com" style="width:100%;margin-top:8px;resize:vertical;box-sizing:border-box" hidden></textarea></div>
        <div class="control" style="flex-direction:column;align-items:flex-end;gap:6px"><select class="field" style="width:210px">
          <option value="all">On every site it asks for</option><option value="sites">Only on sites I choose</option><option value="click">Only when I open it</option>
        </select><button class="btn sm" hidden>Save sites</button></div></div>`);
      const select = access.querySelector("select");
      const sites = access.querySelector("textarea");
      const save = access.querySelector("button");
      select.value = x.access || "all";
      sites.value = (x.sites || []).join("\n");
      const showSites = () => {
        sites.hidden = select.value !== "sites";
        save.style.display = sites.hidden ? "none" : "";
      };
      showSites();
      const apply = () =>
        invoke("set_extension_access", { id: x.id, access: select.value, sites: sites.value.split(/[\s,]+/).filter(Boolean) })
          .then(() => toast("Site access changed"))
          .catch((err) => toast(String(err)));
      select.addEventListener("change", () => {
        showSites();
        if (select.value !== "sites") apply();
        else sites.focus();
      });
      save.addEventListener("click", apply);
      more.append(access);
    }
    const buttons = el(`<div class="setting-row"><div class="info"><div class="desc"></div></div><div class="control" style="gap:6px;flex-wrap:wrap;justify-content:flex-end"></div></div>`);
    buttons.querySelector(".desc").textContent = `From ${SOURCE_NAMES[x.source] || "the store"} · added ${formatRelativeTime(x.installed)}${x.updated > x.installed + 60 ? ` · updated ${formatRelativeTime(x.updated)}` : ""}${developerMode() ? ` · id ${x.id}` : ""}`;
    const bar = buttons.querySelector(".control");
    const add = (label, iconName, run, cls = "") => {
      const b = el(`<button class="btn sm ${cls}">${icon(iconName, 13)}<span></span></button>`);
      b.querySelector("span").textContent = label;
      b.addEventListener("click", run);
      bar.append(b);
    };
    if (x.options) add("Options", "settings", () => invoke("open_extension_page", { id: x.id }).catch((err) => toast(String(err))));
    if (x.popup || x.side_panel) add("In the side panel", "sidebar", () => invoke("open_extension_side_panel", { id: x.id }).catch((err) => toast(String(err))));
    if (x.homepage) add("Website", "globe", () => open(x.homepage));
    if (developerMode()) {
      if (x.source === "folder") add("Reload", "refresh", () => invoke("reload_extension", { id: x.id }).then(() => toast("Reloaded")).catch((err) => toast(String(err))));
      add("Pack for a store", "download", () => invoke("pack_extension", { id: x.id }).then((path) => path && toast(`Packed: ${path}`)).catch((err) => toast(String(err))));
    }
    add(
      "Remove",
      "trash",
      async () => {
        if (await confirmDialog(`Remove ${x.name}? Its settings and data go with it.`, "Remove")) invoke("remove_extension", { id: x.id }).catch((err) => toast(String(err)));
      },
      "danger"
    );
    more.append(buttons);
    return card;
  }

  await render();
  listen("extensions-changed", render);
  listen("extensions-updated", (e) => toast(`Updated ${(e.payload || []).join(", ")}`));
  listen("extensions-flagged", (e) => toast(`Turned off ${(e.payload || []).join(", ")}: its store took it down as malware`, { duration: 6000 }));
  return p;
}

// --- Side panel ------------------------------------------------------------------------------

const GLYPH = "display:inline-flex;width:20px;height:20px;border-radius:6px;align-items:center;justify-content:center;font-size:12px;margin-right:6px;vertical-align:middle";

export async function sidebarPanel(settings, { el, settingRow, switchHtml }) {
  const p = el(`<div class="panel" id="panel-sidebar">
    <h2>Side panel</h2>
    <p class="sub">Pages beside the one you're on: your bookmarks, reading list, history and notes, search, workspaces, extensions and an AI assistant -- and any site you pin to the rail. Pick which have a button on the rail.</p>

    <div class="setting-card" id="rail-items"><div class="k-card-title"><span class="k-label">On the rail</span></div></div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">AI assistant</span></div>
      ${settingRow({ title: "Assistant", desc: "Opens in the side panel. Right-click a page, or text on it: “Ask AI about this” asks it -- with your question typed in, where it takes one.", controlHtml: `<select class="field" id="ai-provider" style="width:190px">${Object.entries(AI_PROVIDERS).map(([id, a]) => `<option value="${id}">${escapeHtml(a.name)}</option>`).join("")}</select>` })}
      <div class="setting-row" id="ai-custom-row"><div class="info"><div class="title">Its address</div><div class="desc">%s in the address stands for your question, if it takes one there.</div></div><div class="control"><input class="field" id="ai-custom" style="width:260px" placeholder="https://example.com/chat?q=%s" spellcheck="false"></div></div>
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Workspaces</span></div>
      <div class="setting-row"><div class="info"><div class="desc">Named sets of tabs, switched from the top of the rail. A window shows one workspace's tabs at a time; the others' tabs sleep until you come back. Every window's are kept when Kessel closes, and a workspace's colour tints its window.</div></div><div class="control"><button class="btn sm" id="ws-add">${icon("plus", 13)}<span>New workspace</span></button></div></div>
      <div id="ws-list"></div>
    </div>
  </div>`);

  // Rail buttons, in the rail's order.
  const railCard = p.querySelector("#rail-items");
  const drawRail = () => {
    const on = currentSettings()?.sidebar_items ?? DEFAULT_RAIL_ITEMS;
    railCard.querySelectorAll(".setting-row").forEach((r) => r.remove());
    for (const item of RAIL_ITEMS) {
      const row = el(settingRow({ title: `<span style="vertical-align:middle">${icon(item.icon, 14)}</span> ${escapeHtml(item.label)}`, controlHtml: switchHtml(`rail-${item.id}`, on.includes(item.id)) }));
      row.querySelector(".switch").addEventListener("click", async () => {
        const now = currentSettings()?.sidebar_items ?? DEFAULT_RAIL_ITEMS;
        const next = now.includes(item.id) ? now.filter((x) => x !== item.id) : RAIL_ITEMS.map((i) => i.id).filter((id) => id === item.id || now.includes(id));
        await saveSettings({ sidebar_items: next });
        drawRail();
      });
      railCard.append(row);
    }
  };
  drawRail();

  const provider = p.querySelector("#ai-provider");
  const custom = p.querySelector("#ai-custom");
  provider.value = settings.ai_provider in AI_PROVIDERS ? settings.ai_provider : "chatgpt";
  custom.value = settings.ai_custom_url || "";
  const showCustom = () => (p.querySelector("#ai-custom-row").hidden = provider.value !== "custom");
  showCustom();
  provider.addEventListener("change", () => {
    showCustom();
    saveSettings({ ai_provider: provider.value });
  });
  custom.addEventListener("change", () => {
    const v = custom.value.trim();
    if (v && !/^https?:\/\//i.test(v)) return toast("An address starts with https://");
    saveSettings({ ai_custom_url: v });
  });

  // Workspaces: the list every window shares (the toolbar keeps the tabs).
  const list = p.querySelector("#ws-list");
  const stored = () => (Array.isArray(currentSettings()?.workspaces) ? currentSettings().workspaces : []);
  const drawWorkspaces = () => {
    const all = stored().filter((w) => w.id !== "");
    list.replaceChildren();
    for (const w of all) {
      const row = el(settingRow({ title: `<span style="${GLYPH};background:${escapeHtml(w.color || "#7c5cff")}">${escapeHtml(w.icon || "•")}</span><span class="ws-name"></span>`, controlHtml: `<button class="btn danger sm">Delete</button>` }));
      row.querySelector(".ws-name").textContent = w.name;
      row.querySelector("button").addEventListener("click", async () => {
        if (await confirmDialog(`Delete the workspace “${w.name}”? Its tabs move to your first workspace.`, "Delete")) saveSettings({ workspaces: stored().filter((x) => x.id !== w.id) });
      });
      list.append(row);
    }
    if (!all.length) list.append(el(`<div class="setting-row"><div class="info"><div class="desc faint">No workspaces yet -- just the one every window starts in.</div></div></div>`));
  };
  drawWorkspaces();
  p.querySelector("#ws-add").addEventListener("click", async () => {
    const n = stored().filter((w) => w.id !== "").length;
    const workspace = { id: `ws-${Date.now().toString(36)}`, name: `Workspace ${n + 2}`, icon: WORKSPACE_ICONS[(n + 1) % WORKSPACE_ICONS.length], color: WORKSPACE_COLORS[(n + 1) % WORKSPACE_COLORS.length] };
    await saveSettings({ workspaces: [...stored(), workspace] });
    toast("Added -- switch to it from the top of the rail; rename it in the side panel's Workspaces page");
  });
  window.addEventListener("kessel-settings", drawWorkspaces);
  return p;
}
