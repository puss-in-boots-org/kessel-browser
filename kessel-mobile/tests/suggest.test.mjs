// The phone address bar's suggestions (app/src/main/assets/ui/suggest.js).
// Run: node --test kessel-mobile/tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import { uiModule } from "./load-ui.mjs";

const { shortUrl, completeAddress, firstItem, historyMatches, bookmarkMatches, tabMatches, assemble, topSites } = await uiModule("suggest.js");

const history = [
  ["https://www.youtube.com/watch?v=1", "Cats - YouTube", 12, 100],
  ["http://localhost:8080/app", "My app", 3, 90],
  ["https://en.wikipedia.org/wiki/Kessel", "Kessel - Wikipedia", 2, 80],
  ["https://www.youtube.com/feed/subscriptions", "Subscriptions", 1, 70],
];

test("addresses read well", () => {
  assert.equal(shortUrl("https://www.example.com/"), "example.com");
  assert.equal(shortUrl("https://example.com/a%20b"), "example.com/a b");
});

test("completes the sites you've been to", () => {
  assert.deepEqual(completeAddress("yout", history), { url: "https://www.youtube.com/", fill: "youtube.com" });
  assert.deepEqual(completeAddress("www.yo", history), { url: "https://www.youtube.com/", fill: "www.youtube.com" });
  assert.deepEqual(completeAddress("localh", history), { url: "http://localhost:8080/", fill: "localhost:8080" });
  assert.deepEqual(completeAddress("youtube.com/fe", history), { url: "https://www.youtube.com/feed/subscriptions", fill: "youtube.com/feed/subscriptions" });
  assert.equal(completeAddress("y", history), null, "one letter is too little");
  assert.equal(completeAddress("cute cats", history), null, "a search");
  assert.equal(completeAddress("zzz", history), null);
});

test("the first row goes, searches, or takes the completion", () => {
  assert.deepEqual(firstItem("example.com", "google"), { kind: "go", title: "example.com", detail: "Go to site", url: "https://example.com" });
  const search = firstItem("cute cats", "duckduckgo");
  assert.equal(search.kind, "search");
  assert.equal(search.detail, "DuckDuckGo Search");
  assert.equal(search.url, "https://duckduckgo.com/?q=cute%20cats");
  assert.equal(firstItem("? example.com", "google").kind, "search", "? forces a search");
  assert.equal(firstItem("yout", "google", { url: "https://www.youtube.com/", fill: "youtube.com" }).url, "https://www.youtube.com/");
});

test("history, bookmarks and tabs match every word", () => {
  assert.deepEqual(historyMatches("wiki kessel", history).map((h) => h.url), ["https://en.wikipedia.org/wiki/Kessel"]);
  assert.equal(historyMatches("youtube", history, 1).length, 1);
  assert.deepEqual(historyMatches("   ", history), []);
  const bookmarks = [{ url: "https://news.site/", title: "Morning news" }];
  assert.equal(bookmarkMatches("morning", bookmarks)[0].kind, "bookmark");
  const tabs = [
    { id: 1, url: "https://a.example/", title: "Alpha", private: false },
    { id: 2, url: "https://b.example/", title: "Alpha private", private: true },
    { id: 3, url: "https://c.example/", title: "Alpha here", private: false },
  ];
  assert.deepEqual(tabMatches("alpha", tabs, { activeId: 3, private: false }).map((t) => t.tabId), [1]);
  assert.deepEqual(tabMatches("alpha", tabs, { activeId: 3, private: true }).map((t) => t.tabId), [2]);
});

test("each page shows up once, answers first after what you typed", () => {
  const items = assemble({
    first: { kind: "search", url: "https://s/?q=x" },
    answers: [{ kind: "answer", title: "= 4" }],
    tabs: [{ kind: "tab", url: "https://a/" }],
    bookmarks: [{ kind: "bookmark", url: "https://a/" }],
    history: [{ kind: "history", url: "https://b/" }],
    suggestions: [{ kind: "suggestion", url: "https://s/?q=x" }, { kind: "suggestion", url: "https://s/?q=y" }],
  });
  assert.deepEqual(items.map((i) => i.kind), ["search", "answer", "tab", "history", "suggestion"]);
  assert.equal(assemble({ first: { kind: "go", url: "u" }, history: Array.from({ length: 20 }, (_, i) => ({ kind: "history", url: `h${i}` })) }).length, 9);
});

test("most visited: one tile per site", () => {
  const tiles = topSites(history);
  assert.deepEqual(tiles.map((t) => t.host), ["youtube.com", "localhost:8080", "en.wikipedia.org"]);
});
