// The privacy dashboard (kessel://privacy, privacy_stats.rs): what Shields
// blocked and cleaned, counted over time and per site; your protections;
// what sites may use; what Kessel connects to by itself.

import { startServer } from "../lib/server.mjs";

// Loads `url` as a script: "loaded" or "blocked" (see shields.test.mjs).
const probe = (page, url) =>
  page.evaluate(`new Promise((done) => {
    const s = document.createElement("script");
    s.src = ${JSON.stringify(url)} + "?n=" + Math.random();
    s.onload = () => done("loaded");
    s.onerror = () => done("blocked");
    document.head.append(s);
  })`);

const number = (page, id) => page.evaluate(`Number(document.getElementById('${id}').textContent.replace(/[^0-9]/g, ''))`);

export const tests = [
  {
    name: "the privacy dashboard counts what Shields blocked and cleaned, per site; shows your protections and what sites may use",
    async run({ launch, site, assert, waitFor }) {
      const other = await startServer("127.0.0.3");
      try {
        const k = await launch();
        await k.invoke("add_custom_blocked_domain", { domain: "127.0.0.3" });
        const [tab] = await k.tabs();
        // An address with tracking in it: cleaned before it loads.
        await k.invoke("navigate", { id: tab.id, url: `${site.origin}/page/Counted?utm_source=news&fbclid=abc` });
        const page = await k.page((t) => t.url.startsWith(`${site.origin}/page/Counted`));
        await page.waitFor(`document.readyState === "complete" && location.pathname === "/page/Counted"`);
        assert(!(await page.evaluate(`location.search`)).includes("utm_source"), "the tracking taken out");
        // (The blocked site's rule takes a moment to apply.)
        await waitFor(async () => (await probe(page, `${other.origin}/script/tracker.js`)) === "blocked", { message: "a tracker blocked" });
        for (let i = 0; i < 2; i++) assert.equal(await probe(page, `${other.origin}/script/tracker.js`), "blocked", "and again");

        const stats = await waitFor(async () => {
          const s = await k.invoke("privacy_stats");
          return s.hours.reduce((n, h) => n + h[1], 0) >= 3 && s;
        }, { message: "blocked counted" });
        const sum = (i) => stats.hours.reduce((n, h) => n + h[i], 0);
        assert(sum(3) >= 1, `cleaned counted: ${sum(3)}`);
        assert.deepEqual(stats.sites[0], ["127.0.0.2", sum(1)], "on the page's own site");

        // A site allowed the camera.
        const settings = await k.invoke("get_settings");
        await k.invoke("update_settings", { settings: { ...settings, features: { ...settings.features, site_permissions: { "meet.example": { camera: "allow" } } } } });

        await k.invoke("run_command", { id: "privacy-dashboard" });
        const dash = await k.page((t) => t.url.includes("privacy.html"));
        await dash.waitFor(`document.body.dataset.ready === 'true'`, { message: "the dashboard" });
        assert((await number(dash, "n-blocked")) >= 3, "blocked, this week");
        assert((await number(dash, "n-stripped")) >= 1, "addresses cleaned, this week");
        assert.equal(await dash.evaluate(`document.querySelector('#sites .row')?.dataset.site`), "127.0.0.2", "the site where most was blocked");
        assert.equal(await dash.evaluate(`document.querySelectorAll('#chart .bar').length`), 7, "a bar for each of the 7 days");
        await dash.evaluate(`document.querySelector('#ranges [data-days="30"]').click()`);
        assert.equal(await dash.evaluate(`document.querySelectorAll('#chart .bar').length`), 30, "and 30");
        const text = await dash.evaluate(`document.body.innerText`);
        assert(/Shields: ads and trackers blocked[\s\S]*?On/.test(text), "Shields on");
        assert(text.includes("1 site may use your camera") && text.includes("meet.example"), "the site with the camera");
        assert(/Telemetry, crash reports, an account[\s\S]*?Never/.test(text), "no telemetry");

        // Starting again: from zero.
        await k.invoke("reset_privacy_stats");
        await dash.evaluate(`location.reload()`);
        await dash.waitFor(`document.readyState === 'complete' && document.body.dataset.ready === 'true'`, { message: "the dashboard again" });
        assert.equal(await number(dash, "n-blocked"), 0, "nothing counted");
      } finally {
        await other.close();
      }
    },
  },
];
