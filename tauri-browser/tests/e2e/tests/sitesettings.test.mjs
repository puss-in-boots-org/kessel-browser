// Site settings (permissions.rs CONTENT): what a site's pages may do --
// JavaScript, images, other sites' content, pop-ups without a click,
// sending you to another site on their own, sound, full screen -- set per
// site from the lock's popup or Settings -> Site permissions.

import { startServer } from "../lib/server.mjs";

// Tab `id` (default: the one you're on) at `url`, loaded.
async function open(k, url, id = null) {
  id = id ?? (await k.activeTab()).id;
  await k.invoke("navigate", { id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id, page };
}

const set = (k, url, kind, value) => k.invoke("set_site_setting", { url, kind, value });
// An image that loaded is 1x1; one that was refused, 0.
const loaded = (page, sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).naturalWidth`);

async function withOther(run) {
  const other = await startServer("127.0.0.3");
  try {
    return await run(other);
  } finally {
    await other.close();
  }
}

export const tests = [
  {
    name: "images, and other sites' content, blocked for one site only",
    async run({ launch, site, assert }) {
      await withOther(async (other) => {
        const k = await launch();
        const url = `${site.origin}/content/Pictures?other=${encodeURIComponent(other.origin)}`;
        let { page } = await open(k, url);
        await page.waitFor(`document.getElementById('own').complete && document.getElementById('other').complete`);
        assert.deepEqual([await loaded(page, "#own"), await loaded(page, "#other")], [1, 1], "both images, to begin with");

        await set(k, url, "images", "block");
        ({ page } = await open(k, `${url}&again=1`));
        await page.waitFor(`document.getElementById('own').complete && document.getElementById('other').complete`);
        assert.deepEqual([await loaded(page, "#own"), await loaded(page, "#other")], [0, 0], "no images on the site");
        assert.equal(await page.evaluate(`document.querySelector('h1').textContent`), "Pictures", "the page itself loads");

        await set(k, url, "images", "default");
        await set(k, url, "third_party", "block");
        ({ page } = await open(k, `${url}&third=1`));
        await page.waitFor(`document.getElementById('own').complete && document.getElementById('other').complete`);
        assert.deepEqual([await loaded(page, "#own"), await loaded(page, "#other")], [1, 0], "its own image, not the other site's");

        // Another site isn't touched by this one's settings.
        const elsewhere = `${other.origin}/content/Elsewhere?other=${encodeURIComponent(site.origin)}`;
        ({ page } = await open(k, elsewhere));
        await page.waitFor(`document.getElementById('own').complete && document.getElementById('other').complete`);
        assert.deepEqual([await loaded(page, "#own"), await loaded(page, "#other")], [1, 1], "the other site shows everything");
      });
    },
  },
  {
    name: "JavaScript turned off for a site: its pages' scripts don't run, other sites' do",
    async run({ launch, site, assert, waitFor }) {
      await withOther(async (other) => {
        const k = await launch();
        const url = `${site.origin}/content/Scripts`;
        await set(k, url, "javascript", "block");
        const { id } = await k.activeTab();
        await k.invoke("navigate", { id, url });
        await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.title === "Scripts", { message: "the page loaded" });
        const page = await k.page((t) => t.url === url);
        let ran = null;
        try {
          ran = await page.evaluate(`document.documentElement.dataset.js || null`);
        } catch {
          ran = null; // no script at all may run in it
        }
        assert.equal(ran, null, "its script didn't run");

        const { page: otherPage } = await open(k, `${other.origin}/content/OtherScripts`);
        assert.equal(await otherPage.evaluate(`document.documentElement.dataset.js`), "ran", "another site's did");

        await set(k, url, "javascript", "default");
        const { page: back } = await open(k, `${url}?again`);
        assert.equal(await back.evaluate(`document.documentElement.dataset.js`), "ran", "back on");
      });
    },
  },
  {
    name: "a pop-up without a click is blocked with a chip in the address bar -- and opens as a tab on a site you allow",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const url = `${site.origin}/page/Popups`;
      // A page you haven't touched: now and then the engine starts one as if
      // you had (navigator.userActivation), and its pop-ups count as clicked.
      let page = null;
      for (let i = 0; i < 4; i++) {
        page = (await open(k, i ? `${url}?fresh=${i}` : url)).page;
        if (!(await page.evaluate(`navigator.userActivation.hasBeenActive`))) break;
      }
      assert.equal(await page.evaluate(`navigator.userActivation.hasBeenActive`), false, "a page you haven't touched");
      const toolbar = await k.toolbar();
      const before = (await k.tabs()).length;
      await page.evaluate(`setTimeout(() => window.open('/page/Unwanted'), 10)`);
      await toolbar.waitFor(`!document.getElementById('blocked-btn').hidden && /Pop-up blocked/.test(document.getElementById('blocked-btn').textContent)`, { message: "the chip" });
      assert.equal((await k.tabs()).length, before, "no tab opened");

      await set(k, url, "popups", "allow");
      await sleep(300);
      await page.evaluate(`setTimeout(() => window.open('/page/Wanted'), 10)`);
      await waitFor(async () => (await k.tabs()).some((t) => t.url.endsWith("/page/Wanted")), { message: "the pop-up, as a tab" });
      assert(!(await k.tabs()).some((t) => t.url.endsWith("/page/Unwanted")), "the blocked one stayed blocked");
    },
  },
  {
    name: "a page sending you to another site on its own is stopped on a site you said so -- a click still goes",
    async run({ launch, site, assert, waitFor, sleep }) {
      await withOther(async (other) => {
        const k = await launch();
        const toolbar = await k.toolbar();
        // Allowed (the default): it goes.
        let { id, page } = await open(k, `${site.origin}/page/Redirecting`);
        await page.evaluate(`location.href = '${other.origin}/page/Away'`);
        await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.url === `${other.origin}/page/Away`, { message: "sent on" });

        await set(k, `${site.origin}/`, "redirects", "block");
        ({ id, page } = await open(k, `${site.origin}/page/Stays`));
        await page.evaluate(`setTimeout(() => { location.href = '${other.origin}/page/NotAllowed'; }, 10)`);
        await toolbar.waitFor(`!document.getElementById('blocked-btn').hidden && /Redirect blocked/.test(document.getElementById('blocked-btn').textContent)`, { message: "the chip" });
        await sleep(500);
        assert.equal((await k.tabs()).find((t) => t.id === id).url, `${site.origin}/page/Stays`, "still on the page");

        // A link you click still goes there.
        await page.evaluate(`(() => { const a = document.createElement('a'); a.id = 'go'; a.href = '${other.origin}/page/Clicked'; a.textContent = 'go'; a.style.cssText = 'position:fixed;left:10px;top:10px;width:120px;height:40px;display:block;background:#ddd;z-index:9'; document.body.appendChild(a); })()`);
        await page.clickSelector("#go");
        await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.url === `${other.origin}/page/Clicked`, { message: "the clicked link went" });
        await toolbar.waitFor(`document.getElementById('blocked-btn').hidden`, { message: "the chip gone with the page" });
      });
    },
  },
  {
    name: "sound off for a site mutes its tabs, and leaving the site unmutes them",
    async run({ launch, site, waitFor }) {
      await withOther(async (other) => {
        const k = await launch();
        const url = `${site.origin}/sound/Quiet`;
        await set(k, url, "sound", "block");
        const { id } = await open(k, url);
        await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.muted, { message: "muted" });
        await open(k, `${other.origin}/page/Loud`, id);
        await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.muted === false, { message: "unmuted on another site" });
      });
    },
  },
  {
    name: "full screen turned off for a site: the page's request is turned down",
    async run({ launch, site, assert, sleep }) {
      const k = await launch();
      const url = `${site.origin}/page/NoFullScreen`;
      await set(k, url, "fullscreen", "block");
      const { page } = await open(k, url);
      await sleep(300);
      const answer = await page.evaluate(`document.getElementById('p0').requestFullscreen().then(() => 'full', (e) => e.name + ': ' + e.message)`, { userGesture: true });
      assert(/TypeError: Full screen is turned off/.test(answer), `turned down (${answer})`);
      assert.equal(await page.evaluate(`!!document.fullscreenElement`), false, "nothing in full screen");
      const toolbar = await k.toolbar();
      assert.equal(await toolbar.evaluate(`document.documentElement.classList.contains('fullscreen')`), false, "the window either");
    },
  },
  {
    name: "the lock's popup has the site's settings, and Settings lists them for every site",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const url = `${site.origin}/page/Settings`;
      const { id } = await open(k, url);
      await k.invoke("toggle_popup", { kind: "siteinfo", x: 100, y: 80, width: 320, height: 540, init: { tab: id, url } });
      const popup = await k.page((t) => t.url.includes("siteinfo.html"));
      await popup.waitFor(`document.querySelectorAll('#site-settings label').length === 7`, { message: "seven site settings" });
      assert.deepEqual(
        await popup.evaluate(`[...document.querySelectorAll('#site-settings label')].map((l) => [l.dataset.kind, l.querySelector('input').checked])`),
        [["javascript", true], ["images", true], ["popups", false], ["redirects", true], ["sound", true], ["third_party", true], ["fullscreen", true]],
        "as they are by default (pop-ups without a click blocked)"
      );
      await popup.evaluate(`document.querySelector('#site-settings label[data-kind=images] input').click()`);
      await waitFor(async () => (await k.invoke("get_settings")).features?.site_permissions?.["127.0.0.2"]?.images === "block", { message: "kept for the site" });
      await popup.waitFor(`document.querySelector('#site-settings label[data-kind=images]').classList.contains('own')`, { message: "shown as the site's own" });

      await k.invoke("open_singleton_tab", { route: "kessel://settings/permissions" });
      const settings = await k.page((t) => t.url.includes("settings.html"));
      await settings.waitFor(`document.querySelectorAll('#perm-content select').length === 7`, { message: "the site content defaults" });
      await settings.waitFor(`/127\\.0\\.0\\.2/.test(document.getElementById('perm-sites').innerText) && /Images/.test(document.getElementById('perm-sites').innerText)`, { message: "the site, with its images setting" });
    },
  },
];
