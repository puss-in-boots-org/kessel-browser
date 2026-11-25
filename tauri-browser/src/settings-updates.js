// Settings -> About -> Updates: which version you're on, whether there's a
// newer one, and automatic updates on or off (updater.rs).

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";
import { toast, formatRelativeTime } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const RELEASES = "https://github.com/puss-in-boots-org/kessel-browser/releases";

// What the status line says, and the button next to it.
export function describe(s) {
  const checked = s.last_checked ? ` · checked ${formatRelativeTime(s.last_checked)}` : "";
  switch (s.state) {
    case "checking":
      return { tone: "busy", title: "Looking for updates…", desc: `You're on Kessel ${s.current}`, button: null };
    case "downloading": {
      const pct = s.progress != null ? ` (${Math.round(s.progress * 100)}%)` : "";
      return { tone: "busy", title: `Downloading Kessel ${s.version}${pct}`, desc: "In the background -- keep browsing", button: null, progress: s.progress ?? null };
    }
    case "ready":
      return { tone: "ready", title: `Kessel ${s.version} is ready`, desc: "Restart to update. It takes a few seconds, and your tabs come back.", button: "install" };
    case "up-to-date":
      return { tone: "ok", title: "Kessel is up to date", desc: `Version ${s.current}${checked}`, button: "check" };
    case "error":
      return { tone: "error", title: "Couldn't check for updates", desc: s.error || "Something went wrong", button: "check" };
    default:
      return { tone: "idle", title: `Kessel ${s.current}`, desc: s.auto ? "Kessel looks for updates a minute after it starts, then every six hours" : "Automatic updates are off", button: "check" };
  }
}

export function updatesCard({ el, settingRow, switchHtml }) {
  const card = el(`<div class="setting-card" id="updates-card">
    <div class="k-card-title"><span class="k-label">Updates</span></div>
    <div class="setting-row update-status">
      <div class="update-badge" id="update-badge"></div>
      <div class="info"><div class="title" id="update-title"></div><div class="desc" id="update-desc"></div>
        <div class="update-bar" id="update-bar" hidden><span></span></div></div>
      <div class="control" id="update-action"></div>
    </div>
    ${settingRow({ title: "Update Kessel automatically", desc: "Downloads new versions from Kessel's GitHub releases in the background, checks their signature, and asks before restarting", controlHtml: switchHtml("auto-update", currentSettings()?.features?.auto_update !== false) })}
    ${settingRow({ title: "Release notes", desc: "What changed in each version", controlHtml: `<button class="btn sm" id="release-notes-btn">${icon("popOut", 13)} Open</button>` })}
  </div>`);

  const render = (s) => {
    const d = describe(s);
    card.querySelector("#update-badge").className = `update-badge ${d.tone}`;
    card.querySelector("#update-badge").innerHTML = icon({ ready: "download", ok: "check", error: "warning", busy: "refresh" }[d.tone] || "bolt", 16);
    card.querySelector("#update-title").textContent = d.title;
    card.querySelector("#update-desc").textContent = d.desc;
    const bar = card.querySelector("#update-bar");
    bar.hidden = d.progress == null;
    if (d.progress != null) bar.firstElementChild.style.width = `${Math.round(d.progress * 100)}%`;
    const action = card.querySelector("#update-action");
    action.innerHTML =
      d.button === "install"
        ? `<button class="btn sm primary" id="update-install">${icon("refresh", 13)} Restart to update</button>`
        : d.button === "check"
          ? `<button class="btn sm" id="update-check">${icon("search", 13)} Check now</button>`
          : "";
    action.querySelector("#update-install")?.addEventListener("click", () => invoke("install_update").catch((err) => toast(String(err))));
    action.querySelector("#update-check")?.addEventListener("click", async () => {
      render({ ...s, state: "checking" });
      render(await invoke("check_for_updates").catch((err) => ({ ...s, state: "error", error: String(err) })));
    });
  };

  invoke("update_status").then(render).catch(() => {});
  listen("kessel-update", (event) => event.payload && card.isConnected && render(event.payload));

  const auto = card.querySelector("#auto-update");
  auto.addEventListener("click", async () => {
    const on = !auto.classList.contains("on");
    await saveSettings({ features: { ...(currentSettings()?.features || {}), auto_update: on } });
    auto.classList.toggle("on", on);
    auto.setAttribute("aria-checked", String(on));
    invoke("update_status").then(render).catch(() => {});
  });
  card.querySelector("#release-notes-btn").addEventListener("click", () => invoke("new_tab", { url: RELEASES }).catch(() => window.open(RELEASES)));
  return card;
}

