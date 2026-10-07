// What the engine does to make pages fast and work offline, through
// Kessel: a page asking for the next page early (prefetch, prerender), and
// a service worker answering from its cache when the site can't be reached.

import { startServer, seen } from "../lib/server.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id: tab.id, page };
}

export const tests = [
  {
    name: "a page asking for the next pages early: <link rel=prefetch> and speculation rules",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/speculate`);
      const asked = (path) => seen.filter((r) => r.origin === site.origin && r.path === path);
      await waitFor(() => asked("/page/Prefetched").length > 0, { message: "the prefetch asked for" });
      assert.equal(asked("/page/Prefetched")[0].purpose, "prefetch", "as a prefetch");
      await waitFor(() => asked("/page/Prerendered").length > 0, { message: "the prerender asked for" });
      assert.equal(asked("/page/Prerendered")[0].purpose, "prefetch;prerender", "as a prerender");
      // Followed: what was fetched ahead is used, not fetched again.
      await page.evaluate(`document.querySelector('a').click()`, { userGesture: true });
      const next = await k.page((t) => t.url === `${site.origin}/page/Prerendered`);
      await next.waitFor(`document.readyState === 'complete' && !document.prerendering`, { message: "the next page" });
      assert.equal(asked("/page/Prerendered").length, 1, "no second request for it");
    },
  },
  {
    name: "a service worker keeps a page in its cache: it opens with its site gone",
    async run({ launch, assert, waitFor }) {
      const other = await startServer("127.0.0.3");
      let closed = false;
      try {
        const k = await launch({ settings: { shields_https_upgrade: false } });
        const url = `${other.origin}/page/Offline`;
        const { id, page } = await open(k, url);
        const cached = await page.evaluate(`navigator.serviceWorker.register('/sw-cache.js').then(() => navigator.serviceWorker.ready).then(() => caches.match('/page/Offline')).then((r) => !!r)`);
        assert(cached, "the page in the service worker's cache");
        await page.waitFor(`!!navigator.serviceWorker.controller`, { message: "the service worker in charge" });
        // Background sync: the service worker hears "sync" once it's online.
        assert.equal(await page.evaluate(`navigator.serviceWorker.ready.then((reg) => reg.sync.register('kessel-sync')).then(() => 'registered', (e) => e.name)`), "registered", "a background sync registered");
        await page.waitFor(`caches.match('/synced').then((r) => r ? r.text() : '').then((t) => t === 'kessel-sync')`, { message: "and the service worker synced" });
        await other.close();
        closed = true;
        // Its site gone: opened again, from the cache.
        await k.invoke("navigate", { id, url: `${url}` });
        await waitFor(async () => {
          const p = await k.page((t) => t.url === url).catch(() => null);
          return p && (await p.evaluate(`document.readyState === 'complete' && document.body.innerText.includes('Offline')`).catch(() => false));
        }, { message: "the page from the cache", timeout: 15000 });
        assert(!(await k.tabs()).find((t) => t.id === id).url.includes("kind=offline"), "not Kessel's can't-be-reached page");
      } finally {
        if (!closed) await other.close();
      }
    },
  },
];
