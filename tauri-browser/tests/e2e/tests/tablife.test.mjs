// A tab's life in the background: hidden (throttled) as soon as you leave
// it, paused after a while, asleep after longer, no more than so many awake;
// what hover cards show about it; its memory use; the dot when it changes;
// and "Keep tabs when Kessel closes" in Settings -> Tabs.

async function openTabs(k, site, waitFor, names) {
  for (const name of names) await k.createTab(`${site.origin}/page/${name}`);
  return waitFor(async () => {
    const tabs = await k.tabs();
    const found = names.map((n) => tabs.find((t) => t.url.endsWith(`/page/${n}`) && t.title === n));
    return found.every(Boolean) && found;
  }, { message: `tabs ${names.join(", ")}` });
}

const setSettings = async (k, patch) => k.invoke("update_settings", { settings: { ...(await k.invoke("get_settings")), ...patch } });

export const tests = [
  {
    name: "a tab you leave is hidden (throttled) and shown again when you come back",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const [one] = await openTabs(k, site, waitFor, ["One"]);
      const page = await k.page(`${site.origin}/page/One`);
      assert.equal(await page.evaluate(`document.visibilityState`), "visible", "visible while you're on it");
      await openTabs(k, site, waitFor, ["Two"]);
      await page.waitFor(`document.visibilityState === 'hidden'`, { message: "hidden once you left it" });
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.activateTab(${one.id})`);
      await page.waitFor(`document.visibilityState === 'visible' && document.hasFocus()`, { message: "visible and focused again" });
    },
  },
  {
    name: "background tabs are paused after a while, put to sleep after longer, and at most N stay awake",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { freeze_tabs_after_minutes: 5, discard_tabs_after_minutes: 30, max_awake_tabs: 0 } });
      const [a, b, c] = await openTabs(k, site, waitFor, ["A", "B", "C", "D"]);
      const toolbar = await k.toolbar();
      const tab = async (id) => (await k.tabs()).find((t) => t.id === id);

      // Paused: A has been in the background for 6 minutes.
      await toolbar.evaluate(`window.__kesselTest.age(${a.id}, 6)`);
      await toolbar.evaluate(`window.__kesselTest.tick()`);
      await waitFor(async () => (await tab(a.id)).frozen, { message: "A paused" });
      assert(!(await tab(b.id)).frozen, "B (recent) isn't");
      // Coming back to it resumes it.
      await toolbar.evaluate(`window.__kesselTest.activateTab(${a.id})`);
      const pageA = await k.page(`${site.origin}/page/A`);
      assert.equal(await pageA.evaluate(`1 + 1`), 2, "its page runs again");
      assert(!(await tab(a.id)).frozen, "not paused any more");

      // Asleep: B idle for 40 minutes.
      await toolbar.evaluate(`window.__kesselTest.age(${b.id}, 40)`);
      await toolbar.evaluate(`window.__kesselTest.tick()`);
      await waitFor(async () => (await tab(b.id)).discarded, { message: "B asleep" });

      // A site listed as never to sleep doesn't.
      await setSettings(k, { never_sleep_sites: ["127.0.0.2"] });
      await toolbar.evaluate(`window.__kesselTest.age(${c.id}, 40)`);
      await toolbar.evaluate(`window.__kesselTest.tick()`);
      await new Promise((r) => setTimeout(r, 500));
      assert(!(await tab(c.id)).discarded, "C (a never-sleep site) stays awake");

      // At most 2 awake: the ones looked at longest ago go to sleep.
      await setSettings(k, { never_sleep_sites: [], max_awake_tabs: 2 });
      await toolbar.evaluate(`window.__kesselTest.tick()`);
      await waitFor(async () => (await k.tabs()).filter((t) => !t.discarded).length === 2, { message: "only 2 awake" });
      assert(!(await tab(a.id)).discarded, "the tab you're on stays awake");
    },
  },
  {
    name: "hover cards show the tab's title, site, state, memory and a preview",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      // Looked at for a moment before moving on, as anyone does.
      const [one] = await openTabs(k, site, waitFor, ["Hovered"]);
      await new Promise((r) => setTimeout(r, 1500));
      const [two] = await openTabs(k, site, waitFor, ["Other"]);
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.pollResources()`);
      await toolbar.evaluate(`window.__kesselTest.hover(${one.id})`);
      const card = await k.page((t) => t.url.includes("/hovercard.html"));
      await card.waitFor(`document.getElementById('title').textContent === 'Hovered'`, { message: "the card shows the title" });
      assert.equal(await card.evaluate(`document.getElementById('host').textContent`), "127.0.0.2", "and the site");
      await card.waitFor(`/Memory: \\d/.test(document.getElementById('memory').textContent)`, { message: "memory use" });
      await card.waitFor(`!!document.querySelector('#preview img')`, { message: "a preview of the page (taken when it was left)" });
      // The next tab's card reuses the same popup.
      await toolbar.evaluate(`window.__kesselTest.hover(${two.id})`);
      await card.waitFor(`document.getElementById('title').textContent === 'Other'`, { message: "the next tab" });
      assert.equal((await k.targets()).filter((t) => t.url.includes("/hovercard.html")).length, 1, "one card");
      await toolbar.evaluate(`window.__kesselTest.unhover()`);
      const mem = (await k.tabs()).find((t) => t.id === one.id).memory;
      assert(mem > 1024 * 1024, `a real memory figure (${Math.round(mem / 1024 / 1024)} MB)`);
    },
  },
  {
    name: "a background tab whose title changes gets a dot until you look at it",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const [chat] = await openTabs(k, site, waitFor, ["Chat"]);
      const page = await k.page(`${site.origin}/page/Chat`);
      await sleep(1700); // loaded a while ago
      await openTabs(k, site, waitFor, ["Elsewhere"]);
      await page.evaluate(`document.title = '(1) Chat'`);
      await waitFor(async () => (await k.tabs()).find((t) => t.id === chat.id)?.attention, { message: "a dot on Chat" });
      const toolbar = await k.toolbar();
      assert(await toolbar.evaluate(`document.querySelector('.tab[data-tab-id="${chat.id}"]').classList.contains('attention')`), "drawn");
      await toolbar.evaluate(`window.__kesselTest.activateTab(${chat.id})`);
      assert(!(await k.tabs()).find((t) => t.id === chat.id).attention, "gone once you look");
    },
  },
  {
    name: "Settings -> Tabs: keep tabs when Kessel closes, layout, hover cards",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.createTab("kessel://settings/tabs")`);
      const settings = await k.page((t) => t.url.includes("settings.html"));
      await settings.waitFor(`!!document.getElementById('tabs-restore')`, { message: "the Tabs section" });
      assert.equal(await settings.evaluate(`document.getElementById('tabs-restore').classList.contains('on')`), false, "off to begin with");
      await settings.clickSelector("#tabs-restore");
      await waitFor(async () => (await k.invoke("get_settings")).restore_tabs === true, { message: "turned on" });
      await settings.clickSelector('#tab-layout button[data-v="vertical"]');
      await toolbar.waitFor(`document.documentElement.classList.contains('vertical-tabs')`, { message: "tabs moved to the side" });
      await settings.clickSelector('#tab-layout button[data-v="horizontal"]');
      await toolbar.waitFor(`!document.documentElement.classList.contains('vertical-tabs')`, { message: "back on top" });
      // (The page was just resized back: let it settle before aiming a click.)
      await settings.waitFor(`innerWidth > 900`);
      await new Promise((r) => setTimeout(r, 300));
      await settings.clickSelector("#hover-cards");
      await waitFor(async () => (await k.invoke("get_settings")).tab_hover_cards === false, { message: "hover cards off" });
    },
  },
];
