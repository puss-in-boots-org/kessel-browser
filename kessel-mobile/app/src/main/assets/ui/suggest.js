// The address bar's suggestions on a phone -- the same sources and order as
// the desktop's (../../../../../tauri-browser/src/omnibox.js): what you
// typed, an instant answer, your open tabs, bookmarks, history and your
// search engine's suggestions. The pure part, which the unit tests run
// (kessel-mobile/tests/suggest.test.mjs); app.js fetches and draws.

import { resolveInput, looksLikeUrl, ENGINES } from "./shared/api.js";

export const MAX_ITEMS = 9;

// An address as people read it: no scheme, no www., no lone trailing slash.
export function shortUrl(url) {
  let text = String(url || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/^([^/?#]+)\/$/, "$1");
  try {
    text = decodeURI(text);
  } catch {}
  return text;
}

export function wordsOf(text) {
  return String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAll(words, ...fields) {
  const hay = fields.join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

// History entries are [url, title, visits, lastVisit], best first.
// "yout" -> youtube.com if you've been there: { url, fill }. Only a bare
// word or address start, never a search.
export function completeAddress(text, history) {
  const t = String(text || "").trim().toLowerCase();
  if (t.length < 2 || /\s/.test(t) || t.startsWith("?") || /^[a-z]+:/.test(t)) return null;
  for (const [url] of history) {
    let host;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      continue;
    }
    const bare = host.replace(/^www\./, "");
    for (const candidate of [bare, host]) {
      // The site itself (its address as you last had it: http, a port...).
      if (candidate.startsWith(t)) return { url: `${new URL(url).origin}/`, fill: candidate };
    }
    // Typed into the path: "youtube.com/fe" -> that page.
    const short = shortUrl(url).toLowerCase();
    if (t.includes("/") && short.startsWith(t)) return { url, fill: shortUrl(url) };
  }
  return null;
}

// The first row: go to the address (or the completed one), or search for it.
export function firstItem(text, engineKey, completion = null) {
  const t = String(text || "").trim();
  if (completion) return { kind: "go", title: completion.fill, detail: "Go to site", url: completion.url, completed: true };
  const engine = ENGINES[engineKey] || ENGINES.google;
  const url = resolveInput(t, engineKey);
  const address = !t.startsWith("?") && looksLikeUrl(t);
  return address
    ? { kind: "go", title: shortUrl(t), detail: "Go to site", url }
    : { kind: "search", title: t.replace(/^\?\s*/, ""), detail: `${engine.name} Search`, url };
}

export function historyMatches(text, history, limit = 5) {
  const words = wordsOf(String(text || "").replace(/^\?\s*/, ""));
  if (!words.length) return [];
  const out = [];
  for (const [url, title] of history) {
    if (!matchesAll(words, title, url)) continue;
    out.push({ kind: "history", title: title || shortUrl(url), detail: shortUrl(url), url, fill: url });
    if (out.length >= limit) break;
  }
  return out;
}

export function bookmarkMatches(text, bookmarks, limit = 2) {
  const words = wordsOf(String(text || "").replace(/^\?\s*/, ""));
  if (!words.length) return [];
  return bookmarks
    .filter((b) => matchesAll(words, b.title, b.url))
    .slice(0, limit)
    .map((b) => ({ kind: "bookmark", title: b.title || shortUrl(b.url), detail: shortUrl(b.url), url: b.url, fill: b.url }));
}

// Your other tabs (private ones only from a private tab, and the other way
// round) whose title or address has every word.
export function tabMatches(text, tabs, { activeId, private: isPrivate }, limit = 2) {
  const words = wordsOf(String(text || "").replace(/^\?\s*/, ""));
  if (!words.length) return [];
  return tabs
    .filter((t) => t.id !== activeId && !!t.private === !!isPrivate && /^https?:/.test(t.url) && matchesAll(words, t.title, t.url))
    .slice(0, limit)
    .map((t) => ({ kind: "tab", title: t.title || shortUrl(t.url), detail: shortUrl(t.url), url: t.url, tabId: t.id }));
}

// All the rows, in order, each page once (an open tab beats its bookmark
// beats its visit).
export function assemble(b, max = MAX_ITEMS) {
  const seen = new Set();
  const keep = (item) => {
    if (!item) return false;
    if (item.kind === "answer" || !item.url) return true;
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  };
  return [b.first, ...(b.answers || []), ...(b.tabs || []), ...(b.bookmarks || []), ...(b.history || []), ...(b.suggestions || [])].filter(keep).slice(0, max);
}

// The new tab page's "most visited": one tile per site, best first.
export function topSites(history, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const [url, title] of history) {
    let host;
    try {
      host = new URL(url).host.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    out.push({ url, title: title || host, host });
    if (out.length >= limit) break;
  }
  return out;
}
