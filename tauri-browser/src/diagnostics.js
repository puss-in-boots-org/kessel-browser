// kessel://diagnostics (see diagnostics.html): Kessel and its engine, this
// PC (tasks.rs system_info), the network as the engine sees it, how much
// room Kessel's data takes, the crash log (crash.rs) and which web
// features work here. Web features are tried in this page -- the same
// engine websites get.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { toast, escapeHtml } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

// Shields' fingerprinting protection blurs some of these for websites.
window.__kesselFarbleOff = true;

function bytes(n) {
  if (n == null) return "?";
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d} day${d === 1 ? "" : "s"}`, h && `${h} h`, `${m} min`].filter(Boolean).join(" ");
}

const row = (label, value, detail = "", level = "") => ({ label, value: String(value ?? ""), detail, level });

function rowHtml(r) {
  const badge = r.level ? `<span class="state ${r.level}">${r.level === "ok" ? "✓" : r.level === "warn" ? "!" : "—"}</span>` : "<span></span>";
  return `<div class="row"><div class="label">${escapeHtml(r.label)}</div><div class="value">${escapeHtml(r.value)}${r.detail ? `<small>${escapeHtml(r.detail)}</small>` : ""}</div>${badge}</div>`;
}

const section = (id, title, inner, extra = "") => `<h2 id="${id}"><span class="grow">${escapeHtml(title)}</span>${extra}</h2>${inner}`;
const card = (rows) => `<div class="card">${rows.map(rowHtml).join("")}</div>`;

// --- Sections -------------------------------------------------------------------

function kesselRows(about, sys) {
  return [
    row("Kessel", about.version),
    row("Engine", `WebView2 ${about.engine}`),
    row("Profile", about.profile, about.profile_dir),
    row("Safe mode", sys.safe_mode ? "On" : "Off", sys.safe_mode ? `Because ${sys.safe_mode}` : "", sys.safe_mode ? "warn" : "ok"),
    row("Engine command line", sys.engine_args || "(none)"),
  ];
}

function pcRows(sys) {
  const rows = [];
  const os = sys.os || {};
  rows.push(row("Windows", [os.name, os.version].filter(Boolean).join(" "), os.build ? `Build ${os.build} · ${sys.arch}` : sys.arch));
  rows.push(row("Processor", sys.cpu || "?", `${sys.threads} threads`));
  if (sys.memory) {
    rows.push(row("Memory", `${bytes(sys.memory.total)} in all`, `${bytes(sys.memory.available)} free right now (${sys.memory.load}% in use)`, sys.memory.load >= 90 ? "warn" : ""));
  }
  if (os.uptime) rows.push(row("Running since the last restart", duration(os.uptime)));
  return rows;
}

function networkRows(settings) {
  const rows = [];
  rows.push(row("Connection", navigator.onLine ? "Online" : "Offline", navigator.onLine ? "" : "Windows says this PC isn't connected to a network", navigator.onLine ? "ok" : "warn"));
  const c = navigator.connection;
  if (c) {
    const speed = [c.effectiveType && `Like ${c.effectiveType.toUpperCase()}`, c.downlink && `about ${c.downlink} Mbit/s down`, c.rtt != null && `${c.rtt} ms round trip`].filter(Boolean).join(", ");
    rows.push(row("Speed (the engine's estimate)", speed || "Unknown", c.saveData ? "Data Saver is on" : ""));
  }
  const proxy = settings?.features?.proxy || {};
  const proxyText = { direct: "None: straight to the internet", fixed: `Your own: ${proxy.server || "?"}`, pac: `A PAC script: ${proxy.pac || "?"}` }[proxy.mode] || "Windows' proxy settings";
  rows.push(row("Proxy", proxyText, "Settings → Network"));
  return rows;
}

function storageHtml(sys) {
  const rows = (sys.storage || []).map((s) => row(s.what, s.complete ? bytes(s.bytes) : `More than ${bytes(s.bytes)}`));
  return card(rows);
}

const KIND_LABELS = {
  page: "A page's process stopped",
  frame: "A frame's process stopped",
  unresponsive: "A page stopped responding",
  gpu: "The graphics process stopped",
  utility: "A helper process stopped",
  engine: "The engine stopped",
  other: "A process of the engine stopped",
  kessel: "Kessel",
  file: "A data file was damaged",
};

function exitCode(code) {
  if (!code) return "";
  return code < 0 ? `0x${(code >>> 0).toString(16).toUpperCase()}` : String(code);
}

function crashesHtml(list) {
  if (!list.length) return `<div class="card"><div class="empty">No crashes. Kessel notes every one here: a page's, the engine's, its own, and damaged data files.</div></div>`;
  const rows = list
    .map((c) => {
      const when = new Date(c.at * 1000).toLocaleString();
      const what = [KIND_LABELS[c.kind] || c.kind, c.what].filter(Boolean).join(": ");
      const details = [c.reason, c.exit_code ? `exit code ${exitCode(c.exit_code)}` : "", c.module].filter(Boolean).join(" · ");
      return `<tr data-kind="${escapeHtml(c.kind)}"><td style="white-space:nowrap">${escapeHtml(when)}</td><td>${escapeHtml(what)}${c.url ? `<small>${escapeHtml(c.url)}</small>` : ""}</td><td>${escapeHtml(details)}</td></tr>`;
    })
    .join("");
  return `<div class="card"><table><tr><th>When</th><th>What</th><th>Why</th></tr>${rows}</table></div>`;
}

// [name, present?, note] -- tried here, in the same engine pages get.
function features() {
  const has = (f) => {
    try {
      return !!f();
    } catch {
      return false;
    }
  };
  const css = (rule) => has(() => CSS.supports(rule));
  const noChooser = "The engine has it, but WebView2 has no window to pick a device in, so sites can't use one";
  return [
    ["Service workers (offline sites)", has(() => "serviceWorker" in navigator)],
    ["Web workers / shared workers", has(() => typeof Worker === "function" && typeof SharedWorker === "function")],
    ["WebAssembly", has(() => typeof WebAssembly === "object")],
    ["WebAssembly threads (SharedArrayBuffer)", has(() => typeof SharedArrayBuffer === "function"), "Only on sites that ask for cross-origin isolation"],
    ["WebGL 2", has(() => document.createElement("canvas").getContext("webgl2"))],
    ["WebGPU", has(() => navigator.gpu)],
    ["WebCodecs", has(() => typeof VideoDecoder === "function")],
    ["Media Source Extensions (streaming video)", has(() => typeof MediaSource === "function")],
    ["WebRTC (video calls)", has(() => typeof RTCPeerConnection === "function")],
    ["Screen sharing", has(() => navigator.mediaDevices?.getDisplayMedia)],
    ["WebSockets / WebTransport", has(() => typeof WebSocket === "function" && typeof WebTransport === "function")],
    ["Picture-in-picture", has(() => document.pictureInPictureEnabled)],
    ["Notifications", has(() => typeof Notification === "function"), "Kessel asks you per site"],
    ["Push messages", has(() => typeof PushManager === "function"), "Present, but WebView2 has no push service: sites can't reach you while closed"],
    ["Background sync", has(() => typeof SyncManager === "function")],
    ["Geolocation", has(() => navigator.geolocation)],
    ["Clipboard (async)", has(() => navigator.clipboard?.readText)],
    ["Web Share", has(() => navigator.share), "Kessel's share button works on every page either way"],
    ["Passkeys (WebAuthn)", has(() => typeof PublicKeyCredential === "function")],
    ["Payment Request", has(() => typeof PaymentRequest === "function")],
    ["File System Access", has(() => typeof showOpenFilePicker === "function")],
    ["Web Locks", has(() => navigator.locks)],
    ["Wake Lock (keep the screen on)", has(() => navigator.wakeLock)],
    ["Speech synthesis (read aloud)", has(() => speechSynthesis)],
    ["Speech recognition", has(() => window.SpeechRecognition || window.webkitSpeechRecognition), "Needs Microsoft's online speech service"],
    ["Web MIDI", has(() => navigator.requestMIDIAccess), "Kessel asks you per site"],
    ["Web Bluetooth", has(() => navigator.bluetooth), noChooser],
    ["WebUSB", has(() => navigator.usb), noChooser],
    ["Web Serial", has(() => navigator.serial), noChooser],
    ["WebHID", has(() => navigator.hid), noChooser],
    ["WebXR (VR and AR)", has(() => navigator.xr), "No headset support in WebView2"],
    ["EyeDropper", has(() => typeof EyeDropper === "function")],
    ["View transitions", has(() => document.startViewTransition)],
    ["Popover", has(() => HTMLElement.prototype.togglePopover)],
    ["CSS :has() and container queries", css("selector(:has(a))") && css("container-type: inline-size")],
    ["Compression streams", has(() => typeof CompressionStream === "function")],
    ["Storage Access API", has(() => document.requestStorageAccess)],
  ];
}

function featuresHtml(list) {
  const rows = list.map(([name, ok, note]) => {
    const limited = note && /no window to pick|no headset|no push/i.test(note);
    const level = !ok ? "off" : limited ? "warn" : "ok";
    return row(name, ok ? (limited ? "Present, but limited" : "Yes") : "No", note || "", level);
  });
  return card(rows);
}

// --- The page ---------------------------------------------------------------------

let report = "";

function reportText(groups, crashes) {
  const lines = [];
  for (const [title, rows] of groups) {
    lines.push(`== ${title} ==`);
    for (const r of rows) lines.push(`${r.label}: ${r.value}${r.detail ? ` (${r.detail})` : ""}`);
  }
  lines.push("== Crash reports ==");
  for (const c of crashes.slice(0, 30)) lines.push(`${new Date(c.at * 1000).toISOString()} ${c.kind} ${c.what} ${c.url} ${c.reason} ${exitCode(c.exit_code)} ${c.module}`.replace(/\s+/g, " ").trim());
  return lines.join("\n");
}

async function render() {
  const [about, sys, crashes, settings] = await Promise.all([
    invoke("about_info"),
    invoke("system_info"),
    invoke("crash_reports").catch(() => []),
    invoke("get_settings").catch(() => ({})),
  ]);
  const safe = $("safe-mode");
  safe.hidden = !sys.safe_mode;
  if (sys.safe_mode) {
    safe.innerHTML = `${icon("warning", 16)}<span>Kessel is in safe mode because ${escapeHtml(sys.safe_mode)}: extensions are off, the graphics card isn't used, and your own engine switches are left out.</span><button class="btn sm" id="normal-btn">Restart normally</button>`;
    $("normal-btn").addEventListener("click", () => invoke("restart_in_mode", { safe: false }).catch((err) => toast(String(err))));
  }
  const kessel = kesselRows(about, sys);
  const pc = pcRows(sys);
  const network = networkRows(settings);
  const featureList = features();
  const safeButton = sys.safe_mode ? "" : `<button class="btn sm ghost" id="safe-btn">Restart in safe mode</button>`;
  $("sections").innerHTML =
    section("kessel", "Kessel", card(kessel), safeButton) +
    section("pc", "This PC", card(pc)) +
    section("network", "Network", card(network)) +
    section("storage", "Storage", storageHtml(sys), `<button class="btn sm ghost" id="clear-btn">Clear browsing data…</button>`) +
    section("crashes", "Crash reports", crashesHtml(crashes), crashes.length ? `<button class="btn sm ghost" id="clear-crashes-btn">Clear</button>` : "") +
    section("features", "Web features", featuresHtml(featureList)) +
    section(
      "more",
      "More",
      `<div class="card"><div class="row"><div class="label">A site's certificate</div><div class="value">Click the lock in the address bar, then Certificate</div><span></span></div>` +
        `<div class="row"><div class="label">Site permissions</div><div class="value">Camera, location, pop-ups and the rest, per site</div><button class="btn sm" id="perm-btn">Open</button></div>` +
        `<div class="row"><div class="label">Graphics and media</div><div class="value">The graphics card, video formats, DRM</div><button class="btn sm" id="gpu-link">Open</button></div></div>`,
    );
  $("safe-btn")?.addEventListener("click", () => invoke("restart_in_mode", { safe: true }).catch((err) => toast(String(err))));
  $("clear-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://settings/clear" }).catch(() => {}));
  $("perm-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://settings/permissions" }).catch(() => {}));
  $("gpu-link").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://gpu" }).catch(() => {}));
  $("clear-crashes-btn")?.addEventListener("click", async () => {
    await invoke("clear_crash_reports").catch((err) => toast(String(err)));
    await render();
  });
  report = reportText(
    [
      ["Kessel", kessel],
      ["This PC", pc],
      ["Network", network],
      ["Storage", (sys.storage || []).map((s) => row(s.what, bytes(s.bytes)))],
      ["Web features", featureList.map(([name, ok]) => row(name, ok ? "yes" : "no"))],
    ],
    crashes,
  );
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  $("logo").outerHTML = icon("help", 20);
  $("tasks-btn").innerHTML = `${icon("activity", 13)} Task manager`;
  $("tasks-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://tasks" }).catch(() => {}));
  $("gpu-btn").innerHTML = `${icon("gpu", 13)} Graphics & media`;
  $("gpu-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://gpu" }).catch(() => {}));
  $("copy-btn").innerHTML = `${icon("copy", 13)} Copy report`;
  $("copy-btn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(report);
    toast("Copied");
  });
  try {
    await render();
  } catch (err) {
    $("sections").textContent = `Couldn't check: ${err?.message || err}`;
  }
  if (location.hash) $(location.hash.slice(1))?.scrollIntoView();
  window.addEventListener("hashchange", () => $(location.hash.slice(1))?.scrollIntoView());
  // Online / offline as it changes.
  const refreshNetwork = () => render().catch(() => {});
  window.addEventListener("online", refreshNetwork);
  window.addEventListener("offline", refreshNetwork);
});
