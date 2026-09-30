// Reading feeds (feeds.js, kessel://feeds): RSS 2.0, RSS 1.0 (RDF), Atom and
// JSON Feed into one shape -- { title, site, items: [{ id, title, url,
// date, summary }] }. Only text is kept (no HTML from the feed is ever
// shown), and only http(s) links. Also OPML, for moving your list of feeds
// between readers. `parser` is a DOMParser (the page's own).

import { safeReaderUrl } from "./links.js";

const text = (el) => (el ? String(el.textContent || "").trim() : "");

// HTML (a summary, a content) as plain text, at most `max` characters.
export function plainText(html, parser, max = 280) {
  const s = String(html || "");
  let t = s;
  if (/[<&]/.test(s)) {
    const body = parser.parseFromString(`<body>${s}</body>`, "text/html").body;
    for (const junk of body.querySelectorAll("script, style, noscript, template")) junk.remove();
    t = body.textContent || "";
  }
  const flat = t.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function dateOf(value) {
  const t = Date.parse(String(value || "").trim());
  return Number.isFinite(t) ? t : 0;
}

function child(el, name) {
  if (!el) return null;
  for (const c of el.children) if (c.localName === name) return c;
  return null;
}

function children(el, name) {
  return el ? [...el.children].filter((c) => c.localName === name) : [];
}

export function parseFeed(body, parser, base = "") {
  const raw = String(body || "").trim();
  const abs = (u) => {
    try {
      return safeReaderUrl(new URL(String(u || "").trim(), base || undefined).href);
    } catch {
      return "";
    }
  };
  // JSON Feed
  if (raw.startsWith("{")) {
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error("That isn't a feed");
    }
    if (!Array.isArray(json.items)) throw new Error("That isn't a feed");
    return {
      title: plainText(json.title, parser, 200),
      site: abs(json.home_page_url),
      items: json.items.slice(0, 200).map((it) => ({
        id: String(it.id ?? it.url ?? it.title ?? ""),
        title: plainText(it.title || it.summary || it.content_text || "", parser, 300) || "(untitled)",
        url: abs(it.url || it.external_url),
        date: dateOf(it.date_published || it.date_modified),
        summary: plainText(it.summary || it.content_text || it.content_html, parser),
      })),
    };
  }
  const doc = parser.parseFromString(raw, "application/xml");
  if (doc.querySelector("parsererror") || !doc.documentElement) throw new Error("That isn't a feed");
  const root = doc.documentElement;
  // Atom
  if (root.localName === "feed") {
    const linkOf = (el) => {
      const links = children(el, "link");
      const alt = links.find((l) => !l.getAttribute("rel") || l.getAttribute("rel") === "alternate") || links[0];
      return alt ? abs(alt.getAttribute("href")) : "";
    };
    return {
      title: plainText(text(child(root, "title")), parser, 200),
      site: linkOf(root),
      items: children(root, "entry").slice(0, 200).map((e) => ({
        id: text(child(e, "id")) || linkOf(e),
        title: plainText(text(child(e, "title")), parser, 300) || "(untitled)",
        url: linkOf(e),
        date: dateOf(text(child(e, "published")) || text(child(e, "updated"))),
        summary: plainText(text(child(e, "summary")) || text(child(e, "content")), parser),
      })),
    };
  }
  // RSS 2.0 (<rss><channel><item>) and RSS 1.0 (<rdf:RDF><channel/><item>)
  if (root.localName === "rss" || root.localName === "RDF") {
    const channel = child(root, "channel");
    const items = root.localName === "rss" ? children(channel, "item") : children(root, "item");
    return {
      title: plainText(text(child(channel, "title")), parser, 200),
      site: abs(text(child(channel, "link"))),
      items: items.slice(0, 200).map((it) => {
        const url = abs(text(child(it, "link")) || (child(it, "guid")?.getAttribute("isPermaLink") !== "false" ? text(child(it, "guid")) : ""));
        return {
          id: text(child(it, "guid")) || url || text(child(it, "title")),
          title: plainText(text(child(it, "title")) || text(child(it, "description")), parser, 300) || "(untitled)",
          url,
          date: dateOf(text(child(it, "pubDate")) || text(child(it, "date"))),
          summary: plainText(text(child(it, "description")) || text(child(it, "encoded")), parser),
        };
      }),
    };
  }
  throw new Error("That isn't a feed");
}

// The feed links an HTML page offers (<link rel="alternate" type=...rss...>).
export function feedLinksIn(html, parser, base) {
  const doc = parser.parseFromString(String(html || ""), "text/html");
  const out = [];
  for (const l of doc.querySelectorAll('link[rel~="alternate"][href]')) {
    if (!/rss|atom|feed\+json/i.test(l.getAttribute("type") || "")) continue;
    try {
      const url = safeReaderUrl(new URL(l.getAttribute("href"), base).href);
      if (url) out.push({ url, title: (l.getAttribute("title") || "").slice(0, 200) });
    } catch {}
  }
  return out;
}

// OPML: your feeds to hand to another reader, and back.
export function toOpml(feeds) {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const lines = feeds.map((f) => `    <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}"${f.site ? ` htmlUrl="${esc(f.site)}"` : ""}/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Kessel feeds</title></head>\n  <body>\n${lines.join("\n")}\n  </body>\n</opml>\n`;
}

export function fromOpml(xml, parser) {
  const doc = parser.parseFromString(String(xml || ""), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That isn't an OPML file");
  const out = [];
  for (const o of doc.querySelectorAll("outline[xmlUrl]")) {
    const url = safeReaderUrl(o.getAttribute("xmlUrl"));
    if (url && !out.some((f) => f.url === url)) out.push({ url, title: (o.getAttribute("title") || o.getAttribute("text") || "").slice(0, 200), site: safeReaderUrl(o.getAttribute("htmlUrl") || "") });
  }
  return out;
}
