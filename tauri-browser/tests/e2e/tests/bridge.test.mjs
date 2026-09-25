// The page bridge (src-tauri/src/bridge.rs): how Kessel's script in a page
// reaches Kessel -- on every kind of page, from iframes too, without a page
// being able to fake it or to crash the browser through it.

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function tabCount(k) {
  return (await k.tabs()).length;
}

export const tests = [
  {
    name: "a page can't crash Kessel through the message channel",
    async run({ launch, site, assert, sleep }) {
      const k = await launch();
      const [tab] = await k.tabs();
      // An address longer than 64 KB -- more than wry's IPC listener could
      // parse (it used to abort the whole browser).
      const url = `${site.origin}/page/Long?${"a".repeat(70_000)}`;
      await k.invoke("navigate", { id: tab.id, url });
      const page = await k.page((t) => t.url.startsWith(`${site.origin}/page/Long`));
      await page.waitFor(`document.readyState === 'complete'`);
      await page.evaluate(`chrome.webview.postMessage('not an IPC message'); window.ipc && window.ipc.postMessage('{}'); 1`);
      await sleep(800);
      assert.equal((await k.tabs()).length, 1, "Kessel is still running");
      assert.equal(await page.evaluate(`document.title`), "Long", "and so is the page");
    },
  },
  {
    name: "links and keys work in a local file",
    async run({ launch, assert, waitFor }) {
      const dir = mkdtempSync(path.join(tmpdir(), "kessel-local-"));
      const other = path.join(dir, "other.html");
      writeFileSync(other, `<!doctype html><title>Other File</title><p>Other</p>`);
      const file = path.join(dir, "first.html");
      writeFileSync(file, `<!doctype html><title>First File</title><a id="link" href="${pathToFileURL(other).href}">other</a>`);
      const k = await launch();
      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url: pathToFileURL(file).href });
      const page = await k.page((t) => t.url.startsWith("file:") && t.url.endsWith("first.html"));
      await page.waitFor(`document.readyState === 'complete' && document.title === 'First File'`);
      // A key handed back by the page's script.
      const toolbar = await k.toolbar();
      await page.key("Ctrl+L");
      await toolbar.waitFor(`document.activeElement === document.getElementById('url-input')`, { message: "Ctrl+L from a local file" });
      // A Ctrl+click.
      await page.clickSelector("#link", { modifiers: ["ctrl"] });
      await waitFor(async () => (await k.tabs()).some((t) => t.url.endsWith("other.html")), { message: "the link in a new tab" });
      assert.equal(await tabCount(k), 2, "two tabs");
    },
  },
  {
    name: "Ctrl+click works inside an iframe",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url: `${site.origin}/frame/Framed` });
      await waitFor(async () => (await k.activeTab()).title === "Framed", { message: "framed page" });
      const own = (await k.targets()).find((t) => t.url.endsWith("/page/Framed-inner"));
      const frame = own ? await k.attach(own) : null;
      if (frame) {
        await frame.waitFor(`document.readyState === 'complete'`);
        await frame.clickSelector("#link-other", { modifiers: ["ctrl"] });
      } else {
        // Same-origin iframes share the page's DevTools target: click through it.
        const outer = await k.page((t) => t.url.endsWith("/frame/Framed"));
        await outer.waitFor(`document.getElementById('inner').contentDocument && document.getElementById('inner').contentDocument.readyState === 'complete'`);
        const box = await outer.evaluate(`(() => { const f = document.getElementById('inner'); const a = f.contentDocument.getElementById('link-other'); const fr = f.getBoundingClientRect(); const r = a.getBoundingClientRect(); return { x: fr.left + r.left + r.width / 2, y: fr.top + r.top + r.height / 2 }; })()`);
        await outer.click(box.x, box.y, { modifiers: ["ctrl"] });
      }
      await waitFor(async () => (await k.tabs()).some((t) => t.url.endsWith("/page/other")), { message: "the iframe's link in a new tab" });
    },
  },
  {
    name: "a website can't open Kessel's own pages, in its tab or in a frame",
    async run({ launch, site, assert, sleep }) {
      const k = await launch();
      const appOrigin = new URL((await k.toolbar()).url).origin;
      const [tab] = await k.tabs();
      const url = `${site.origin}/page/Sneaky`;
      await k.invoke("navigate", { id: tab.id, url });
      const page = await k.page(url);
      await page.waitFor(`document.readyState === 'complete'`);
      // A frame first.
      await page.evaluate(`(() => { const f = document.createElement('iframe'); f.id = 'framed'; f.src = ${JSON.stringify(`${appOrigin}/settings.html`)}; document.body.prepend(f); })()`);
      await sleep(1500);
      const { frameTree } = await page.session.send("Page.getFrameTree");
      const childUrls = (frameTree.childFrames || []).map((f) => f.frame.url);
      assert(!childUrls.some((u) => u.startsWith(appOrigin)), `no Kessel page in the frame (${childUrls.join(", ")})`);
      // Then the whole tab.
      await page.evaluate(`location.href = ${JSON.stringify(`${appOrigin}/settings.html#privacy`)}; 1`).catch(() => {});
      await sleep(1500);
      const now = (await k.tabs()).find((t) => t.id === tab.id);
      assert.equal(now.url, url, "the tab stayed on the website");
      assert(!(await k.targets()).some((t) => t.url.startsWith(`${appOrigin}/settings.html`)), "no Settings page anywhere");
    },
  },
  {
    name: "a page can't fake Kessel's messages",
    async run({ launch, site, assert, sleep }) {
      const k = await launch();
      const [tab] = await k.tabs();
      const url = `${site.origin}/page/Forger`;
      await k.invoke("navigate", { id: tab.id, url });
      const page = await k.page(url);
      await page.waitFor(`document.readyState === 'complete'`);
      await page.evaluate(`chrome.webview.postMessage({ k: 'guess', t: 'link', d: { url: '${site.origin}/page/popup', ctrl: true, shift: false, button: 0 } }); 1`);
      await page.evaluate(`chrome.webview.postMessage({ t: 'key', d: { vk: 84, ctrl: true } }); 1`);
      await sleep(1000);
      assert.equal(await tabCount(k), 1, "no tab opened");
    },
  },
];
