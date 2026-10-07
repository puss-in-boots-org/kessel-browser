// Your own filter lists (shields.rs, Settings -> Privacy): added by their
// address, downloaded and applied like Shields' own, and gone when removed.

import { startServer } from "../lib/server.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return page;
}

const loaded = (page, sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).naturalWidth`);

export const tests = [
  {
    name: "a filter list of your own: added by its address, it blocks what it says; removed, it doesn't",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const other = await startServer("127.0.0.3");
      try {
        let visit = 0;
        const page = async () => open(k, `${site.origin}/content/Own?other=${encodeURIComponent(other.origin)}&v=${++visit}`);
        assert.equal(await loaded(await page(), "#other"), 1, "before: the other site's picture shows");

        await k.invoke("open_singleton_tab", { route: "kessel://settings/privacy" });
        const settings = await k.page((t) => t.url.includes("settings.html"));
        await settings.waitFor(`!!document.getElementById('add-list-url')`, { message: "the Shields card" });
        await settings.evaluate(`(() => { document.getElementById('add-list-url').value = ${JSON.stringify(`${site.origin}/filters.txt`)}; document.getElementById('add-list-btn').click(); })()`);
        const own = await waitFor(async () => (await k.invoke("shields_status")).lists.find((l) => l.own && l.updated_at), { message: "your list downloaded", timeout: 20000 });
        assert.equal(own.url, `${site.origin}/filters.txt`, "from its address");
        assert(own.enabled, "and on");
        await settings.waitFor(`[...document.querySelectorAll('#filter-lists .title')].some((t) => t.textContent.includes('/filters.txt'))`, { message: "listed in Settings" });

        await waitFor(async () => (await loaded(await page(), "#other")) === 0, { message: "the other site's picture blocked", timeout: 15000 });
        assert.equal(await loaded(await page(), "#own"), 1, "the page's own still shows");

        await settings.evaluate(`document.querySelector('[data-remove-list]').click()`);
        await waitFor(async () => !(await k.invoke("shields_status")).lists.some((l) => l.own), { message: "removed" });
        await waitFor(async () => (await loaded(await page(), "#other")) === 1, { message: "the picture back", timeout: 15000 });
      } finally {
        await other.close();
      }
    },
  },
];
