// Search engines and keywords (src/shared/search.js).
// Run: node --test tauri-browser/tests/unit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { allEngines, keywordSearch, resolveTyped, fillTemplate, engineById } from "../../src/shared/search.js";

test("keywords search their engine", () => {
  const s = { search_engine: "google" };
  assert.equal(resolveTyped("yt cute cats", s), "https://www.youtube.com/results?search_query=cute%20cats");
  assert.equal(resolveTyped("!w Kessel Run", s), "https://en.wikipedia.org/w/index.php?search=Kessel%20Run");
  assert.equal(resolveTyped("d weather", s), "https://duckduckgo.com/?q=weather");
  // Not a keyword: a plain search; an address stays an address.
  assert.equal(resolveTyped("cute cats", s), "https://www.google.com/search?q=cute%20cats");
  assert.equal(resolveTyped("example.com", s), "https://example.com");
  assert.equal(keywordSearch("yt", s), null, "a keyword alone isn't a search");
});

test("your own engines and keywords", () => {
  const s = {
    search_engine: "mine",
    features: {
      search_engines: [{ id: "mine", name: "Mine", url: "https://search.example/?q=%s&lang=en", keyword: "m" }],
      engine_keywords: { google: "gg" },
    },
  };
  assert.equal(resolveTyped("hello world", s), "https://search.example/?q=hello%20world&lang=en", "your engine as the default");
  assert.equal(resolveTyped("gg cats", s), "https://www.google.com/search?q=cats", "a changed keyword");
  assert.equal(resolveTyped("g cats", s), "https://search.example/?q=g%20cats&lang=en", "the old keyword is free again");
  assert.equal(resolveTyped("yt cats", s), "https://search.example/?q=yt%20cats&lang=en", "your list replaced the extra engines");
  assert.equal(resolveTyped("example.com/x", s), "https://example.com/x");
  assert.equal(engineById(s, "gone").id, "google", "a removed default falls back to Google");
  assert.equal(allEngines(s).filter((e) => !e.builtin).length, 1);
});

test("templates", () => {
  assert.equal(fillTemplate("https://x/?q=%s&again=%s", "a b"), "https://x/?q=a%20b&again=a%20b");
  assert.equal(fillTemplate("https://x/search/", "a&b"), "https://x/search/a%26b");
});
