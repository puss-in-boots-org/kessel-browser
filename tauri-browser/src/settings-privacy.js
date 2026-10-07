// Settings -> Privacy (the parts beyond Shields), Cookies & site data, and
// Security (settings.js builds the rest of the page and hands its helpers
// in). The work happens in privacy.rs and security.rs.

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";
import { toast, escapeHtml, confirmDialog, debounce } from "./shared/api.js";
import { lockCard } from "./settings-lock.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function selectHtml(id, options, width = 180) {
  return `<select class="field" id="${id}" style="width:${width}px">${options.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select>`;
}

// A <select> bound to a setting, kept in step when it changes elsewhere.
function wireSelect(panel, id, key, { parse = (v) => v, message } = {}) {
  const select = panel.querySelector(`#${id}`);
  select.value = String(currentSettings()?.[key] ?? "");
  select.addEventListener("change", async () => {
    await saveSettings({ [key]: parse(select.value) });
    if (message) toast(message);
  });
  window.addEventListener("kessel-settings", () => {
    const value = currentSettings()?.[key];
    if (value != null && document.activeElement !== select) select.value = String(value);
  });
  return select;
}

// Settings that change the engine's command line apply after a restart: a
// button to do it appears once you've changed one. (Shown through its style:
// .btn's display beats the hidden attribute.)
function restartButton() {
  return `<button class="btn sm restart-btn" style="display:none">${icon("refresh", 13)}<span>Restart now</span></button>`;
}

function wireRestart(panel, switchId) {
  const row = panel.querySelector(`#${switchId}`).closest(".setting-row");
  const restart = row.querySelector(".restart-btn");
  panel.querySelector(`#${switchId}`).addEventListener("click", () => (restart.style.display = ""));
  restart.addEventListener("click", () => invoke("restart_kessel").catch((err) => toast(String(err))));
}

// --- Privacy ----------------------------------------------------------------

// The rest of Settings -> Privacy, after Shields' own switches.
export function privacyExtras(panel, settings, { el, settingRow, switchHtml, wireSwitch }) {
  const card = el(`<div class="setting-card" id="privacy-extras">
    ${settingRow({ title: "Skip tracking redirects", desc: "Links through google.com/url, l.facebook.com and other click-counting pages go straight to where they point (with Shields)", controlHtml: switchHtml("debounce-toggle", settings.shields_debounce !== false) })}
    ${settingRow({ title: "Send Global Privacy Control", desc: "Tells every site not to sell or share your data (Sec-GPC) -- a legal opt-out in some places", controlHtml: switchHtml("gpc-toggle", settings.send_gpc !== false) })}
    ${settingRow({ title: "Send Do Not Track", desc: "The older request not to be tracked. Few sites honour it, and sending it makes you stand out a little", controlHtml: switchHtml("dnt-toggle", !!settings.send_dnt) })}
    ${settingRow({ title: "Referrer", desc: "What a site sees of the page you came from", controlHtml: selectHtml("referrer-select", [["default", "Just the site (default)"], ["same-site", "Nothing, to other sites"], ["none", "Nothing, ever"]], 200) })}
    ${settingRow({ title: "User agent", desc: "What Kessel tells sites it is (tabs you open from now on)", controlHtml: selectHtml("ua-select", [["default", "Kessel (Edge's engine)"], ["chrome", "Google Chrome"], ["custom", "Your own…"]], 200) })}
    <div class="setting-row" id="ua-custom-row"><div class="info"><div class="title">Your user agent</div></div><div class="control" style="flex:1;max-width:440px"><input class="field" id="ua-custom" placeholder="Mozilla/5.0 (…)" spellcheck="false" /></div></div>
    ${settingRow({ title: "Report UTC as your time zone", desc: "Sites can't tell where you are from your clock -- they'll show times in UTC", controlHtml: switchHtml("tz-toggle", !!settings.fp_timezone) })}
    ${settingRow({ title: "Always use private windows", desc: "Every window opens as a private one: no history, and sites' cookies and data go when it closes", controlHtml: switchHtml("always-private-toggle", !!settings.always_private) })}
  </div>`);
  const cards = panel.querySelectorAll(".setting-card");
  (cards[1] || cards[0]).after(card);

  wireSwitch(panel, "debounce-toggle", "shields_debounce", { defaultOn: true });
  wireSwitch(panel, "gpc-toggle", "send_gpc", { defaultOn: true });
  wireSwitch(panel, "dnt-toggle", "send_dnt");
  wireSwitch(panel, "tz-toggle", "fp_timezone");
  wireSwitch(panel, "always-private-toggle", "always_private");
  wireSelect(panel, "referrer-select", "referrer_policy");
  const ua = wireSelect(panel, "ua-select", "user_agent", { message: "Applies to tabs you open from now on" });
  const customRow = panel.querySelector("#ua-custom-row");
  const custom = panel.querySelector("#ua-custom");
  custom.value = settings.user_agent_custom || "";
  const showCustom = () => (customRow.style.display = ua.value === "custom" ? "" : "none");
  showCustom();
  ua.addEventListener("change", showCustom);
  custom.addEventListener("input", debounce(() => saveSettings({ user_agent_custom: custom.value.trim() }), 500));
}

// --- Cookies & site data ------------------------------------------------------

const EXIT_KINDS = [
  ["history", "Browsing history"],
  ["downloads", "Downloads list"],
  ["cookies", "Cookies and site data"],
  ["cache", "Cached files"],
  ["autofill", "Autofill form data"],
  ["site_settings", "Site settings (zoom, permissions)"],
];

const RULE_NAMES = { allow: "Allow", session: "Until I close Kessel", block: "Block" };

function expiresText(cookie) {
  if (cookie.expires == null) return "until Kessel closes";
  const date = new Date(cookie.expires * 1000);
  return `until ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// A <input type=datetime-local> value for unix seconds, and back.
function toLocalInput(seconds) {
  if (seconds == null) return "";
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t / 1000 : null;
}

// The cookie editor: a new cookie (`cookie` null) or a change to one.
function editCookie(cookie, onSaved) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop open";
  backdrop.innerHTML = `
    <div class="modal" style="padding:20px 22px;width:460px;max-width:92vw">
      <h3 style="margin:0 0 14px;font-size:15px">${cookie ? "Edit cookie" : "Add a cookie"}</h3>
      <div style="display:grid;grid-template-columns:90px 1fr;gap:9px 12px;align-items:center;font-size:12.5px">
        <label for="ck-name">Name</label><input class="field" id="ck-name" spellcheck="false" />
        <label for="ck-value">Value</label><textarea class="field" id="ck-value" rows="3" spellcheck="false" style="resize:vertical;font-family:var(--mono,monospace);font-size:12px"></textarea>
        <label for="ck-domain">Domain</label><input class="field" id="ck-domain" placeholder=".example.com" spellcheck="false" />
        <label for="ck-path">Path</label><input class="field" id="ck-path" placeholder="/" spellcheck="false" />
        <label for="ck-expires">Expires</label><input class="field" id="ck-expires" type="datetime-local" title="Empty: until Kessel closes" />
        <label for="ck-samesite">SameSite</label><select class="field" id="ck-samesite"><option value="lax">Lax</option><option value="strict">Strict</option><option value="none">None (needs Secure)</option></select>
        <span></span><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="ck-secure" /> Secure (https only)</label>
        <span></span><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="ck-httponly" /> HttpOnly (hidden from the page's scripts)</label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <button class="btn ghost" id="ck-cancel">Cancel</button>
        <button class="btn primary" id="ck-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const $ = (id) => backdrop.querySelector(`#${id}`);
  const c = cookie || { name: "", value: "", domain: "", path: "/", expires: null, same_site: "lax", secure: false, http_only: false };
  $("ck-name").value = c.name;
  $("ck-value").value = c.value;
  $("ck-domain").value = c.domain;
  $("ck-path").value = c.path || "/";
  $("ck-expires").value = toLocalInput(c.expires);
  $("ck-samesite").value = c.same_site || "lax";
  $("ck-secure").checked = !!c.secure;
  $("ck-httponly").checked = !!c.http_only;
  const done = () => backdrop.remove();
  $("ck-cancel").addEventListener("click", done);
  backdrop.addEventListener("click", (e) => e.target === backdrop && done());
  $("ck-save").addEventListener("click", async () => {
    const next = {
      name: $("ck-name").value.trim(),
      value: $("ck-value").value,
      domain: $("ck-domain").value.trim(),
      path: $("ck-path").value.trim() || "/",
      expires: fromLocalInput($("ck-expires").value),
      same_site: $("ck-samesite").value,
      secure: $("ck-secure").checked,
      http_only: $("ck-httponly").checked,
    };
    try {
      await invoke("save_cookie", { cookie: next, original: cookie ? { name: cookie.name, domain: cookie.domain, path: cookie.path } : null });
      done();
      onSaved();
    } catch (err) {
      toast(String(err));
    }
  });
  $("ck-name").focus();
}

export async function cookiesPanel(settings, { el, settingRow, switchHtml, wireSwitch }) {
  const panel = el(`<div class="panel" id="panel-cookies">
    <h2>Cookies &amp; site data</h2>
    <p class="sub">What sites keep on this PC: cookies, and the storage, caches and service workers that go with them.</p>

    <div class="setting-card">
      ${settingRow({ title: "Block other sites' cookies", desc: "Cookies of sites embedded in a page (ads, trackers, social buttons) are refused -- ones kept just for that page still work. After a restart", controlHtml: `${restartButton()}${switchHtml("third-party-toggle", settings.block_third_party_cookies !== false)}` })}
      ${settingRow({ title: "Sites may keep cookies", desc: "Your rules for single sites below come first", controlHtml: selectHtml("cookies-default", [["allow", "Yes"], ["session", "Until you close Kessel"], ["block", "No (breaks sign-ins)"]], 210) })}
      ${settingRow({ title: "Keep cookies at most", desc: "Cookies that ask to live longer are cut short", controlHtml: selectHtml("cookie-max-days", [["0", "As long as sites ask"], ["1", "1 day"], ["7", "1 week"], ["30", "1 month"], ["90", "3 months"], ["365", "1 year"]], 210) })}
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Your site rules</div><div class="desc">“example.com” covers its subdomains too. The lock in the address bar sets one for the site you're on.</div></div></div>
      <div class="list-panel" id="cookie-rules"></div>
      <div class="add-row"><input class="field" id="rule-site" placeholder="example.com" spellcheck="false" />${selectHtml("rule-kind", Object.entries(RULE_NAMES), 190)}<button class="btn sm" id="rule-add">Add</button></div>
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">When Kessel closes, delete</div><div class="desc">Each time you quit (its last window closes)</div></div></div>
      <div id="exit-kinds" style="display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;padding:2px 16px 14px;font-size:12.5px"></div>
    </div>

    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Cookies on this PC</div><div class="desc" id="cookie-summary">Looking…</div></div>
        <div class="control" style="gap:6px">
          <button class="btn sm" id="cookie-add">${icon("plus", 13)}<span>Add</span></button>
          <button class="btn sm icon-only" id="cookie-refresh" title="Look again">${icon("refresh", 13)}</button>
        </div>
      </div>
      <div class="add-row" style="border-top:none;padding-top:0"><input class="field" id="cookie-search" placeholder="Find a site or cookie" spellcheck="false" /></div>
      <div class="list-panel" id="cookie-list" style="max-height:560px"></div>
    </div>
  </div>`);

  wireSwitch(panel, "third-party-toggle", "block_third_party_cookies", { defaultOn: true });
  wireRestart(panel, "third-party-toggle");
  wireSelect(panel, "cookies-default", "cookies_default");
  wireSelect(panel, "cookie-max-days", "cookie_max_days", { parse: (v) => parseInt(v, 10) || 0 });

  // --- Site rules ---
  const rulesEl = panel.querySelector("#cookie-rules");
  function renderRules() {
    const rules = currentSettings()?.cookie_rules || [];
    rulesEl.innerHTML = rules.length ? "" : `<div class="empty">None yet.</div>`;
    for (const rule of rules) {
      const row = el(`<div class="list-row"><span class="lr-title"></span><span style="display:flex;gap:6px;align-items:center">${selectHtml("", Object.entries(RULE_NAMES), 170)}<button class="btn ghost icon-only sm" title="Remove">${icon("trash", 13)}</button></span></div>`);
      row.querySelector(".lr-title").textContent = rule.site;
      const select = row.querySelector("select");
      select.removeAttribute("id");
      select.value = rule.rule;
      select.addEventListener("change", () => invoke("set_cookie_rule", { site: rule.site, rule: select.value }).catch((err) => toast(String(err))));
      row.querySelector("button").addEventListener("click", () => invoke("set_cookie_rule", { site: rule.site, rule: "" }).catch((err) => toast(String(err))));
      rulesEl.appendChild(row);
    }
  }
  renderRules();
  window.addEventListener("kessel-settings", renderRules);
  panel.querySelector("#rule-add").addEventListener("click", async () => {
    const input = panel.querySelector("#rule-site");
    const site = input.value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!site) return;
    try {
      await invoke("set_cookie_rule", { site, rule: panel.querySelector("#rule-kind").value });
      input.value = "";
    } catch (err) {
      toast(String(err));
    }
  });

  // --- Clear on exit ---
  const exitEl = panel.querySelector("#exit-kinds");
  for (const [kind, label] of EXIT_KINDS) {
    const item = el(`<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" /><span></span></label>`);
    item.querySelector("span").textContent = label;
    const box = item.querySelector("input");
    box.checked = (settings.clear_on_exit || []).includes(kind);
    box.addEventListener("change", async () => {
      const now = new Set(currentSettings()?.clear_on_exit || []);
      if (box.checked) now.add(kind);
      else now.delete(kind);
      await saveSettings({ clear_on_exit: EXIT_KINDS.map(([k]) => k).filter((k) => now.has(k)) });
    });
    exitEl.appendChild(item);
  }

  // --- The cookies themselves ---
  const listEl = panel.querySelector("#cookie-list");
  const search = panel.querySelector("#cookie-search");
  const open = new Set();
  let cookies = [];

  function render() {
    const text = search.value.trim().toLowerCase();
    const bySite = new Map();
    for (const c of cookies) {
      if (text && !c.site.includes(text) && !c.domain.toLowerCase().includes(text) && !c.name.toLowerCase().includes(text)) continue;
      if (!bySite.has(c.site)) bySite.set(c.site, []);
      bySite.get(c.site).push(c);
    }
    const sites = [...bySite.keys()].sort();
    const siteCount = new Set(cookies.map((c) => c.site)).size;
    panel.querySelector("#cookie-summary").textContent = `${cookies.length} ${cookies.length === 1 ? "cookie" : "cookies"} from ${siteCount} ${siteCount === 1 ? "site" : "sites"}`;
    listEl.innerHTML = sites.length ? "" : `<div class="empty">${text ? "Nothing matches." : "No cookies."}</div>`;
    for (const site of sites.slice(0, 300)) {
      const list = bySite.get(site);
      const expanded = open.has(site) || (text && sites.length <= 3);
      const head = el(`<div class="list-row" style="cursor:pointer">
        <span class="lr-title"><b></b> <span class="lr-sub"></span></span>
        <span style="display:flex;gap:4px">
          <button class="btn ghost sm" data-act="data">${icon("broom", 13)}<span>Delete site data</span></button>
        </span></div>`);
      head.querySelector("b").textContent = site;
      head.querySelector(".lr-sub").textContent = `${list.length} ${list.length === 1 ? "cookie" : "cookies"}`;
      head.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        if (open.has(site)) open.delete(site);
        else open.add(site);
        render();
      });
      head.querySelector("[data-act=data]").addEventListener("click", async () => {
        if (!(await confirmDialog(`Delete everything ${site} keeps on this PC -- its cookies, storage and caches? You'll be signed out of it.`, "Delete"))) return;
        const n = await invoke("clear_site_data", { site }).catch((err) => (toast(String(err)), null));
        if (n != null) toast(`Deleted ${site}'s data`);
        load();
      });
      listEl.appendChild(head);
      if (!expanded) continue;
      for (const c of list) {
        const row = el(`<div class="list-row" style="padding-left:28px">
          <span class="lr-title" style="display:flex;flex-direction:column;gap:2px;min-width:0">
            <span class="name" style="font-weight:600;overflow:hidden;text-overflow:ellipsis"></span>
            <span class="lr-sub where"></span>
          </span>
          <span style="display:flex;gap:4px;flex-shrink:0">
            <button class="btn ghost icon-only sm" data-act="edit" title="Edit">${icon("edit", 13)}</button>
            <button class="btn ghost icon-only sm" data-act="delete" title="Delete">${icon("trash", 13)}</button>
          </span></div>`);
        row.querySelector(".name").textContent = c.name;
        const flags = [c.secure && "Secure", c.http_only && "HttpOnly", c.same_site !== "lax" && `SameSite=${c.same_site}`].filter(Boolean).join(" · ");
        row.querySelector(".where").textContent = `${c.domain}${c.path !== "/" ? c.path : ""} · ${expiresText(c)}${flags ? ` · ${flags}` : ""}`;
        row.title = c.value.length > 300 ? `${c.value.slice(0, 300)}…` : c.value;
        row.querySelector("[data-act=edit]").addEventListener("click", () => editCookie(c, load));
        row.querySelector("[data-act=delete]").addEventListener("click", async () => {
          await invoke("delete_cookies", { cookies: [{ name: c.name, domain: c.domain, path: c.path }] }).catch((err) => toast(String(err)));
          load();
        });
        listEl.appendChild(row);
      }
    }
  }

  async function load() {
    try {
      cookies = await invoke("get_cookies", {});
    } catch (err) {
      cookies = [];
      panel.querySelector("#cookie-summary").textContent = `Couldn't look: ${err}`;
    }
    render();
  }
  search.addEventListener("input", debounce(render, 150));
  panel.querySelector("#cookie-refresh").addEventListener("click", load);
  panel.querySelector("#cookie-add").addEventListener("click", () => editCookie(null, load));
  listen("cookies-changed", debounce(load, 300));
  load();
  return panel;
}

// kessel://settings/cookies:<site> -- the cookies panel, found to that site.
export function focusCookies(site) {
  const search = document.querySelector("#panel-cookies #cookie-search");
  if (!search) return;
  search.value = site || "";
  search.dispatchEvent(new Event("input"));
}

// --- Security --------------------------------------------------------------------

function ago(unix) {
  if (!unix) return "not downloaded yet";
  const mins = Math.round((Date.now() / 1000 - unix) / 60);
  if (mins < 2) return "updated just now";
  if (mins < 90) return `updated ${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 36 ? `updated ${hours} hours ago` : `updated ${Math.round(hours / 24)} days ago`;
}

export async function securityPanel(settings, { el, settingRow, switchHtml, wireSwitch }) {
  const panel = el(`<div class="panel" id="panel-security">
    <h2>Security</h2>
    <p class="sub">Warning pages before dangerous sites, insecure connections and broken certificates -- and a second look at risky downloads.</p>

    <div class="setting-card">
      ${settingRow({ title: "Block dangerous sites", desc: "Malware, phishing and fake download sites get a warning page first. Checked on this PC against public lists -- nothing about where you go is sent anywhere", controlHtml: switchHtml("safe-toggle", settings.safe_browsing !== false) })}
      <div id="security-lists"></div>
      ${settingRow({ title: "Warn about risky downloads", desc: "Programs that came over an insecure connection, and files from dangerous sites, wait until you keep them", controlHtml: switchHtml("download-warn-toggle", settings.warn_dangerous_downloads !== false) })}
      ${settingRow({ title: "Microsoft Defender SmartScreen", desc: "Also checks pages and downloads against Microsoft's reputation service -- the addresses you visit are sent to Microsoft. After a restart", controlHtml: `${restartButton()}${switchHtml("smartscreen-toggle", !!settings.smartscreen)}` })}
    </div>

    <div class="setting-card">
      ${settingRow({ title: "HTTPS-only mode", desc: "Every site opens on a secure connection. One without a secure version gets a warning page before it loads insecurely (addresses on your own network are left alone)", controlHtml: switchHtml("https-only-toggle", !!settings.https_only) })}
      ${settingRow({ title: "Certificate errors", desc: "A site whose certificate is wrong gets a warning page, and whatever you decide lasts until Kessel restarts. The lock in the address bar shows any site's certificate", controlHtml: "" })}
    </div>
  </div>`);

  wireSwitch(panel, "safe-toggle", "safe_browsing", { defaultOn: true });
  wireSwitch(panel, "download-warn-toggle", "warn_dangerous_downloads", { defaultOn: true });
  wireSwitch(panel, "smartscreen-toggle", "smartscreen");
  wireRestart(panel, "smartscreen-toggle");
  wireSwitch(panel, "https-only-toggle", "https_only");
  lockCard(panel, { el, settingRow, switchHtml });

  const holder = panel.querySelector("#security-lists");
  async function renderLists() {
    const status = await invoke("security_status").catch(() => null);
    if (!status) return;
    holder.innerHTML = "";
    for (const list of status.lists) {
      const detail = list.error ? `Couldn't update: ${list.error}` : ago(list.updated_at);
      const row = el(`<div class="setting-row" style="padding-left:34px"><div class="info"><div class="title" style="font-size:12.5px"></div><div class="desc"></div></div></div>`);
      row.querySelector(".title").textContent = list.name;
      row.querySelector(".desc").textContent = detail;
      holder.appendChild(row);
    }
  }
  renderLists();
  listen("security-lists-changed", renderLists);
  return panel;
}
