// Privacy (privacy.rs): the cookie viewer/editor and each site's cookie rule,
// other sites' cookies in a page, clearing a site's data and clearing on exit,
// the privacy headers, the user agent, the time zone and private windows.

import { startServer } from "../lib/server.mjs";
import { waitFor } from "../lib/kessel.mjs";

// The page's request headers, as the server saw them (again, if the page
// was still settling in).
const headersOf = (page, url) => waitFor(() => page.evaluate(`fetch(${JSON.stringify(url)}, { cache: "no-store" }).then((r) => r.json())`), { message: `the headers of ${url}` });

// A frame of another site inside the page: its own DevTools target.
async function frameOf(k, origin) {
  const target = await (async () => {
    for (let i = 0; i < 100; i++) {
      const all = await (await fetch(`http://127.0.0.1:${k.port}/json/list`)).json();
      const frame = all.find((t) => t.type === "iframe" && t.url.startsWith(origin));
      if (frame) return frame;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no frame of ${origin}`);
  })();
  const frame = await k.attach(target);
  await frame.waitFor(`document.readyState === "complete"`);
  return frame;
}

// The DevTools list shows a tab's new address a moment before its old page
// is gone: wait for the new page itself.
const loaded = (page, url) => page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await loaded(page, url);
  return { tab, page };
}

const cookiesOf = (k, site) => k.invoke("get_cookies", { site });

export const tests = [
  {
    name: "the cookie viewer lists, edits, renames and deletes a site's cookies",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/page/Cookies`);
      await page.evaluate(`document.cookie = "kessel_a=1; max-age=3600; path=/"`);
      // A page script's cookie reaches the jar a moment later.
      const c = await waitFor(async () => (await cookiesOf(k, "127.0.0.2")).find((x) => x.name === "kessel_a"), { message: "the page's cookie is listed" });
      assert(c && c.value === "1" && c.expires > Date.now() / 1000, "the page's cookie is listed, with when it expires");
      const key = { name: c.name, domain: c.domain, path: c.path };

      await k.invoke("save_cookie", { cookie: { ...c, value: "2" }, original: key });
      await page.waitFor(`document.cookie.includes("kessel_a=2")`, { message: "the page sees the edited value" });
      await k.invoke("save_cookie", { cookie: { ...c, name: "kessel_b", value: "3", expires: null }, original: { ...key } });
      await page.waitFor(`document.cookie.includes("kessel_b=3") && !document.cookie.includes("kessel_a")`, { message: "renamed" });
      const [b] = (await cookiesOf(k, "127.0.0.2")).filter((x) => x.name === "kessel_b");
      assert.equal(b.expires, null, "saved without an end date: until Kessel closes");

      await k.invoke("delete_cookies", { cookies: [{ name: "kessel_b", domain: b.domain, path: b.path }] });
      await page.waitFor(`!document.cookie.includes("kessel_b")`, { message: "deleted" });
    },
  },
  {
    name: "a blocked site keeps no cookies and its pages get no document.cookie",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await k.invoke("set_cookie_rule", { site: "127.0.0.2", rule: "block" });
      // A tab opened after the rule: its pages know it from the start.
      await k.createTab(`${site.origin}/set-cookie/server_c`);
      const page = await k.page(`${site.origin}/set-cookie/server_c`);
      await loaded(page, `${site.origin}/set-cookie/server_c`);
      assert.equal(await page.evaluate(`document.cookie = "js_c=1"; document.cookie`), "", "document.cookie is empty and ignores writes");
      await waitFor(async () => (await cookiesOf(k, "127.0.0.2")).length === 0, { message: "the cookie the server set is swept away" });
    },
  },
  {
    name: "a site kept until Kessel closes, and the longest any cookie may live",
    async run({ launch, site, assert, waitFor }) {
      const other = await startServer("127.0.0.3");
      try {
        const k = await launch({ settings: { cookie_max_days: 1 } });
        await k.invoke("set_cookie_rule", { site: "127.0.0.2", rule: "session" });
        await open(k, `${site.origin}/set-cookie/session_c`);
        await waitFor(async () => (await cookiesOf(k, "127.0.0.2")).some((c) => c.name === "session_c" && c.expires === null), { message: "the persistent cookie became a session one" });
        const long = await open(k, `${other.origin}/page/Long`);
        await long.page.evaluate(`document.cookie = "long_c=1; max-age=2592000; path=/"`);
        await waitFor(async () => (await cookiesOf(k, "127.0.0.3")).some((c) => c.name === "long_c" && c.expires !== null && c.expires < Date.now() / 1000 + 86400 + 120), {
          message: "another site's 30-day cookie is cut to a day",
        });
      } finally {
        await other.close();
      }
    },
  },
  {
    name: "clearing a site's data takes its cookies and storage",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { tab, page } = await open(k, `${site.origin}/page/Data`);
      await page.evaluate(`localStorage.setItem("kept", "yes"); document.cookie = "data_c=1; max-age=3600; path=/"`);
      await waitFor(async () => (await cookiesOf(k, "127.0.0.2")).some((x) => x.name === "data_c"), { message: "the cookie is in the jar" });
      const n = await k.invoke("clear_site_data", { site: "127.0.0.2" });
      assert(n >= 1, "its cookie was deleted");
      await k.invoke("reload", { id: tab.id });
      await waitFor(async () => await page.evaluate(`localStorage.getItem("kept") === null && !document.cookie.includes("data_c")`).catch(() => false), { message: "storage and cookies are gone" });
    },
  },
  {
    name: "other sites' cookies in a page are refused -- partitioned ones work -- unless switched off",
    async run({ launch, site, assert }) {
      const other = await startServer("127.0.0.3");
      try {
        const write = `document.cookie = "t=1; SameSite=None; Secure"; document.cookie = "p=1; SameSite=None; Secure; Partitioned"; document.cookie`;
        const embed = `${site.origin}/embed?src=${encodeURIComponent(`${other.origin}/page/inner`)}`;
        const k = await launch();
        await open(k, embed);
        assert.equal(await (await frameOf(k, other.origin)).evaluate(write), "p=1", "only the partitioned cookie is kept");
        await k.close();

        const allowed = await launch({ settings: { block_third_party_cookies: false } });
        await open(allowed, embed);
        assert((await (await frameOf(allowed, other.origin)).evaluate(write)).includes("t=1"), "with the switch off, the frame keeps its cookie");
      } finally {
        await other.close();
      }
    },
  },
  {
    name: "Global Privacy Control and Do Not Track, in requests and to scripts -- Shields on or off",
    async run({ launch, site, assert }) {
      const k = await launch({ settings: { adblock_enabled: false, send_dnt: true } });
      const { page } = await open(k, `${site.origin}/page/Headers`);
      const headers = await headersOf(page, `${site.origin}/echo-headers`);
      assert.equal(headers["sec-gpc"], "1", "Sec-GPC is sent");
      assert.equal(headers.dnt, "1", "DNT is sent");
      assert.equal(await page.evaluate(`navigator.globalPrivacyControl === true && navigator.doNotTrack === "1"`), true, "scripts see both");
    },
  },
  {
    name: "the referrer policy keeps the page you came from away from other sites",
    async run({ launch, site, assert }) {
      const other = await startServer("127.0.0.3");
      try {
        const k = await launch();
        const { page } = await open(k, `${site.origin}/page/Referrer`);
        assert((await headersOf(page, `${other.origin}/echo-headers`)).referer, "by default another site sees where you came from (the site)");
        // Pages opened from now on.
        const settings = await k.invoke("get_settings");
        await k.invoke("update_settings", { settings: { ...settings, referrer_policy: "same-site" } });
        await k.createTab(`${site.origin}/page/SameSite`);
        const strict = await k.page(`${site.origin}/page/SameSite`);
        await loaded(strict, `${site.origin}/page/SameSite`);
        assert.equal((await headersOf(strict, `${other.origin}/echo-headers`)).referer, undefined, "same-site: not to another site");
        assert((await headersOf(strict, `${site.origin}/echo-headers`)).referer, "same-site: still to the site itself");
        await strict.evaluate(`location.href = ${JSON.stringify(`${other.origin}/page/Arrived`)}`);
        const arrived = await k.page(`${other.origin}/page/Arrived`);
        await loaded(arrived, `${other.origin}/page/Arrived`);
        assert.equal(await arrived.evaluate(`document.referrer`), "", "the next site doesn't learn where you came from");
        await k.invoke("update_settings", { settings: { ...settings, referrer_policy: "none" } });
        await k.createTab(`${site.origin}/page/None`);
        const none = await k.page(`${site.origin}/page/None`);
        await loaded(none, `${site.origin}/page/None`);
        assert.equal((await headersOf(none, `${site.origin}/echo-headers`)).referer, undefined, "none: to nobody");
      } finally {
        await other.close();
      }
    },
  },
  {
    name: "the user agent and time zone protections",
    async run({ launch, site, assert }) {
      const other = await startServer("127.0.0.3");
      try {
        const k = await launch({ settings: { user_agent: "chrome", fp_timezone: true } });
        const { page } = await open(k, `${site.origin}/embed?src=${encodeURIComponent(`${other.origin}/page/inner`)}`);
        const ua = await page.evaluate(`navigator.userAgent`);
        assert(ua.includes("Chrome/") && !ua.includes("Edg/"), `looks like Chrome: ${ua}`);
        const zone = `Intl.DateTimeFormat().resolvedOptions().timeZone + "|" + new Date().getTimezoneOffset()`;
        assert.equal(await page.evaluate(zone), "UTC|0", "the page reads UTC");
        assert.equal(await (await frameOf(k, other.origin)).evaluate(zone), "UTC|0", "another site's frame reads UTC too");
      } finally {
        await other.close();
      }
    },
  },
  {
    name: "always-private windows",
    async run({ launch, assert }) {
      const k = await launch({ settings: { always_private: true } });
      const [window] = await k.toolbars();
      assert(window.private, "the first window is a private one");
    },
  },
  {
    name: "cookies and history are cleared when Kessel quits",
    async run({ launch, site, assert, waitFor, sleep }) {
      let k = await launch({ settings: { clear_on_exit: ["cookies", "history"] }, keepProfile: true });
      await open(k, `${site.origin}/set-cookie/exit_c`);
      await waitFor(async () => (await cookiesOf(k, "127.0.0.2")).some((c) => c.name === "exit_c"), { message: "the cookie is there" });
      const profileDir = k.profileDir;
      // Quit as the menu does; the call itself never answers.
      k.invoke("quit_app").catch(() => {});
      await waitFor(() => k.child.exitCode !== null, { timeout: 30000, message: "Kessel quits by itself once it's cleared" }).catch((e) => {
        throw new Error(`${e.message}\n${k.logs.join("").slice(-3000)}`);
      });
      await k.close({ keepProfile: true });
      await sleep(1000);
      k = await launch({ profileDir });
      try {
        assert.equal((await cookiesOf(k, "127.0.0.2")).length, 0, "no cookies left");
        assert.equal((await k.invoke("get_history")).length, 0, "no history left");
      } finally {
        await k.close({ keepProfile: false });
      }
    },
  },
];
