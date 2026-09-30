// Search engines: Kessel's built-in ones, the extra ones it comes with
// (YouTube, Wikipedia...), and your own -- each with a keyword, so "yt cats"
// in the address bar searches YouTube for cats (and "!yt cats" too). Your
// engines and keywords live in settings.features.search_engines /
// .engine_keywords (Settings -> Search & Startup).

import { ENGINES, resolveInput, looksLikeUrl } from "./api.js";

// The built-in engines' keywords, until you change them.
export const BUILTIN_KEYWORDS = { google: "g", bing: "b", duckduckgo: "d", brave: "br", ecosia: "e", startpage: "sp" };

// Search engines Kessel comes with besides the main ones; yours to edit or remove.
export const DEFAULT_EXTRA_ENGINES = [
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/results?search_query=%s", keyword: "yt" },
  { id: "wikipedia", name: "Wikipedia", url: "https://en.wikipedia.org/w/index.php?search=%s", keyword: "w" },
  { id: "github", name: "GitHub", url: "https://github.com/search?q=%s", keyword: "gh" },
  { id: "maps", name: "OpenStreetMap", url: "https://www.openstreetmap.org/search?query=%s", keyword: "maps" },
  { id: "mdn", name: "MDN Web Docs", url: "https://developer.mozilla.org/search?q=%s", keyword: "mdn" },
  { id: "wiktionary", name: "Wiktionary", url: "https://en.wiktionary.org/w/index.php?search=%s", keyword: "wt" },
];

function features(settings) {
  return (settings && settings.features) || {};
}

// Your engines (the defaults until you've changed the list).
export function extraEngines(settings) {
  const list = features(settings).search_engines;
  return Array.isArray(list) ? list.filter((e) => e && e.url && e.name) : DEFAULT_EXTRA_ENGINES;
}

// Every engine: { id, name, keyword, builtin, url(query) }.
export function allEngines(settings) {
  const keywords = { ...BUILTIN_KEYWORDS, ...(features(settings).engine_keywords || {}) };
  const builtin = Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name, keyword: keywords[id] || "", builtin: true, url: e.url }));
  const extra = extraEngines(settings).map((e) => ({
    id: e.id,
    name: e.name,
    keyword: e.keyword || "",
    builtin: false,
    template: e.url,
    url: (q) => fillTemplate(e.url, q),
  }));
  return [...builtin, ...extra];
}

// "https://x/?q=%s" with the query in place of %s (or at the end).
export function fillTemplate(template, query) {
  const q = encodeURIComponent(query);
  return template.includes("%s") ? template.split("%s").join(q) : template + q;
}

export function engineById(settings, id) {
  const all = allEngines(settings);
  return all.find((e) => e.id === id) || all.find((e) => e.id === "google");
}

// "yt cats" / "!yt cats" -> { engine, query } when "yt" is an engine's keyword.
export function keywordSearch(text, settings) {
  const m = /^!?(\S+)\s+(.+)$/.exec(String(text || "").trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  const engine = allEngines(settings).find((e) => e.keyword && e.keyword.toLowerCase() === word);
  return engine ? { engine, query: m[2].trim() } : null;
}

// What typing `text` into the address bar opens: an address, a keyword
// search, or a search with your default engine (a built-in or your own).
export function resolveTyped(text, settings) {
  const t = String(text || "").trim();
  if (!t) return "";
  const kw = !looksLikeUrl(t) && keywordSearch(t, settings);
  if (kw) return kw.engine.url(kw.query);
  const id = (settings && settings.search_engine) || "google";
  if (ENGINES[id]) return resolveInput(t, id);
  const engine = engineById(settings, id);
  const asUrl = resolveInput(t, "google");
  // An address stays an address; anything else is a search with your engine.
  if (!t.startsWith("?") && (looksLikeUrl(t) || /^(kessel|file|view-source):/i.test(t))) return asUrl;
  return engine.url(t.replace(/^\?\s*/, ""));
}
