// Browser extensions (extensions.rs), run by WebView2 itself: loaded from a
// folder (developer mode), and installed from a "store" -- a local server
// standing in for the Chrome Web Store's update service, serving a CRX3
// signed with a key made for the test.

import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extensionFiles, writeExtension, zip, crx3, signingKey } from "../lib/extension.mjs";

let visits = 0;

// Opens `url` in tab `tab` (a fresh address each time) and returns what the
// test extension marked the page with once it has loaded: { ext, n }.
async function visit(k, tab, url) {
  const fresh = `${url}?visit=${++visits}`;
  await k.invoke("navigate", { id: tab, url: fresh });
  const page = await k.page((t) => t.url === fresh, { timeout: 15000 });
  await page.waitFor(`document.readyState === "complete"`, { timeout: 15000 });
  // The content script runs at document_end; its storage read a moment later.
  await new Promise((r) => setTimeout(r, 400));
  return page.evaluate(`({ ext: document.documentElement.dataset.kesselExt || "", n: document.documentElement.dataset.kesselN || "" })`);
}

// Visits until the page shows `ext` (the engine loads extensions in the
// background).
async function visitUntil(k, tab, url, ext, waitFor, message) {
  let last;
  try {
    await waitFor(
      async () => {
        try {
          last = await visit(k, tab, url);
        } catch (e) {
          last = { error: e.message.split("\n")[0] };
          return false;
        }
        return last.ext === ext;
      },
      { timeout: 30000, interval: 300, message }
    );
  } catch (e) {
    throw new Error(`${e.message} -- the page last showed ${JSON.stringify(last)}`);
  }
  return last;
}

// Stores `n` through the extension's options page.
async function store(k, id, n) {
  await k.invoke("open_extension_page", { id });
  const options = await k.page((t) => t.url.startsWith(`chrome-extension://${id}/options.html`), { timeout: 15000 });
  await options.evaluate(`chrome.storage.local.set({ n: ${n} }).then(() => true)`);
}

export const tests = [
  {
    name: "an unpacked extension runs, keeps its data when reloaded, and can be switched off",
    async run({ launch, site, assert, waitFor }) {
      const dir = writeExtension(mkdtempSync(path.join(tmpdir(), "kessel-ext-")), extensionFiles({ marker: "v1" }));
      const k = await launch();
      const tab = (await k.activeTab()).id;
      const ext = await k.invoke("load_unpacked_extension", { path: dir });
      assert(ext && ext.id.length === 32, "it's loaded, with an id");
      assert.equal(ext.name, "Kessel Test Extension", "its name comes from its manifest");
      await visitUntil(k, tab, `${site.origin}/page/Ext`, "v1", waitFor, "its content script runs on pages");

      await store(k, ext.id, 42);
      writeFileSync(path.join(dir, "content.js"), extensionFiles({ marker: "v2" })["content.js"]);
      await k.invoke("reload_extension", { id: ext.id });
      const after = await visitUntil(k, tab, `${site.origin}/page/Ext`, "v2", waitFor, "Reload loads the changed files");
      assert.equal(after.n, "42", "and its data is still there");

      await k.invoke("set_extension_enabled", { id: ext.id, enabled: false });
      await visitUntil(k, tab, `${site.origin}/page/Ext`, "", waitFor, "switched off, it stops running");
      await k.invoke("set_extension_enabled", { id: ext.id, enabled: true });
      await visitUntil(k, tab, `${site.origin}/page/Ext`, "v2", waitFor, "switched on again, it runs");

      await k.invoke("remove_extension", { id: ext.id });
      await visitUntil(k, tab, `${site.origin}/page/Ext`, "", waitFor, "removed, it's gone");
      assert.equal((await k.invoke("list_extensions")).length, 0, "and off the list");
    },
  },
  {
    name: "a store extension installs under its store id, keeps to its sites, and updates keeping its data",
    async run({ launch, site, assert, waitFor }) {
      const key = signingKey();
      let served = crx3(zip(extensionFiles({ version: "1.0", marker: "s1" })), key);
      let offered = "1.0";
      const requests = [];
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://store");
        requests.push(`${url.pathname} ${url.searchParams.get("response")}`);
        const x = new URLSearchParams(url.searchParams.get("x") || "");
        if (x.get("id") !== key.id) {
          res.writeHead(404).end();
        } else if (url.searchParams.get("response") === "updatecheck") {
          const status = offered === x.get("v") ? `status="noupdate"` : `codebase="http://store/x.crx" version="${offered}" status="ok"`;
          res.writeHead(200, { "Content-Type": "text/xml" }).end(`<?xml version="1.0"?><gupdate><app appid="${key.id}" status="ok"><updatecheck ${status}/></app></gupdate>`);
        } else {
          res.writeHead(200, { "Content-Type": "application/x-chrome-extension" }).end(served);
        }
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      try {
        const k = await launch({ env: { KESSEL_TEST_EXTENSION_STORE: `http://127.0.0.1:${server.address().port}` } });
        const tab = (await k.activeTab()).id;
        const preview = await k.invoke("preview_store_extension", { store: "chrome", id: key.id });
        assert.equal(preview.extension.id, key.id, "it has the store's id");
        assert.deepEqual(preview.extension.permissions, ["storage"], "you see what it asks for");
        assert.deepEqual(preview.extension.hosts, ["<all_urls>"], "and on which sites");
        assert(requests.some((r) => r.startsWith("/chrome redirect")), "the package came from the store's address");
        const ext = await k.invoke("confirm_extension_install", { token: preview.token });
        assert.equal(ext.source, "chrome", "it's a Chrome Web Store extension");
        await visitUntil(k, tab, `${site.origin}/page/Store`, "s1", waitFor, "it runs on pages");

        const narrowed = await k.invoke("set_extension_access", { id: key.id, access: "sites", sites: ["https://www.example.com/x"] });
        assert.deepEqual(narrowed.sites, ["example.com"], "sites are kept as host names");
        assert.equal(narrowed.restart, true, "its narrowed manifest waits for a restart (its scripts don't)");
        await visitUntil(k, tab, `${site.origin}/page/Store`, "", waitFor, "only allowed on example.com, it leaves this site alone");
        const widened = await k.invoke("set_extension_access", { id: key.id, access: "all", sites: [] });
        assert.equal(widened.restart, false, "back as it was, nothing waits for a restart");
        await visitUntil(k, tab, `${site.origin}/page/Store`, "s1", waitFor, "allowed everywhere again, it runs here");

        await store(k, key.id, 7);
        assert.deepEqual(await k.invoke("update_extensions", {}), [], "no update while the store has none");
        served = crx3(zip(extensionFiles({ version: "2.0", marker: "s2" })), key);
        offered = "2.0";
        assert.deepEqual(await k.invoke("update_extensions", {}), ["Kessel Test Extension"], "the newer version installs");
        const after = await visitUntil(k, tab, `${site.origin}/page/Store`, "s2", waitFor, "and runs");
        assert.equal(after.n, "7", "keeping its data");
        const [updated] = await k.invoke("list_extensions");
        assert.equal(updated.version, "2.0", "the list shows the new version");
        assert.equal(updated.restart, false, "a new version with the same manifest needs no restart");
      } finally {
        server.close();
      }
    },
  },
  {
    name: "extensions stay out of private windows, and a private window leaves them installed",
    async run({ launch, site, assert, waitFor }) {
      const dir = writeExtension(mkdtempSync(path.join(tmpdir(), "kessel-ext-")), extensionFiles({ marker: "p1" }));
      const k = await launch();
      const tab = (await k.activeTab()).id;
      const ext = await k.invoke("load_unpacked_extension", { path: dir });
      await visitUntil(k, tab, `${site.origin}/page/Normal`, "p1", waitFor, "it runs in a normal window");
      await store(k, ext.id, 5);
      await k.invoke("new_window", { private: true });
      const privateWin = await waitFor(async () => (await k.toolbars()).find((t) => t.private), { message: "a private window" });
      const privateTab = await waitFor(async () => (await k.tabs(privateWin.label))[0]?.id, { message: "the private window's tab" });
      assert.equal((await visit(k, privateTab, `${site.origin}/page/Private`)).ext, "", "not in a private window");
      // Changing something while a private window is open doesn't take it
      // away from the normal ones (they share the engine profile).
      await k.invoke("set_extension_enabled", { id: ext.id, enabled: false });
      await k.invoke("set_extension_enabled", { id: ext.id, enabled: true });
      const back = await visitUntil(k, tab, `${site.origin}/page/Normal`, "p1", waitFor, "it still runs in the normal window");
      assert.equal(back.n, "5", "with its data");
    },
  },
];
