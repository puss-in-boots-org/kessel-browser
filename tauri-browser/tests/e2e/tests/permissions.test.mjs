// Site permissions (permissions.rs, permission.html): Kessel's own prompt
// under the address bar, your answers kept per site, defaults that answer
// for you, and several downloads at once.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id: tab.id, page };
}

async function prompt(k) {
  const p = await k.page((t) => t.url.includes("permission.html"), { timeout: 8000 });
  await p.waitFor(`document.getElementById('title').textContent.length > 0`);
  return p;
}

export const tests = [
  {
    name: "a site asks: Kessel's prompt; Allow is kept for the site, Block says no",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/page/Asks`);

      const notifications = page.evaluate(`Notification.requestPermission()`, { userGesture: true });
      const p = await prompt(k);
      assert.equal(await p.evaluate(`document.getElementById('title').textContent`), "127.0.0.2 wants to show notifications", "what it asks");
      await p.evaluate(`document.getElementById('allow').click()`);
      assert.equal(await notifications, "granted", "the site hears yes");
      await waitFor(async () => (await k.invoke("get_settings")).features.site_permissions?.["127.0.0.2"]?.notifications === "allow", { message: "kept for the site" });
      assert.equal(await page.evaluate(`Notification.requestPermission()`, { userGesture: true }), "granted", "asked again: no prompt, still yes");

      const location = page.evaluate(`new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('allowed'), (e) => r('error ' + e.code), { timeout: 20000 }))`, { userGesture: true });
      const q = await prompt(k);
      await q.evaluate(`document.getElementById('block').click()`);
      assert.equal(await location, "error 1", "blocked: permission denied");
    },
  },
  {
    name: "a default of Block answers without asking",
    async run({ launch, site, assert }) {
      const k = await launch({ settings: { features: { permission_defaults: { camera: "block" } } } });
      const { page } = await open(k, `${site.origin}/page/Camera`);
      const answer = await page.evaluate(`navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'allowed', (e) => e.name)`, { userGesture: true });
      assert.equal(answer, "NotAllowedError", "refused");
      assert(!(await k.targets()).some((t) => t.url.includes("permission.html")), "without a prompt");
    },
  },
  {
    name: "several downloads at once ask the site's permission",
    async run({ launch, site, assert }) {
      const folder = mkdtempSync(path.join(tmpdir(), "kessel-downloads-"));
      try {
        const k = await launch({ settings: { features: { download_dir: folder } } });
        const { page } = await open(k, `${site.origin}/page/Files`);
        await page.evaluate(`(() => { for (const n of [1, 2]) { const a = document.createElement('a'); a.href = '/download/many' + n + '.txt'; a.download = 'many' + n + '.txt'; document.body.append(a); a.click(); } })()`, { userGesture: true });
        const p = await prompt(k);
        assert.equal(await p.evaluate(`document.getElementById('title').textContent`), "127.0.0.2 wants to download several files", "what it asks");
        await p.evaluate(`document.getElementById('block').click()`);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  },
];
