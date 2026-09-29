// The site info popup (siteinfo.html): how the page is connected, its
// certificate, and its cookies and data -- with this site's cookie rule and
// "clear site data" right here (privacy.rs, security.rs).

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";
import { closeOwnPopup } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const init = window.__KESSEL_POPUP__ || { tab: 0, url: "" };
const $ = (id) => document.getElementById(id);
const close = () => closeOwnPopup();

const RULE_TEXT = {
  allow: "This site keeps its cookies.",
  session: "This site's cookies are deleted when you close Kessel.",
  block: "This site can't keep cookies (or read them).",
};

function button(id, iconName, label, action) {
  const b = $(id);
  b.innerHTML = `${icon(iconName, 14)}<span></span>`;
  b.querySelector("span").textContent = label;
  b.addEventListener("click", action);
  return b;
}

function connection(info) {
  if (info.scheme === "https") return ["secure", "lock", "Connection is secure", "What you send and receive here is encrypted."];
  if (info.scheme === "file") return ["neutral", "file", "A file on this PC", "It isn't from the internet."];
  if (info.local) return ["neutral", "globe", "A local address", "A device or server on this PC or your network."];
  return ["insecure", "unlock", "Not secure", "This site has no secure connection: anyone on your network could see or change what you send and receive here -- don't enter passwords or card numbers."];
}

async function render() {
  const info = await invoke("site_info", { tab: init.tab, url: init.url });
  $("host").textContent = info.host || init.url;
  const [cls, glyph, title, text] = connection(info);
  const status = $("status");
  status.className = `status ${cls}`;
  status.querySelector(".glyph").innerHTML = icon(glyph, 15);
  status.querySelector("b").textContent = title;
  status.querySelector("span").textContent = text;
  $("cert-note").hidden = !info.certAllowed;
  $("cert-btn").disabled = info.scheme !== "https";

  const web = info.scheme === "http" || info.scheme === "https";
  $("cookie-count").textContent = !web ? "" : info.cookies === 1 ? "1 cookie on this PC" : `${info.cookies} cookies on this PC`;
  for (const b of document.querySelectorAll("#rules button")) {
    b.classList.toggle("on", b.dataset.rule === info.rule);
    b.disabled = !web;
  }
  const own = info.ruleSite ? "" : " (your default)";
  $("rule-note").textContent = info.private ? "Private window: everything this site keeps goes when you close the window." : `${RULE_TEXT[info.rule] || ""}${own}`;
  return info;
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  watchCustomWallpaper(currentSettings);
  let info = await render().catch(() => null);

  // Windows' own certificate dialog, over the browser window.
  button("cert-btn", "file", "Certificate", () => {
    invoke("view_certificate", { url: init.url }).catch(() => {});
    close();
  });
  button("cookies-btn", "settings", "Manage cookies", () => {
    invoke("open_singleton_tab", { route: `kessel://settings/cookies:${info?.site || ""}` }).catch(() => {});
    close();
  });
  const clear = button("clear-btn", "broom", "Clear this site's data", async () => {
    if (!info) return;
    clear.disabled = true;
    await invoke("clear_site_data", { site: info.site, tab: init.tab }).catch(() => {});
    // The page starts again without what it kept.
    await invoke("reload", { id: init.tab }).catch(() => {});
    close();
  });
  for (const b of document.querySelectorAll("#rules button")) {
    b.addEventListener("click", async () => {
      if (!info) return;
      await invoke("set_cookie_rule", { site: info.site, rule: b.dataset.rule }).catch(() => {});
      info = await render().catch(() => info);
    });
  }
  window.addEventListener("blur", () => setTimeout(() => !document.hasFocus() && close(), 150));
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
});
