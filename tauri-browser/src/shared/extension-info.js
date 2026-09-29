// What an extension asks for, in words -- for "Add to Kessel" and
// Settings -> Extensions. Permissions that don't reach into your data
// (storage, alarms, context menus...) aren't worth a line.

import { currentSettings, saveSettings } from "./theme.js";
import { styleState } from "./styles.js";

const PERMISSION_TEXT = {
  tabs: "See the addresses and titles of your tabs",
  history: "Read and change your browsing history",
  bookmarks: "Read and change your bookmarks",
  downloads: "Manage your downloads",
  "downloads.open": "Open files you downloaded",
  clipboardRead: "Read what you copy and paste",
  clipboardWrite: "Change what you copy and paste",
  nativeMessaging: "Talk to programs installed on this PC",
  notifications: "Show notifications",
  geolocation: "Know your location",
  management: "Manage your other extensions",
  privacy: "Change your privacy settings",
  proxy: "Send your traffic through a proxy",
  topSites: "See your most visited sites",
  "identity.email": "Know your email address",
  debugger: "Control pages with the debugger",
  desktopCapture: "Capture your screen",
  tabCapture: "Capture what tabs show",
  pageCapture: "Save pages",
  webRequest: "Watch the requests pages make",
  webRequestBlocking: "Block the requests pages make",
  declarativeNetRequest: "Block content on pages",
  declarativeNetRequestWithHostAccess: "Block and change content on pages",
  webNavigation: "See where you go in your tabs",
  cookies: "Read and change cookies of the sites it can reach",
  contentSettings: "Change which sites may use your camera, location...",
  sessions: "See your recently closed tabs",
  readingList: "Read and change your reading list",
  activeTab: "Work on the page you're on when you use it",
  "system.cpu": "See information about this PC",
  "system.memory": "See information about this PC",
  "system.storage": "See your drives",
  "system.display": "See your screens",
  tts: "Read text aloud",
};

// Lines saying what extension `ext` ({ permissions, hosts }) may do.
export function permissionLines(ext) {
  const hosts = ext.hosts || [];
  const lines = [];
  const everywhere = hosts.some((h) => h === "<all_urls>" || /^(\*|https?):\/\/\*\/\*$/.test(h));
  if (everywhere) lines.push("Read and change everything on every website");
  else if (hosts.length) {
    const sites = [...new Set(hosts.map((h) => h.replace(/^[^:]+:\/\//, "").split("/")[0].replace(/^\*\./, "")).filter((h) => h && h !== "*"))];
    if (sites.length) lines.push(`Read and change what you see on ${sites.slice(0, 4).join(", ")}${sites.length > 4 ? ` and ${sites.length - 4} more sites` : ""}`);
  }
  const seen = new Set();
  for (const p of ext.permissions || []) {
    const text = PERMISSION_TEXT[p];
    if (text && !seen.has(text)) {
      seen.add(text);
      lines.push(text);
    }
  }
  return lines;
}

// A Chrome theme's colours ({ colors: { frame, toolbar, tab_text, ... } },
// from extension_theme) as changes to a Kessel style -- dark or light
// after its frame -- for Settings' ui_custom[style].
export function themeCustom(theme) {
  const c = theme?.colors || {};
  const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v || "") ? v : null);
  const frame = hex(c.frame) || hex(c.toolbar);
  if (!frame) return null;
  const lum = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const mode = lum(frame) < 0.5 ? "dark" : "light";
  const out = { mode };
  const put = (key, value) => value && (out[`${key}@${mode}`] = value);
  put("bg", frame);
  put("railBg", frame);
  put("chromeBg", hex(c.toolbar) || frame);
  put("tabActiveBg", hex(c.toolbar));
  put("surface", hex(c.toolbar));
  put("addressBg", hex(c.omnibox_background));
  put("text", hex(c.tab_text) || hex(c.bookmark_text) || hex(c.toolbar_text));
  put("textDim", hex(c.tab_background_text));
  const accent = hex(c.ntp_link) || hex(c.toolbar_button_icon) || hex(c.button_background);
  if (accent) out.accent = accent;
  return out;
}

// Gives the style you use theme extension `id`'s colours. Returns whether
// there were any.
export async function applyExtensionTheme(id) {
  const changes = themeCustom(await window.__TAURI__.core.invoke("extension_theme", { id }));
  if (!changes) return false;
  const { id: style, all } = styleState(currentSettings());
  await saveSettings({ ui_custom: { ...all, [style]: { ...(all[style] || {}), ...changes } } });
  return true;
}

export const SOURCE_NAMES = { chrome: "Chrome Web Store", edge: "Edge Add-ons", file: "a file", folder: "a folder (developer mode)" };
