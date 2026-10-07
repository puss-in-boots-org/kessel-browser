// The browser lock (browser_lock.rs, lock.html, Settings -> Security): a
// PIN or password over every window, the pages hidden and out of reach
// behind it; on start, after the PC's left alone, private windows only.

import { sleep } from "../lib/kessel.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`document.readyState === "complete"`);
  return { id: tab.id, page };
}

const lockPages = async (k) => (await k.targets()).filter((t) => t.url.includes("lock.html"));

async function enter(lock, secret) {
  await lock.waitFor(`document.body.dataset.ready === '1'`, { message: "the lock page ready" });
  await lock.evaluate(`(() => { document.getElementById('error').textContent = ''; document.getElementById('secret').value = ${JSON.stringify(secret)}; document.getElementById('form').requestSubmit(); })()`);
}

const setFeatures = async (k, patch) => {
  const s = await k.invoke("get_settings");
  await k.invoke("update_settings", { settings: { ...s, features: { ...s.features, ...patch } } });
};

// `promise` fails, with a message matching `pattern`.
async function rejects(promise, pattern, message) {
  try {
    await promise;
  } catch (e) {
    if (!pattern.test(String(e.message || e))) throw new Error(`assertion failed: ${message}: ${e.message || e}`);
    return;
  }
  throw new Error(`assertion failed: ${message}: it didn't fail`);
}

export const tests = [
  {
    name: "a PIN locks every window: the lock page over it, the pages hidden and out of reach; wrong is refused, right unlocks",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/page/Secret`);
      await rejects(k.invoke("lock_browser"), /Set a PIN or password/, "nothing to unlock with yet: no lock");
      await k.invoke("set_browser_lock", { kind: "pin", secret: "2468", current: null });
      await k.invoke("lock_browser");
      const lock = await k.page((t) => t.url.includes("lock.html"));
      await lock.waitFor(`document.getElementById('what').textContent === 'Enter your PIN to carry on.'`, { message: "asks for the PIN" });
      await page.waitFor(`document.visibilityState === 'hidden'`, { message: "the page hidden from the engine" });
      assert.equal((await k.invoke("lock_status")).locked, true, "locked");

      // Shortcuts do nothing.
      const before = (await k.tabs()).length;
      await k.press("Ctrl+T");
      await sleep(600);
      assert.equal((await k.tabs()).length, before, "no new tab");

      await enter(lock, "1111");
      await lock.waitFor(`/Wrong/.test(document.getElementById('error').textContent)`, { message: "wrong: refused" });
      assert.equal((await k.invoke("lock_status")).locked, true, "still locked");
      await enter(lock, "2468");
      await waitFor(async () => (await lockPages(k)).length === 0, { message: "the lock page gone" });
      await page.waitFor(`document.visibilityState === 'visible'`, { message: "the page back" });
      assert.equal((await k.invoke("lock_status")).locked, false, "unlocked");
    },
  },
  {
    name: "five wrong tries in a row: a wait before the next",
    async run({ launch, assert }) {
      const k = await launch();
      await k.invoke("set_browser_lock", { kind: "password", secret: "open sesame", current: null });
      await k.invoke("lock_browser");
      const lock = await k.page((t) => t.url.includes("lock.html"));
      for (let i = 0; i < 5; i++) {
        await enter(lock, `nope ${i}`);
        await lock.waitFor(`/Wrong/.test(document.getElementById('error').textContent)`, { message: `try ${i + 1} refused` });
      }
      await enter(lock, "open sesame");
      await lock.waitFor(`/wait/.test(document.getElementById('error').textContent)`, { message: "even the right one waits" });
      assert((await k.invoke("lock_status")).wait > 20, "for half a minute");
      assert.equal((await k.invoke("lock_status")).locked, true, "still locked");
    },
  },
  {
    name: "locked when Kessel starts (a password); changing it takes the current one",
    async run({ launch, site, assert, waitFor }) {
      const first = await launch({ keepProfile: true });
      await first.invoke("set_browser_lock", { kind: "password", secret: "correct horse", current: null });
      await rejects(first.invoke("set_browser_lock", { kind: "pin", secret: "1234", current: "wrong" }), /isn't your current password/, "not without the current one");
      await setFeatures(first, { lock: { on_start: true } });
      await first.close({ keepProfile: true });

      const k = await launch({ profileDir: first.profileDir });
      const lock = await k.page((t) => t.url.includes("lock.html"), { timeout: 15000 });
      await lock.waitFor(`document.getElementById('what').textContent === 'Enter your password to carry on.'`, { message: "asks for the password" });
      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url: `${site.origin}/page/Behind` });
      const page = await k.page((t) => t.url === `${site.origin}/page/Behind`);
      await page.waitFor(`document.readyState === 'complete'`);
      assert.equal(await page.evaluate(`document.visibilityState`), "hidden", "a page that loads meanwhile stays hidden");
      await enter(lock, "correct horse");
      await waitFor(async () => (await lockPages(k)).length === 0, { message: "unlocked" });
      await page.waitFor(`document.visibilityState === 'visible'`, { message: "and shown" });
    },
  },
  {
    name: "private windows only: the private window locks, the others stay as they are",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/page/Ordinary`);
      await k.invoke("set_browser_lock", { kind: "pin", secret: "8642", current: null });
      await setFeatures(k, { lock: { scope: "private" } });
      const url = `${site.origin}/page/Hidden`;
      await k.invoke("new_window", { private: true, url });
      const secret = await k.page((t) => t.url === url);
      await secret.waitFor(`document.readyState === 'complete'`);
      await k.invoke("lock_browser");
      await waitFor(async () => (await lockPages(k)).length === 1, { message: "one lock page" });
      await secret.waitFor(`document.visibilityState === 'hidden'`, { message: "the private page hidden" });
      assert.equal(await page.evaluate(`document.visibilityState`), "visible", "the ordinary one isn't");
      const lock = await k.page((t) => t.url.includes("lock.html"));
      await enter(lock, "8642");
      await waitFor(async () => (await lockPages(k)).length === 0, { message: "unlocked" });
    },
  },
  {
    name: "the PC left alone long enough: Kessel locks by itself",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      await k.invoke("set_browser_lock", { kind: "pin", secret: "1357", current: null });
      await setFeatures(k, { lock: { idle_minutes: 1 } });
      await k.invoke("test_set_idle", { seconds: 30 });
      await sleep(6000);
      assert.equal((await lockPages(k)).length, 0, "not after half a minute");
      await k.invoke("test_set_idle", { seconds: 65 });
      await waitFor(async () => (await lockPages(k)).length === 1, { message: "locked after a minute", timeout: 10000 });
      await k.invoke("test_set_idle", { seconds: 0 });
    },
  },
  {
    name: "Settings -> Security: set a PIN, change it, turn the lock off; Windows Hello only when it's on",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      await k.invoke("open_singleton_tab", { route: "kessel://settings/security" });
      const settings = await k.page((t) => t.url.includes("settings.html"));
      await settings.waitFor(`!!document.querySelector('#lock-actions [data-kind="pin"]')`, { message: "the lock card" });
      const fill = (current, next) =>
        settings.evaluate(`(() => { const v = (id, x) => (document.getElementById(id).value = x); v('lock-current', ${JSON.stringify(current)}); v('lock-new', ${JSON.stringify(next)}); v('lock-repeat', ${JSON.stringify(next)}); document.getElementById('lock-save').click(); })()`);
      await settings.evaluate(`document.querySelector('#lock-actions [data-kind="pin"]').click()`);
      await fill("", "4826");
      await waitFor(async () => (await k.invoke("lock_status")).kind === "pin", { message: "a PIN set" });
      await settings.waitFor(`!document.getElementById('lock-more').hidden`, { message: "the rest of the card" });

      await settings.evaluate(`document.querySelector('#lock-actions [data-kind="pin"]').click()`);
      await fill("0000", "9999");
      await settings.waitFor(`/isn't your current PIN/.test(document.getElementById('lock-error').textContent)`, { message: "the current one is needed" });
      await settings.evaluate(`document.querySelector('#lock-actions [data-kind="none"]').click()`);
      await fill("4826", "");
      await waitFor(async () => !(await k.invoke("lock_status")).configured, { message: "turned off" });

      assert.equal(typeof (await k.invoke("hello_available")), "boolean", "Windows says whether Hello is set up");
      await rejects(k.invoke("unlock_with_hello"), /isn't on/, "not unless it's turned on");
    },
  },
];
