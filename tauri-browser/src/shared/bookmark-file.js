// Reading a bookmark file -- the HTML "Netscape" format every browser
// exports (Chrome, Edge, Firefox, Safari, Opera...) -- into bookmarks with
// their folders: [{ url, title, folder: "Work/Projects", tags, note, added }].
// `parser` is a DOMParser. The file's own top folders ("Bookmarks bar",
// "Bookmarks Menu") are kept as folders, under `into` when given.

export function readBookmarkFile(html, parser, into = "") {
  const doc = parser.parseFromString(String(html || ""), "text/html");
  const out = [];
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const walk = (dl, path) => {
    let last = null;
    for (const node of dl.children) {
      const tag = node.tagName;
      if (tag === "DD" && last) {
        last.note = clean(node.childNodes[0]?.textContent || node.textContent).slice(0, 5000);
        continue;
      }
      if (tag === "DL") {
        walk(node, path);
        continue;
      }
      if (tag !== "DT" && tag !== "P") continue;
      const heading = node.querySelector(":scope > h3");
      const link = node.querySelector(":scope > a");
      if (heading) {
        const name = clean(heading.textContent).replace(/\//g, "-") || "Folder";
        // The folder's contents: its own <DL>, inside the <DT> or right after it.
        const inner = node.querySelector(":scope > dl") || (node.nextElementSibling?.tagName === "DL" ? node.nextElementSibling : null);
        if (inner) walk(inner, path ? `${path}/${name}` : name);
        last = null;
      } else if (link) {
        const url = (link.getAttribute("href") || "").trim();
        if (!/^(https?|file):/i.test(url)) continue;
        const added = parseInt(link.getAttribute("add_date") || "0", 10);
        last = {
          url,
          title: clean(link.textContent) || url,
          folder: path,
          tags: (link.getAttribute("tags") || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
          note: "",
          added: Number.isFinite(added) && added > 0 ? added : 0,
        };
        out.push(last);
      }
      // A <DT> that the parser left holding the rest of the list.
      const nested = node.querySelector(":scope > dl");
      if (nested && !heading) walk(nested, path);
    }
  };
  const top = doc.querySelector("dl");
  if (top) walk(top, into);
  // The same address twice in the file: the first one.
  const seen = new Set();
  return out.filter((b) => !seen.has(b.url) && seen.add(b.url));
}

// Addresses that are the same page: http/https, www., a trailing slash, the #part.
export function sameAddressKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

// Groups of bookmarks for the same page (Find duplicates).
export function duplicateGroups(bookmarks) {
  const groups = new Map();
  for (const b of bookmarks) {
    const key = sameAddressKey(b.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
