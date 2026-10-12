// Sites' notifications, shown by Kessel (notifications.rs, notify.html):
// a card per site in the corner, stacking; the same tag replaces; a click
// brings the tab up and the site hears it; the history keeps them; turned
// off, no card -- but still in the history.

async function notifyingPage(k, site) {
  const [tab] = await k.tabs();
  const url = `${site.origin}/page/Notifier`;
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`document.readyState === "complete"`);
  return { tab, page };
}

// (Right after a page loads, its context can be a moment away.)
async function evaluate(page, expression, options) {
  for (let i = 0; ; i++) {
    try {
      return await page.evaluate(expression, options);
    } catch (e) {
      if (i >= 20 || !/execution context/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

const notify = (page, title, opts = {}) =>
  evaluate(page, `(() => {
    const n = new Notification(${JSON.stringify(title)}, ${JSON.stringify(opts)});
    window.heard = window.heard || [];
    n.onshow = () => window.heard.push("show:" + n.title);
    n.onclick = () => window.heard.push("click:" + n.title);
    n.onclose = () => window.heard.push("close:" + n.title);
    return true;
  })()`);

export const tests = [
  {
    name: "a site's notifications: Kessel's own cards, stacked per site, the same tag replacing; a click brings the tab up and the site hears it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { features: { site_permissions: { "127.0.0.2": { notifications: "allow" } } } } });
      const { tab, page } = await notifyingPage(k, site);
      assert.equal(await evaluate(page, `Notification.requestPermission()`, { userGesture: true }), "granted");
      // Another tab in front: the notifications come from a tab behind it.
      await k.createTab(`${site.origin}/page/Elsewhere`);
      await waitFor(async () => (await k.activeTab()).id !== tab.id, { message: "another tab in front" });
      await notify(page, "Hello", { body: "World", tag: "a" });
      const cards = await k.page((t) => t.url.includes("notify.html"), { timeout: 15000 });
      const shown = () => evaluate(cards, `window.__kesselNotify ? window.__kesselNotify.cards() : []`);
      await waitFor(async () => (await shown()).some((c) => c.site === "127.0.0.2" && c.title === "Hello" && c.body === "World"), { message: "its card" });
      await page.waitFor(`(window.heard || []).includes("show:Hello")`, { message: "the site hears it was shown" });

      await notify(page, "Second", { body: "Two" });
      await waitFor(async () => (await shown()).some((c) => c.title === "Second" && c.count === 2), { message: "stacked on the site's card" });
      await notify(page, "Hello again", { body: "Same tag", tag: "a" });
      await waitFor(async () => (await shown()).some((c) => c.title === "Hello again" && c.count === 2), { message: "the same tag replaced the first" });
      await page.waitFor(`window.heard.includes("close:Hello")`, { message: "the replaced one closed" });

      const history = await k.invoke("notification_history");
      assert.deepEqual(history.slice(0, 3).map((n) => n.title), ["Hello again", "Second", "Hello"], "kept, newest first");

      // The card's click brings its tab back. (Before it goes by itself.)
      await cards.evaluate(`window.__kesselNotify.click("127.0.0.2")`);
      await page.waitFor(`window.heard.includes("click:Hello again")`, { message: "the site hears the click" }).catch(async (e) => {
        throw new Error(`${e.message}; heard ${await evaluate(page, "JSON.stringify(window.heard)")}; active ${(await k.activeTab()).id} (tab ${tab.id}); cards ${JSON.stringify(await shown())}`);
      });
      await waitFor(async () => (await k.activeTab()).id === tab.id, { message: "its tab in front" });
      await waitFor(async () => (await shown()).length === 0, { message: "the card gone" });
    },
  },
  {
    name: "notifications turned off: no card, but still in the history",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { features: { site_permissions: { "127.0.0.2": { notifications: "allow" } }, notifications: { show: false } } } });
      const { page } = await notifyingPage(k, site);
      await evaluate(page, `Notification.requestPermission()`, { userGesture: true });
      await notify(page, "Quiet", { body: "Shh" });
      await waitFor(async () => (await k.invoke("notification_history")).some((n) => n.title === "Quiet"), { message: "in the history" });
      await new Promise((r) => setTimeout(r, 800));
      assert(!(await k.targets()).some((t) => t.url.includes("notify.html")), "no cards window");
    },
  },
];
