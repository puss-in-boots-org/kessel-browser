// kessel://privacy (privacy_stats.rs): what Shields did -- requests blocked,
// connections made secure, addresses cleaned of tracking -- day by day and
// on which sites; the protections you have on; what sites may use; how
// your saved passwords are; and every connection Kessel makes by itself
// (there's no telemetry to show: Kessel sends none).

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { toast, escapeHtml, confirmDialog } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

let days = 7;
let stats = null;

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const openSettings = (section) => invoke("open_singleton_tab", { route: `kessel://settings/${section}` }).catch((err) => toast(String(err)));

// Rows of a card: [title, detail, right-hand HTML, button?].
function rows(box, list, empty) {
  box.innerHTML = list.length ? "" : `<div class="empty">${escapeHtml(empty)}</div>`;
  for (const [title, detail, right, button] of list) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div><span class="t"></span><small></small></div><div>${right || ""}</div><div></div>`;
    row.querySelector(".t").textContent = title;
    row.querySelector("small").textContent = detail || "";
    if (button) {
      const b = document.createElement("button");
      b.className = "btn sm ghost";
      b.textContent = button.label;
      b.addEventListener("click", button.action);
      row.lastElementChild.appendChild(b);
    }
    box.appendChild(row);
  }
}

const badge = (on, onText = "On", offText = "Off") => `<span class="state ${on ? "ok" : "off"}">${on ? onText : offText}</span>`;

// --- What Shields did ------------------------------------------------------------------

function renderStats() {
  const perDay = new Map();
  for (const [hour, blocked, upgraded, stripped] of stats?.hours || []) {
    const key = dayKey(new Date(hour * 3600 * 1000));
    const c = perDay.get(key) || { blocked: 0, upgraded: 0, stripped: 0 };
    c.blocked += blocked;
    c.upgraded += upgraded;
    c.stripped += stripped;
    perDay.set(key, c);
  }
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(dayKey(d));
  }
  const sum = { blocked: 0, upgraded: 0, stripped: 0 };
  for (const k of keys) for (const f of Object.keys(sum)) sum[f] += perDay.get(k)?.[f] || 0;
  $("n-blocked").textContent = sum.blocked.toLocaleString();
  $("n-upgraded").textContent = sum.upgraded.toLocaleString();
  $("n-stripped").textContent = sum.stripped.toLocaleString();

  const chart = $("chart");
  chart.hidden = $("chart-axis").hidden = days === 1;
  const max = Math.max(1, ...keys.map((k) => perDay.get(k)?.blocked || 0));
  chart.innerHTML = "";
  for (const k of keys) {
    const n = perDay.get(k)?.blocked || 0;
    const bar = document.createElement("div");
    bar.className = `bar${n ? "" : " zero"}`;
    bar.style.height = `${Math.max(2, Math.round((n / max) * 100))}%`;
    bar.title = `${new Date(`${k}T12:00`).toLocaleDateString([], { month: "short", day: "numeric" })}: ${n.toLocaleString()} blocked`;
    chart.appendChild(bar);
  }
  const [first, last] = $("chart-axis").children;
  first.textContent = new Date(`${keys[0]}T12:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  last.textContent = "Today";

  $("since").textContent = stats?.since ? `Counted on this computer since ${new Date(stats.since * 1000).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" })} -- nothing of it leaves it.` : "";

  const top = stats?.sites || [];
  const most = Math.max(1, ...top.map(([, n]) => n));
  rows(
    $("sites"),
    top.slice(0, 10).map(([site, n]) => [site, "", `<div class="meter"><span style="width:${Math.round((n / most) * 100)}%"></span></div>`, { label: n.toLocaleString(), action: () => invoke("open_url", { url: `https://${site}`, how: "tab" }).catch(() => {}) }]),
    "Nothing blocked yet."
  );
  for (const row of $("sites").querySelectorAll(".row")) row.dataset.site = row.querySelector(".t").textContent;
}

// --- Your protections ------------------------------------------------------------------

async function renderProtections() {
  const s = currentSettings() || {};
  const shields = await invoke("shields_status").catch(() => null);
  const lists = (shields?.lists || []).filter((l) => l.enabled).length;
  const lock = await invoke("lock_status").catch(() => null);
  const change = (section) => ({ label: "Change", action: () => openSettings(section) });
  const list = [
    ["Shields: ads and trackers blocked", s.adblock_enabled ? `${lists} filter list${lists === 1 ? "" : "s"}` : "Pages load everything they ask for", badge(s.adblock_enabled), change("privacy")],
    ["Connections made secure", s.https_only ? "HTTPS-only: a site without it asks first" : "Sites that have HTTPS use it", badge(s.https_only || s.shields_https_upgrade, s.https_only ? "HTTPS-only" : "On"), change("security")],
    ["Tracking taken out of addresses", "utm_, fbclid, gclid and the like", badge(s.shields_strip_tracking), change("privacy")],
    ["Fingerprinting made harder", "Sites learn less about your screen, fonts and hardware", badge(s.shields_fingerprinting), change("privacy")],
    ["Other sites' cookies blocked", "Ads and trackers can't follow you from site to site", badge(s.block_third_party_cookies), change("cookies")],
    ["Dangerous sites and downloads warned about", "Phishing and malware lists, kept on this computer", badge(s.safe_browsing), change("security")],
    ["Global Privacy Control", "Tells sites not to sell or share what they learn about you", badge(s.send_gpc), change("privacy")],
    ["Browsing data cleared when Kessel closes", (s.clear_on_exit || []).join(", ") || "Nothing", badge((s.clear_on_exit || []).length > 0), change("privacy")],
    ["Kessel locked with a PIN or password", lock?.configured ? "Before your tabs show" : "Anyone at this computer sees your tabs", badge(!!lock?.configured), change("security")],
  ];
  if (s.always_private) list.push(["Every window private", "Nothing is kept after you close Kessel", badge(true), change("privacy")]);
  rows($("protections"), list, "");
}

// --- What sites may use ----------------------------------------------------------------

const KINDS = [["camera", "your camera"], ["microphone", "your microphone"], ["location", "your location"], ["notifications", "show you notifications"], ["clipboard", "see what you copied"], ["files", "edit files on your computer"]];

function renderPermissions() {
  const perms = currentSettings()?.features?.site_permissions || {};
  const list = [];
  for (const [kind, what] of KINDS) {
    const sites = Object.entries(perms).filter(([, p]) => p?.[kind] === "allow").map(([site]) => site);
    if (sites.length) list.push([`${sites.length} site${sites.length === 1 ? "" : "s"} may use ${what}`, sites.slice(0, 4).join(", ") + (sites.length > 4 ? ` and ${sites.length - 4} more` : ""), "", { label: "Manage", action: () => openSettings("permissions") }]);
  }
  rows($("permissions"), list, "No site may use your camera, microphone, location or anything else without asking.");
}

// --- Your saved passwords --------------------------------------------------------------

async function renderPasswords() {
  const box = $("passwords");
  let health;
  try {
    health = await invoke("vault_health");
  } catch {
    rows(box, [["Your passwords are locked", "Unlock them to see which are weak or used on more than one site", "", { label: "Open passwords", action: () => invoke("open_singleton_tab", { route: "kessel://passwords" }).catch(() => {}) }]], "");
    return;
  }
  const weak = health.filter((h) => h.strength <= 1).length;
  const reused = health.filter((h) => h.reused > 0).length;
  const check = { label: "Check them", action: () => invoke("open_singleton_tab", { route: "kessel://passwords" }).catch(() => {}) };
  rows(
    box,
    health.length
      ? [
          [`${health.length} saved password${health.length === 1 ? "" : "s"}`, "In the vault, encrypted on this computer", "", null],
          [`${weak} weak`, "Easy to guess", `<span class="state ${weak ? "warn" : "ok"}">${weak ? "Change them" : "None"}</span>`, weak ? check : null],
          [`${reused} used on more than one site`, "One leak opens the others", `<span class="state ${reused ? "warn" : "ok"}">${reused ? "Change them" : "None"}</span>`, reused ? check : null],
        ]
      : [],
    "No saved passwords."
  );
}

// --- What Kessel connects to by itself -------------------------------------------------

function renderConnections() {
  const s = currentSettings() || {};
  const f = s.features || {};
  const feeds = Array.isArray(f.feeds) ? f.feeds.length : 0;
  const list = [
    ["Filter lists for Shields", "Downloaded from their makers now and then, then used on this computer", badge(s.adblock_enabled), null],
    ["Lists of dangerous sites", "Downloaded, then checked on this computer -- the sites you visit aren't sent", badge(s.safe_browsing), null],
    ["Search suggestions", "What you type in the address bar goes to your search engine (never from a private window)", badge(s.search_suggestions !== false), null],
    ["Answers in the address bar", "Exchange rates from the European Central Bank, definitions from Wiktionary", badge(s.address_answers !== false), null],
    ["Extension updates", "Your extensions' own update addresses", badge(s.extensions_auto_update !== false), null],
    ["Feeds and watched pages", `The ${feeds} feed${feeds === 1 ? "" : "s"} you follow and the pages you watch, without your cookies`, badge(feeds > 0, "Yours", "None"), null],
    ["Password breach check", "Only when you ask: the first 5 characters of each password's hash, never the password", badge(true, "When asked"), null],
    ["Telemetry, crash reports, an account", "None of it: Kessel sends nothing about you or how you use it", `<span class="state ok">Never</span>`, null],
  ];
  rows($("connections"), list, "");
}

async function load() {
  stats = await invoke("privacy_stats").catch(() => null);
  renderStats();
  renderPermissions();
  renderConnections();
  await Promise.all([renderProtections(), renderPasswords()]);
  document.body.dataset.ready = "true";
}

window.addEventListener("DOMContentLoaded", async () => {
  $("title").innerHTML = `${icon("shieldCheck", 22)}<span>Privacy dashboard</span>`;
  await initTheme();
  for (const chip of document.querySelectorAll("#ranges .chip")) {
    chip.addEventListener("click", () => {
      days = Number(chip.dataset.days);
      for (const c of document.querySelectorAll("#ranges .chip")) c.classList.toggle("active", c === chip);
      renderStats();
    });
  }
  $("reset").addEventListener("click", async () => {
    if (!(await confirmDialog("Start counting what Shields blocks from zero?", "Start again"))) return;
    await invoke("reset_privacy_stats").catch((err) => toast(String(err)));
    load();
  });
  window.addEventListener("kessel-settings", () => {
    renderPermissions();
    renderConnections();
    renderProtections();
  });
  // Coming back to the tab: what's new.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
  await load();
});
