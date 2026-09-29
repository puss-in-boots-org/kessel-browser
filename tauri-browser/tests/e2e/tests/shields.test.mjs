// Shields' network blocking (main.rs install_shields_hooks): what it's told
// to block is blocked, and switching Shields off and on applies to pages
// already open (their requests only come past Shields while it's on).

import { startServer } from "../lib/server.mjs";

// Loads `url` as a script in page `page`: "loaded" or "blocked" (Shields
// answers a blocked request with a 403, which a script reports as an error --
// a no-cors fetch would call it a success).
const probe = (page, url) =>
  page.evaluate(`new Promise((done) => {
    const s = document.createElement("script");
    s.src = ${JSON.stringify(url)} + "?n=" + Math.random();
    s.onload = () => done("loaded");
    s.onerror = () => done("blocked");
    document.head.append(s);
  })`);

async function setShields(k, on) {
  const settings = await k.invoke("get_settings");
  await k.invoke("update_settings", { settings: { ...settings, adblock_enabled: on } });
}

export const tests = [
  {
    name: "Shields blocks a blocked site's requests, and switching it off and on reaches open pages",
    async run({ launch, site, assert, waitFor }) {
      const other = await startServer("127.0.0.3");
      const k = await launch();
      await k.invoke("add_custom_blocked_domain", { domain: "127.0.0.3" });
      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url: `${site.origin}/page/Host` });
      const page = await k.page((t) => t.url === `${site.origin}/page/Host`);
      await page.waitFor(`document.readyState === "complete" && location.pathname === "/page/Host"`);
      const target = `${other.origin}/script/tracker.js`;
      await waitFor(async () => (await probe(page, target)) === "blocked", { message: "the blocked site's request is blocked" });

      await setShields(k, false);
      await waitFor(async () => (await probe(page, target)) === "loaded", { message: "with Shields off, it goes through -- on the page already open" });

      await setShields(k, true);
      await waitFor(async () => (await probe(page, target)) === "blocked", { message: "Shields on again: blocked again" });
      assert.equal(await probe(page, `${site.origin}/script/own.js`), "loaded", "the page's own site is untouched");
    },
  },
];
