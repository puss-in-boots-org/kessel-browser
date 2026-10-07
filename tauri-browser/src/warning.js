// The warning page (warning.html): what's wrong with the page you were about
// to open, a way back, and -- tucked away -- a way on (security.rs).

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";

const { invoke } = window.__TAURI__.core;
const params = new URLSearchParams(location.search);
const kind = params.get("kind") || "blocked";
const url = params.get("url") || "";
const detail = params.get("detail") || "";
let host = url;
try {
  host = new URL(url).hostname;
} catch {}

const onList = (what) => (detail ? `It's on the ${detail}, a public list of ${what}.` : `It's on a public list of ${what}.`);

const KINDS = {
  phishing: {
    danger: true,
    title: "Deceptive site ahead",
    what: `${host} may try to trick you into giving away passwords, card numbers or other personal details.`,
    more: `${onList("phishing sites")} Only go on if you're sure it's been listed by mistake.`,
    proceed: "Visit this unsafe site",
  },
  malware: {
    danger: true,
    title: "This site may harm your computer",
    what: `${host} has been spreading malware -- software that steals data, encrypts your files for ransom or takes over your PC.`,
    more: `${onList("sites spreading malware")} Only go on if you're sure it's safe now.`,
    proceed: "Visit this unsafe site",
  },
  badware: {
    danger: true,
    title: "Dangerous site ahead",
    what: `${host} is known for fake downloads, scams or software you don't want.`,
    more: `${onList("such sites")} Only go on if you're sure it's been listed by mistake.`,
    proceed: "Visit this site anyway",
  },
  blocked: {
    danger: false,
    title: "Shields blocked this page",
    what: `${host} is on one of Shields' filter lists as a page to block entirely -- usually an ad, a tracker or a scam.`,
    more: "Shields' filter lists are in Settings → Privacy & Security.",
    proceed: "Open it anyway",
  },
  https: {
    danger: false,
    title: "This site has no secure connection",
    what: `${host} doesn't support HTTPS, so anyone on your network could see or change what you send and receive there.`,
    more: "HTTPS-only mode is on (Settings → Security). You can load this site insecurely -- Kessel won't ask about it again until you restart it.",
    proceed: "Continue to the insecure site",
  },
  cert: {
    danger: true,
    title: "Your connection isn't private",
    what: `Someone might be trying to pretend to be ${host} to steal your information (passwords, messages or card numbers).`,
    more: `${detail} Unless you know why this happens -- a device on your own network, say -- don't go on.`,
    proceed: `Go on to ${host} (unsafe)`,
  },
  // The site couldn't be reached (main.rs, security.rs unreachable_text):
  // tried again by itself once the PC is back online.
  offline: {
    danger: false,
    title: navigator.onLine ? "This page can't be reached" : "You're offline",
    what: `${detail || "The site couldn't be reached"}. Kessel tries ${host || "it"} again by itself as soon as the PC is back online.`,
    more: "Check the network cable or Wi-Fi, and Settings -> Network for a proxy. kessel://diagnostics shows the connection.",
    proceed: "Open diagnostics",
  },
  // The page's process stopped (crash.rs); `detail` says how.
  crashed: {
    danger: false,
    title: /closed it|ended/.test(detail) ? "This page was closed" : "This page crashed",
    what: `${detail || "Its process stopped unexpectedly"}. Reload to open ${host || "it"} again -- anything you'd typed but not sent there is gone.`,
    more: "Kessel keeps a note of every crash: kessel://diagnostics lists them.",
    proceed: "See the crash reports",
  },
};

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  const k = KINDS[kind] || KINDS.blocked;
  document.body.classList.toggle("danger", k.danger);
  document.title = k.title;
  document.getElementById("symbol").innerHTML = icon(k.danger ? "warning" : kind === "blocked" ? "shield" : "unlock", 28);
  document.getElementById("title").textContent = k.title;
  document.getElementById("what").textContent = k.what;
  document.getElementById("address").textContent = url;
  document.getElementById("more").textContent = k.more;
  document.getElementById("details-label").textContent = k.danger ? "Details" : "More";
  const back = document.getElementById("back");
  back.textContent = history.length > 1 ? "Go back" : "Go to the start page";
  back.addEventListener("click", () => {
    if (history.length > 1) history.back();
    else location.replace("newtab.html");
  });
  const proceed = document.getElementById("proceed");
  proceed.textContent = k.proceed;
  if (kind === "crashed" || kind === "offline") {
    // Nothing to warn about: Reload (Try again) is the way on.
    const offline = kind === "offline";
    document.getElementById("symbol").innerHTML = icon(offline ? "globe" : "refresh", 28);
    back.textContent = offline ? "Try again" : "Reload";
    back.replaceWith(back.cloneNode(true));
    const retry = () => location.replace(url);
    document.getElementById("back").addEventListener("click", retry);
    proceed.classList.remove("danger");
    proceed.addEventListener("click", () => invoke("open_singleton_tab", { route: offline ? "kessel://diagnostics/network" : "kessel://diagnostics/crashes" }));
    if (offline) {
      // Back online: straight there. Online all along (the site's down): a
      // quiet try every half a minute.
      window.addEventListener("online", retry);
      setInterval(() => navigator.onLine && document.visibilityState === "visible" && retry(), 30000);
      // On your reading list with a copy kept: read that meanwhile.
      invoke("reading_offline_copy", { url }).then((copy) => {
        if (!copy) return;
        const read = document.createElement("button");
        read.className = "btn";
        read.id = "saved-copy";
        read.textContent = "Read the copy you saved";
        read.addEventListener("click", () => invoke("open_offline_copy", { url }).catch(() => {}));
        document.querySelector(".actions").appendChild(read);
      }, () => {});
    }
    return;
  }
  proceed.addEventListener("click", async () => {
    await invoke("warning_proceed", { kind, url });
    // In this page's place: Back then skips the warning.
    location.replace(url);
  });
});
