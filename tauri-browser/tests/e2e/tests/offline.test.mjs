// When a site can't be reached (main.rs, security.rs, warning.html kind
// "offline"): Kessel's page, Try again, and again by itself once the PC is
// back online -- and the reading list's copies to read offline (sidebar.rs).

import { startServer } from "../lib/server.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  return tab.id;
}

const tab = async (k, id) => (await k.tabs()).find((t) => t.id === id);

// A port nothing listens on (yet).
async function freePort() {
  const probe = await startServer("127.0.0.2");
  const port = Number(new URL(probe.origin).port);
  await probe.close();
  return port;
}

async function offlinePage(k, waitFor, id) {
  await waitFor(async () => (await tab(k, id))?.url.includes("kind=offline"), { message: "Kessel's can't-be-reached page", timeout: 20000 });
  const page = await k.page((t) => t.url.includes("warning.html") && t.url.includes("kind=offline"));
  await page.waitFor(`document.getElementById('back').textContent === 'Try again'`, { message: "with Try again" });
  return page;
}

export const tests = [
  {
    name: "a site that can't be reached: Kessel's page says so, and Try again loads it once it's back",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const port = await freePort();
      const url = `http://127.0.0.2:${port}/page/Back`;
      const id = await open(k, url);
      const page = await offlinePage(k, waitFor, id);
      assert.equal(await page.evaluate(`document.getElementById('title').textContent`), "This page can't be reached", "what it says");
      const toolbar = await k.toolbar();
      assert.equal(await toolbar.evaluate(`document.getElementById('url-input').value`), url, "the address bar keeps the address");
      assert.equal(await toolbar.evaluate(`document.getElementById('lock-icon').dataset.state`), "none", "no warning sign: nothing dangerous");
      const site = await startServer("127.0.0.2", port);
      try {
        await page.evaluate(`document.getElementById('back').click()`);
        await waitFor(async () => (await tab(k, id))?.url === url, { message: "loaded" });
        await k.page((t) => t.url === url);
      } finally {
        await site.close();
      }
    },
  },
  {
    name: "offline, then back online: the page goes there by itself",
    async run({ launch, waitFor }) {
      const k = await launch();
      const port = await freePort();
      const url = `http://127.0.0.2:${port}/page/Again`;
      const id = await open(k, url);
      const page = await offlinePage(k, waitFor, id);
      const offline = (on) => page.session.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.session.send("Network.enable");
      await offline(true);
      await page.waitFor(`!navigator.onLine`, { message: "offline" });
      const site = await startServer("127.0.0.2", port);
      try {
        await offline(false);
        await waitFor(async () => (await tab(k, id))?.url === url, { message: "back online: loaded by itself", timeout: 15000 });
      } finally {
        await site.close();
      }
    },
  },
  {
    name: "the reading list keeps a copy of a page to read offline; the can't-be-reached page offers it",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const port = await freePort();
      const site = await startServer("127.0.0.2", port);
      const url = `${site.origin}/article/Kept`;
      let id;
      try {
        id = await open(k, url);
        const page = await k.page((t) => t.url === url);
        await page.waitFor(`document.readyState === 'complete' && document.title === 'Kept'`);
        await k.invoke("add_to_reading_list", { url, title: "Kept" });
        await waitFor(async () => (await k.invoke("get_reading_list")).find((i) => i.url === url)?.offline, { message: "a copy kept" });
      } finally {
        await site.close();
      }
      const copy = await k.invoke("reading_offline_copy", { url });
      assert(copy && copy.startsWith("file:///") && copy.endsWith(".mhtml"), `a web archive on this PC (${copy})`);

      // The site's gone: its page offers the copy, and the copy is the page.
      await k.invoke("reload", { id });
      const offline = await offlinePage(k, waitFor, id);
      await offline.waitFor(`!!document.getElementById('saved-copy')`, { message: "the copy offered" });
      await offline.evaluate(`document.getElementById('saved-copy').click()`);
      const saved = await k.page((t) => t.url.startsWith("file:///") && t.url.endsWith(".mhtml"), { timeout: 15000 });
      await saved.waitFor(`document.readyState === 'complete' && document.title === 'Kept'`, { message: "the saved copy, with its title" });
      assert(await saved.evaluate(`document.body.innerText.includes('How glass bends light')`), "and its text");

      await k.invoke("remove_from_reading_list", { url });
      assert.equal(await k.invoke("reading_offline_copy", { url }), null, "removed: the copy goes too");
    },
  },
];
