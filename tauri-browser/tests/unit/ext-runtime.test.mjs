// Kessel's extension runtime inside a page (src-tauri/src/ext_api.js): run
// against a stand-in page, the way ext_runtime.rs fills it in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { storeIdOf, nameFits, CATALOG } from "../../src/shared/store-catalog.js";

const TEMPLATE = readFileSync(new URL("../../src-tauri/src/ext_api.js", import.meta.url), "utf8");
const ID = "abcdefghijklmnopabcdefghijklmnop";
const KEY = new Uint8Array(32).map((_, i) => i + 1);
const KEY_B64 = Buffer.from(KEY).toString("base64");
const TAG = "0011223344556677";

function page(href, scripts, extra = {}) {
  const url = new URL(href);
  const posted = [];
  const listeners = [];
  const win = {
    chrome: { webview: { postMessage: (m) => posted.push(m), addEventListener: (_, f) => listeners.push(f) } },
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (t) => clearTimeout(t),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    crypto: webcrypto,
    addEventListener() {},
  };
  win.top = win;
  const doc = { readyState: "loading", documentElement: {}, addEventListener() {}, createElement: () => ({ setAttribute() {} }) };
  const config = { id: ID, key: KEY_B64, tag: TAG, manifest: { name: "Test", version: "1" }, messages: { hello: { message: "Hi $who$, $1!", placeholders: { who: { content: "there" } } } }, lang: "en-US", access: "all", sites: [], kessel: "1.0.0", ...extra };
  const src = TEMPLATE.replace("%TOKEN%", "tok").replace("%CONFIG%", JSON.stringify(config)).replace("%SCRIPTS%", scripts);
  new Function("window", "document", "location", "navigator", src)(win, doc, { href, hostname: url.hostname, pathname: url.pathname }, { languages: ["en-US"] });
  // Kessel's answer to a request, sealed as ext_runtime.rs seals it.
  async function deliver(msg) {
    const key = await webcrypto.subtle.importKey("raw", KEY, { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const c = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(msg))));
    const data = { kesselEvent: "kx", t: TAG, iv: Buffer.from(iv).toString("base64"), c: Buffer.from(c).toString("base64") };
    for (const f of listeners) f({ data });
    await new Promise((r) => setTimeout(r, 20));
  }
  return { posted, deliver, win };
}

const SCRIPT = (body, m = '["https://example.com/*"]') => `[{ m: ${m}, x: [], ig: [], xg: [], at: "document_start", all: false, blank: false, css: "", run: function (chrome, browser) { ${body} } }]`;

test("a script for pages runs where its pattern matches, with its own chrome", () => {
  globalThis.__ran = undefined;
  const p = page("https://example.com/a", SCRIPT("globalThis.__ran = chrome.runtime.id + '|' + (chrome === browser) + '|' + chrome.i18n.getMessage('Hello', 'friend');"));
  assert.equal(globalThis.__ran, `${ID}|true|Hi there, friend!`);
  assert.equal(p.posted[0].k, "tok");
  assert.equal(p.posted[0].t, "ext");
  assert.equal(p.posted[0].d.op, "hello");
  assert.equal(p.posted[0].d.s, KEY_B64);
  // The page's own chrome is untouched.
  assert.equal(p.win.chrome.runtime, undefined);
});

test("nothing runs, and nothing is sent, where it doesn't match", () => {
  globalThis.__ran = undefined;
  const p = page("https://other.org/", SCRIPT("globalThis.__ran = 1;"));
  assert.equal(globalThis.__ran, undefined);
  assert.equal(p.posted.length, 0);
});

test("site access keeps it to the sites you chose", () => {
  globalThis.__ran = undefined;
  page("https://www.example.com/", SCRIPT("globalThis.__ran = 1;", '["<all_urls>"]'), { access: "sites", sites: ["other.org"] });
  assert.equal(globalThis.__ran, undefined);
  page("https://news.other.org/", SCRIPT("globalThis.__ran = 2;", '["<all_urls>"]'), { access: "sites", sites: ["other.org"] });
  assert.equal(globalThis.__ran, 2);
});

test("storage answers come back sealed and are opened", async () => {
  globalThis.__got = undefined;
  const p = page("https://example.com/", SCRIPT("chrome.storage.local.get('a').then(function (v) { globalThis.__got = v; });"));
  const ask = p.posted.find((m) => m.d.op === "storage.get");
  const data = JSON.parse(ask.d.data);
  assert.deepEqual(data.body, { area: "local", keys: "a" });
  await p.deliver({ rid: data.rid, value: { a: 1 } });
  assert.deepEqual(globalThis.__got, { a: 1 });
});

test("callbacks get chrome.runtime.lastError on failure", async () => {
  globalThis.__err = undefined;
  const p = page("https://example.com/", SCRIPT("chrome.storage.sync.set({ x: 1 }, function () { globalThis.__err = chrome.runtime.lastError && chrome.runtime.lastError.message; });"));
  const ask = p.posted.find((m) => m.d.op === "storage.set");
  await p.deliver({ rid: JSON.parse(ask.d.data).rid, error: "quota" });
  assert.equal(globalThis.__err, "quota");
});

test("messages to the extension wait for the first real answer", async () => {
  globalThis.__answer = undefined;
  const p = page("https://example.com/", SCRIPT("chrome.runtime.sendMessage({ hi: 1 }).then(function (v) { globalThis.__answer = v; });"));
  const ask = p.posted.find((m) => m.d.op === "send");
  const body = JSON.parse(ask.d.data).body;
  assert.deepEqual(body.to, { ext: true });
  // Kessel delivered it to two parts.
  await p.deliver({ rid: JSON.parse(ask.d.data).rid, value: 2 });
  await p.deliver({ ev: "reply", rid: body.rid, none: true });
  assert.equal(globalThis.__answer, undefined);
  await p.deliver({ ev: "reply", rid: body.rid, value: "pong" });
  assert.equal(globalThis.__answer, "pong");
});

test("a message nobody can take fails like Chrome's", async () => {
  globalThis.__error = undefined;
  const p = page("https://example.com/", SCRIPT("chrome.runtime.sendMessage('x').catch(function (e) { globalThis.__error = e.message; });"));
  const ask = p.posted.find((m) => m.d.op === "send");
  await p.deliver({ rid: JSON.parse(ask.d.data).rid, value: 0 });
  assert.match(globalThis.__error, /Receiving end does not exist/);
});

test("an answer to another request is left alone", async () => {
  globalThis.__got = undefined;
  const p = page("https://example.com/", SCRIPT("chrome.storage.local.get(null).then(function (v) { globalThis.__got = v; });"));
  const ask = p.posted.find((m) => m.d.op === "storage.get");
  await p.deliver({ rid: "someone-else", value: 1 });
  assert.equal(globalThis.__got, undefined);
  await p.deliver({ rid: JSON.parse(ask.d.data).rid, value: {} });
  assert.deepEqual(globalThis.__got, {});
});

test("the extension's own page gets the API as its global chrome", () => {
  const p = page(`https://${ID}.ext.kessel/popup.html`, "[]");
  assert.equal(typeof p.win.chrome.tabs.query, "function");
  assert.equal(p.win.chrome.runtime.getURL("/x.png"), `https://${ID}.ext.kessel/x.png`);
  assert.equal(typeof p.win.chrome.webview.postMessage, "function");
  assert.equal(p.posted[0].d.kind, "page");
});

test("store links and ids", () => {
  assert.equal(storeIdOf("https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh"), "ddkjiahejlhfcafbddmgiahcphecmpfh");
  assert.equal(storeIdOf("https://chrome.google.com/webstore/detail/ddkjiahejlhfcafbddmgiahcphecmpfh?hl=en"), "ddkjiahejlhfcafbddmgiahcphecmpfh");
  assert.equal(storeIdOf("  eimadpbcbfnmbkopoojfekhnkhdbieeh "), "eimadpbcbfnmbkopoojfekhnkhdbieeh");
  assert.equal(storeIdOf("dark reader"), null);
  assert.ok(nameFits({ match: "dark reader" }, "Dark Reader"));
  assert.ok(!nameFits({ match: "dark reader" }, "Some Coupon Thing"));
  const ids = new Set();
  for (const e of CATALOG) {
    assert.match(e.id, /^[a-p]{32}$/, e.name);
    assert.ok(!ids.has(e.id), `${e.name} is listed twice`);
    ids.add(e.id);
    assert.ok(nameFits(e, e.name), `${e.name}'s match word isn't in its name`);
  }
});
