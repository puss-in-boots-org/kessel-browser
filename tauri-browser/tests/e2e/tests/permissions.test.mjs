// Site permissions (permissions.rs, permission.html): Kessel's own prompt
// under the address bar, your answers kept per site, defaults that answer
// for you, and several downloads at once.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id: tab.id, page };
}

// The prompt for the request just made: a new popup, not the last one,
// which may still be closing after you answered it.
let lastPrompt = null;
async function prompt(k) {
  const until = Date.now() + 10000;
  for (;;) {
    try {
      const p = await k.page((t) => t.url.includes("permission.html") && t.id !== lastPrompt, { timeout: 8000 });
      await p.waitFor(`document.getElementById('title').textContent.length > 0`, { timeout: 3000 });
      lastPrompt = p.target.id;
      return p;
    } catch (e) {
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
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
    name: "the microphone and MIDI devices ask with Kessel's prompt, and the answers hold",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/page/Studio`);

      const mic = page.evaluate(`navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'allowed', (e) => e.name)`, { userGesture: true });
      const p = await prompt(k);
      assert.equal(await p.evaluate(`document.getElementById('title').textContent`), "127.0.0.2 wants to use your microphone", "the microphone");
      await p.evaluate(`document.getElementById('block').click()`);
      assert.equal(await mic, "NotAllowedError", "refused");
      await waitFor(async () => !(await k.targets()).some((t) => t.url.includes("permission.html")), { message: "the first prompt gone" });

      const midi = page.evaluate(`navigator.requestMIDIAccess({ sysex: true }).then(() => 'allowed', (e) => e.name)`, { userGesture: true });
      const q = await prompt(k);
      assert.equal(await q.evaluate(`document.getElementById('title').textContent`), "127.0.0.2 wants to control MIDI devices", "MIDI");
      await q.evaluate(`document.getElementById('block').click()`);
      assert.equal(await midi, "NotAllowedError", "refused");
    },
  },
  {
    name: "sound playing on its own: a site set to block it can't start sound before you've done anything there",
    async run({ launch, site, assert }) {
      const k = await launch({ settings: { features: { site_permissions: { "127.0.0.3": { autoplay: "block" } } } } });
      const other = await startServer("127.0.0.3");
      try {
        // A page you haven't touched: now and then the engine starts one as
        // if you had (navigator.userActivation), and then it may play.
        let quiet = null;
        for (let i = 0; i < 4; i++) {
          quiet = (await open(k, `${other.origin}/page/Quiet?fresh=${i}`)).page;
          if (!(await quiet.evaluate(`navigator.userActivation.hasBeenActive`))) break;
        }
        assert.equal(await quiet.evaluate(`navigator.userActivation.hasBeenActive`), false, "a page you haven't touched");
        assert.equal(await quiet.evaluate(`new Audio('/tone.wav').play().then(() => 'played', (e) => e.name + ': ' + e.message)`), "NotAllowedError: Sound playing on its own is turned off for this site", "turned down");
        assert(!(await k.targets()).some((t) => t.url.includes("permission.html")), "without asking");
        // After a click on the page, it's yours: it plays.
        assert.equal(await quiet.evaluate(`new Audio('/tone.wav').play().then(() => 'played', (e) => e.name)`, { userGesture: true }), "played", "after you've clicked");
        // Another site: the engine's usual rule (a click is enough).
        const { page } = await open(k, `${site.origin}/page/Plays`);
        assert.equal(await page.evaluate(`new Audio('/tone.wav').play().then(() => 'played', (e) => e.name)`, { userGesture: true }), "played", "elsewhere");
      } finally {
        await other.close();
      }
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
