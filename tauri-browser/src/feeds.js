// kessel://feeds (feeds.html): the feeds you follow (settings.features.feeds
// = [{ url, title, site }]), newest items first. Kessel fetches them itself
// (tools.rs, fetch_feed) when this page opens and every so often while it's
// open (features.feeds_refresh_minutes); what's been fetched and what
// you've read stay on this computer (this page's own storage).

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { toast, escapeHtml, hostOf, formatRelativeTime } from "./shared/api.js";
import { parseFeed, feedLinksIn, toOpml, fromOpml } from "./shared/feeds.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const parser = new DOMParser();

const CACHE_KEY = "kessel-feed-cache";
const READ_KEY = "kessel-feed-read";
let cache = load(CACHE_KEY, {}); // url -> { title, items, fetched, error }
let read = new Set(load(READ_KEY, []));
let showing = ""; // a feed's url, or "" for all of them

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const features = () => currentSettings()?.features || {};
const feeds = () => (Array.isArray(features().feeds) ? features().feeds : []);
const saveFeeds = (list) => saveSettings({ features: { ...features(), feeds: list } });
const itemKey = (feed, item) => `${feed}\n${item.id || item.url}`;

function unread(feed) {
  return (cache[feed.url]?.items || []).filter((it) => !read.has(itemKey(feed.url, it))).length;
}

function renderList() {
  const list = $("list");
  const all = feeds();
  const total = all.reduce((n, f) => n + unread(f), 0);
  list.innerHTML = `<div class="feed${showing ? "" : " on"}" data-url=""><span class="name">All feeds</span>${total ? `<span class="count">${total}</span>` : ""}</div>`;
  for (const f of all) {
    const c = cache[f.url];
    const n = unread(f);
    const row = document.createElement("div");
    row.className = `feed${showing === f.url ? " on" : ""}`;
    row.dataset.url = f.url;
    row.innerHTML = `<span class="name"></span>${c?.error ? `<span class="err" title="">!</span>` : n ? `<span class="count">${n}</span>` : ""}<span class="x" title="Stop following">${icon("close", 11)}</span>`;
    row.querySelector(".name").textContent = f.title || c?.title || hostOf(f.url);
    if (c?.error) row.querySelector(".err").title = c.error;
    list.appendChild(row);
  }
  if (!all.length) list.insertAdjacentHTML("beforeend", `<div style="padding:10px;font-size:12px;opacity:.6;line-height:1.5">Follow a site: type its address above, or open it and pick “Follow this site's feed” in the command palette (F2).</div>`);
}

function renderItems() {
  const box = $("items");
  const chosen = showing ? feeds().filter((f) => f.url === showing) : feeds();
  $("heading").textContent = showing ? chosen[0]?.title || hostOf(showing) : "All feeds";
  const rows = chosen.flatMap((f) => (cache[f.url]?.items || []).map((it) => ({ feed: f, it })));
  rows.sort((a, b) => (b.it.date || 0) - (a.it.date || 0));
  const hideRead = features().feeds_hide_read === true;
  const shown = rows.filter(({ feed, it }) => !hideRead || !read.has(itemKey(feed.url, it))).slice(0, 400);
  if (!shown.length) {
    box.innerHTML = `<div id="empty">${feeds().length ? "Nothing new." : "No feeds yet."}</div>`;
    return;
  }
  box.innerHTML = "";
  for (const { feed, it } of shown) {
    const a = document.createElement("a");
    a.className = `item${read.has(itemKey(feed.url, it)) ? " read" : ""}`;
    a.href = it.url || "#";
    a.innerHTML = `<div class="t"></div><div class="m"></div><div class="s"></div>`;
    a.querySelector(".t").textContent = it.title;
    a.querySelector(".m").textContent = [feed.title || cache[feed.url]?.title || hostOf(feed.url), it.date ? formatRelativeTime(it.date / 1000) : ""].filter(Boolean).join(" · ");
    a.querySelector(".s").textContent = it.summary || "";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      markRead(feed.url, it);
      a.classList.add("read");
      renderList();
      if (!it.url) return;
      const newTab = e.ctrlKey || e.metaKey || e.button === 1 || features().feeds_open !== "same";
      if (newTab) invoke("open_url", { url: it.url, how: "tab" }).catch((err) => toast(String(err)));
      else location.href = it.url;
    });
    a.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      markRead(feed.url, it);
      a.classList.add("read");
      renderList();
      if (it.url) invoke("open_url", { url: it.url, how: "tab" }).catch(() => {});
    });
    box.appendChild(a);
  }
}

function markRead(feed, it) {
  read.add(itemKey(feed, it));
  // The oldest go first past 5,000.
  if (read.size > 5000) read = new Set([...read].slice(-5000));
  store(READ_KEY, [...read]);
}

function render() {
  renderList();
  renderItems();
}

async function refreshOne(feed) {
  try {
    const body = await invoke("fetch_feed", { url: feed.url });
    const parsed = parseFeed(body, parser, feed.url);
    const max = Math.max(10, Math.min(500, Number(features().feeds_max_items) || 100));
    cache[feed.url] = { title: parsed.title, site: parsed.site, items: parsed.items.slice(0, max), fetched: Date.now() };
  } catch (err) {
    cache[feed.url] = { ...(cache[feed.url] || {}), error: String(err?.message || err) };
  }
}

let refreshing = false;
async function refreshAll({ force = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  $("refresh").disabled = true;
  const every = Math.max(5, Number(features().feeds_refresh_minutes) || 60) * 60000;
  const due = feeds().filter((f) => force || !cache[f.url]?.fetched || Date.now() - cache[f.url].fetched >= every);
  // A few at a time.
  for (let i = 0; i < due.length; i += 4) {
    await Promise.all(due.slice(i, i + 4).map(refreshOne));
    render();
  }
  // Feeds you stopped following leave the cache.
  const known = new Set(feeds().map((f) => f.url));
  for (const url of Object.keys(cache)) if (!known.has(url)) delete cache[url];
  store(CACHE_KEY, cache);
  refreshing = false;
  $("refresh").disabled = false;
}

// A feed's address, or a site's (its page says where its feed is).
async function follow(address) {
  let url = address.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let body;
  try {
    body = await invoke("fetch_feed", { url });
  } catch (err) {
    return toast(String(err));
  }
  let feedUrl = url;
  let parsed = null;
  try {
    parsed = parseFeed(body, parser, url);
  } catch {
    const links = feedLinksIn(body, parser, url);
    if (!links.length) return toast("No feed found there");
    feedUrl = links[0].url;
    try {
      parsed = parseFeed(await invoke("fetch_feed", { url: feedUrl }), parser, feedUrl);
    } catch (err) {
      return toast(`Couldn't read its feed: ${err?.message || err}`);
    }
  }
  if (feeds().some((f) => f.url === feedUrl)) return toast("You already follow it");
  await saveFeeds([...feeds(), { url: feedUrl, title: parsed.title || hostOf(url), site: parsed.site || url }]);
  cache[feedUrl] = { title: parsed.title, site: parsed.site, items: parsed.items.slice(0, 100), fetched: Date.now() };
  store(CACHE_KEY, cache);
  $("add-url").value = "";
  showing = feedUrl;
  render();
}

function wire() {
  $("add").addEventListener("submit", (e) => {
    e.preventDefault();
    follow($("add-url").value);
  });
  $("list").addEventListener("click", async (e) => {
    const row = e.target.closest(".feed");
    if (!row) return;
    if (e.target.closest(".x")) {
      await saveFeeds(feeds().filter((f) => f.url !== row.dataset.url));
      if (showing === row.dataset.url) showing = "";
      render();
      return;
    }
    showing = row.dataset.url;
    render();
  });
  $("refresh").addEventListener("click", () => refreshAll({ force: true }));
  $("mark-read").addEventListener("click", () => {
    const chosen = showing ? feeds().filter((f) => f.url === showing) : feeds();
    for (const f of chosen) for (const it of cache[f.url]?.items || []) read.add(itemKey(f.url, it));
    store(READ_KEY, [...read]);
    render();
  });
  $("export").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([toOpml(feeds())], { type: "text/x-opml" }));
    a.download = "Kessel feeds.opml";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const incoming = fromOpml(await file.text(), parser);
      const have = new Set(feeds().map((f) => f.url));
      const added = incoming.filter((f) => !have.has(f.url));
      await saveFeeds([...feeds(), ...added]);
      toast(`Following ${added.length} more feed${added.length === 1 ? "" : "s"}`);
      render();
      refreshAll();
    } catch (err) {
      toast(String(err?.message || err));
    }
  });
  window.addEventListener("kessel-settings", render);
}

window.addEventListener("DOMContentLoaded", async () => {
  $("title").innerHTML = `${icon("book", 17)}<span>Feeds</span>`;
  await initTheme();
  wire();
  render();
  await refreshAll();
  setInterval(refreshAll, 5 * 60000);
});
