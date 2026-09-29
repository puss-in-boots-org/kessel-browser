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
  proceed.addEventListener("click", async () => {
    await invoke("warning_proceed", { kind, url });
    // In this page's place: Back then skips the warning.
    location.replace(url);
  });
});
