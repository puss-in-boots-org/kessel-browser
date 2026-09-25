// The tab strip: pinned tabs, sound (playing / muted), picking several tabs
// with Ctrl/Shift+click, and the tab menu -- a popup over the page -- with
// everything on it.

// Opens tabs on the test site's pages `names`, one after the other; returns
// them in the same order, as the strip shows them.
async function openTabs(k, site, waitFor, names) {
  for (const name of names) await k.createTab(`${site.origin}/page/${name}`);
  return waitFor(async () => {
    const tabs = await k.tabs();
    const found = names.map((n) => tabs.find((t) => t.url.endsWith(`/page/${n}`)));
    return found.every(Boolean) && found;
  }, { message: `tabs ${names.join(", ")}` });
}

const titles = async (k) => (await k.tabs()).map((t) => t.title);

// The right-click menu popup (context.html), once it's open.
const menuPopup = (k) => k.page((t) => t.url.includes("/context.html"));

async function menuLabels(popup) {
  await popup.waitFor(`document.querySelectorAll('.item').length > 0`);
  return popup.evaluate(`[...document.querySelectorAll('.item')].map(i => (i.classList.contains('disabled') ? '(off) ' : '') + i.querySelector('.label').textContent)`);
}

async function pickItem(popup, label) {
  const box = await popup.evaluate(`(() => {
    const el = [...document.querySelectorAll('.item')].find(i => i.querySelector('.label').textContent === ${JSON.stringify(label)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) throw new Error(`no menu item "${label}"`);
  await popup.click(box.x, box.y);
}

async function popupClosed(k, waitFor) {
  await waitFor(async () => !(await k.targets()).some((t) => t.url.includes("/context.html")), { message: "the menu closed" });
}

// Runs a command the way a shortcut or the menu does.
const command = (toolbar, id) => toolbar.evaluate(`window.__TAURI__.event.emitTo("toolbar-1", "browser-command", { command: ${JSON.stringify(id)} })`);

export const tests = [
  {
    name: "the tab menu opens over the page and runs what you pick",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const [a] = await openTabs(k, site, waitFor, ["Alpha", "Beta"]);
      const toolbar = await k.toolbar();
      await toolbar.clickSelector(`.tab[data-tab-id="${a.id}"]`, { button: "right" });
      const popup = await menuPopup(k);
      const labels = await menuLabels(popup);
      for (const expected of ["New tab to the right", "Reload", "Duplicate", "Pin tab", "Mute tab", "Bookmark tab", "Copy link", "Move to new window", "Close", "Close other tabs", "Close tabs to the right", "Close tabs to the left", "Reopen closed tab"]) {
        assert(labels.includes(expected), `the menu has "${expected}" (has: ${labels.join(" | ")})`);
      }
      // The popup is its own webview, placed where the click was.
      const size = await popup.evaluate(`({ w: innerWidth, h: innerHeight })`);
      assert(size.w >= 280 && size.h > 300, `a menu-sized popup (${size.w}x${size.h})`);

      await pickItem(popup, "Duplicate");
      await popupClosed(k, waitFor);
      // The copy opens right after its original.
      await waitFor(async () => (await titles(k)).join() === "New Tab,Alpha,Alpha,Beta", { message: "a duplicate next to Alpha" });

      // A second right-click (here on the first tab) shows that tab's menu
      // instead of closing the menu.
      await toolbar.clickSelector(`.tab[data-tab-id="${a.id}"]`, { button: "right" });
      const again = await menuPopup(k);
      assert((await menuLabels(again)).includes("Close tabs to the left"), "Alpha's menu: tabs to its left to close");
      const firstTab = (await k.tabs())[0];
      await toolbar.clickSelector(`.tab[data-tab-id="${firstTab.id}"]`, { button: "right" });
      await again.waitFor(`[...document.querySelectorAll('.item.disabled .label')].some(l => l.textContent === 'Close tabs to the left')`, { message: "the first tab's menu: nothing to its left" });
      assert.equal((await k.targets()).filter((t) => t.url.includes("/context.html")).length, 1, "one menu open");
      await again.key("Escape");
      await popupClosed(k, waitFor);
    },
  },
  {
    name: "pinned tabs sit in front, icon only, and come back pinned after a restart",
    async run({ launch, site, assert, waitFor }) {
      let k = await launch({ settings: { restore_tabs: true }, keepProfile: true });
      const [, , c] = await openTabs(k, site, waitFor, ["One", "Two", "Three"]);
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${c.id}, "Pin tab")`);
      const strip = await k.tabs();
      assert.equal(strip[0].id, c.id, "the pinned tab moved to the front");
      assert(strip[0].pinned, "and is pinned");
      const look = await toolbar.evaluate(`(() => { const el = document.querySelector('.tab.pinned'); return { close: !!el.querySelector('.close-tab'), title: getComputedStyle(el.querySelector('.tab-title')).display, width: el.getBoundingClientRect().width }; })()`);
      assert(!look.close, "no close button on a pinned tab");
      assert.equal(look.title, "none", "no title either");
      assert(look.width < 60, `just its icon (${look.width}px wide)`);

      // Close other tabs keeps it.
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${strip[1].id}, "Close other tabs")`);
      await waitFor(async () => (await k.tabs()).length === 2, { message: "other tabs closed" });
      assert.deepEqual(await titles(k), ["Three", "New Tab"], "the pinned tab stayed");
      assert((await k.tabs()).some((t) => t.id === c.id && t.pinned), "still pinned");

      await waitFor(async () => {
        const saved = JSON.parse(k.readProfileFile("Data/session.json") || "{}");
        return saved.windows?.[0]?.tabs?.some((t) => t.url.endsWith("/page/Three") && t.pinned);
      }, { message: "saved as pinned" });
      const profileDir = k.profileDir;
      await k.close({ keepProfile: true });

      k = await launch({ profileDir });
      try {
        const restored = await waitFor(async () => {
          const t = await k.tabs();
          return t.length === 2 && t;
        }, { message: "the session back" });
        assert(restored[0].url.endsWith("/page/Three") && restored[0].pinned, "the pinned tab is back, pinned, in front");
        const toolbar2 = await k.toolbar();
        await toolbar2.evaluate(`window.__kesselTest.tabMenu(${restored[0].id}, "Unpin tab")`);
        await waitFor(async () => !(await k.tabs()).some((t) => t.pinned), { message: "unpinned" });
        assert(await toolbar2.evaluate(`!!document.querySelector('.tab[data-tab-id="${restored[0].id}"] .close-tab')`), "its close button is back");
      } finally {
        await k.close({ keepProfile: false });
      }
    },
  },
  {
    name: "close tabs to the right, to the left, and all but pinned ones",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const [a, , c] = await openTabs(k, site, waitFor, ["A", "B", "C", "D"]);
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${a.id}, "Pin tab")`);
      assert.deepEqual(await titles(k), ["A", "New Tab", "B", "C", "D"], "A pinned in front");

      await toolbar.evaluate(`window.__kesselTest.tabMenu(${c.id}, "Close tabs to the right")`);
      await waitFor(async () => (await titles(k)).join() === "A,New Tab,B,C", { message: "D closed" });
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${c.id}, "Close tabs to the left")`);
      await waitFor(async () => (await titles(k)).join() === "A,C", { message: "New Tab and B closed, pinned A kept" });

      // The same as commands (for shortcuts you give them).
      await openTabs(k, site, waitFor, ["E", "F"]);
      await toolbar.evaluate(`window.__kesselTest.activateTab(${c.id})`);
      await command(toolbar, "close-tabs-right");
      await waitFor(async () => (await titles(k)).join() === "A,C", { message: "close-tabs-right" });
      const [g] = await openTabs(k, site, waitFor, ["G"]);
      await command(toolbar, "close-tabs-left");
      await waitFor(async () => (await titles(k)).join() === "A,G", { message: "close-tabs-left keeps pinned tabs" });
      assert.equal((await k.activeTab()).id, g.id, "G still the tab you're on");

      await openTabs(k, site, waitFor, ["H"]);
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${g.id}, "Close all but pinned tabs")`);
      const left = await waitFor(async () => {
        const t = await k.tabs();
        return t.length === 1 && t;
      }, { message: "only the pinned tab" });
      assert(left[0].pinned && left[0].active, "the pinned tab is left, and shown");
    },
  },
  {
    name: "Ctrl+click and Shift+click pick several tabs; the menu and Ctrl+W act on all of them",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const [a, b, c, d] = await openTabs(k, site, waitFor, ["A", "B", "C", "D"]);
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.activateTab(${a.id})`);
      await toolbar.clickSelector(`.tab[data-tab-id="${c.id}"]`, { modifiers: ["Control"] });
      let strip = await k.tabs();
      assert(strip.find((t) => t.id === c.id).selected, "Ctrl+click picks C");
      assert(strip.find((t) => t.id === a.id).active, "without leaving A");
      assert(await toolbar.evaluate(`document.querySelector('.tab[data-tab-id="${c.id}"]').classList.contains('selected')`), "C looks picked");

      await toolbar.clickSelector(`.tab[data-tab-id="${d.id}"]`, { modifiers: ["Shift"] });
      strip = await k.tabs();
      assert.deepEqual(strip.filter((t) => t.selected).map((t) => t.title), ["C", "D"], "Shift+click picks C to D");

      const menu = await toolbar.evaluate(`window.__kesselTest.tabMenu(${c.id})`);
      const labels = menu.filter((i) => i.label).map((i) => i.label);
      for (const expected of ["Reload 3 tabs", "Duplicate 3 tabs", "Pin 3 tabs", "Mute 3 tabs", "Bookmark 3 tabs", "Copy 3 links", "Move 3 tabs to new window", "Close 3 tabs"]) {
        assert(labels.includes(expected), `the menu says "${expected}"`);
      }
      // A right-click on a tab that isn't picked is about that tab only.
      const single = await toolbar.evaluate(`window.__kesselTest.tabMenu(${b.id})`);
      assert(single.some((i) => i.label === "Close"), "B's own menu");

      await toolbar.evaluate(`window.__kesselTest.tabMenu(${c.id}, "Pin 3 tabs")`);
      strip = await k.tabs();
      assert.deepEqual(strip.slice(0, 3).map((t) => [t.title, t.pinned]), [["A", true], ["C", true], ["D", true]], "all three pinned, in order");
      assert(!strip.some((t) => t.selected), "picking ends with the action");

      // Ctrl+W closes every picked tab.
      await toolbar.clickSelector(`.tab[data-tab-id="${b.id}"]`);
      const blank = strip.find((t) => t.title === "New Tab");
      await toolbar.clickSelector(`.tab[data-tab-id="${blank.id}"]`, { modifiers: ["Control"] });
      await k.press("Ctrl+W");
      await waitFor(async () => (await titles(k)).join() === "A,C,D", { message: "B and the new tab closed" });
      assert((await k.activeTab()).title === "D", "the nearest tab left of them took over");
    },
  },
  {
    name: "a tab playing sound shows a speaker; it and Ctrl+M mute the tab",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await k.createTab(`${site.origin}/sound/Tone`);
      const tab = await waitFor(async () => (await k.tabs()).find((t) => t.title === "Tone"), { message: "the sound page" });
      const page = await k.page(`${site.origin}/sound/Tone`);
      const toolbar = await k.toolbar();
      const tabInfo = async () => (await k.tabs()).find((t) => t.id === tab.id);

      // Muted first, so nothing actually comes out of the speakers.
      await k.press("Ctrl+M", { tab: tab.id, page: true });
      await waitFor(async () => (await tabInfo()).muted, { message: "Ctrl+M muted the tab" });
      assert(await toolbar.evaluate(`!!document.querySelector('.tab[data-tab-id="${tab.id}"] .tab-audio.muted')`), "a crossed-out speaker on the tab");

      await page.evaluate(`startSound()`, { userGesture: true });
      await waitFor(async () => (await tabInfo()).audible, { message: "the tab plays sound", timeout: 15000 });
      assert((await tabInfo()).muted, "still muted while it plays");

      // A click on the speaker unmutes -- and another mutes again.
      await toolbar.clickSelector(`.tab[data-tab-id="${tab.id}"] .tab-audio`);
      await waitFor(async () => !(await tabInfo()).muted, { message: "unmuted by a click" });
      assert(await toolbar.evaluate(`!!document.querySelector('.tab[data-tab-id="${tab.id}"] .tab-audio:not(.muted)')`), "a speaker playing");
      await toolbar.clickSelector(`.tab[data-tab-id="${tab.id}"] .tab-audio`);
      await waitFor(async () => (await tabInfo()).muted, { message: "muted by a click" });
      assert((await tabInfo()).active, "clicking the speaker doesn't switch tabs or pick the tab");

      // The menu says what the click would do.
      assert((await toolbar.evaluate(`window.__kesselTest.tabMenu(${tab.id})`)).some((i) => i.label === "Unmute tab"), "the menu offers Unmute");

      await page.evaluate(`stopSound()`);
      await waitFor(async () => !(await tabInfo()).audible, { message: "stopped playing", timeout: 15000 });
      await k.press("Ctrl+M", { tab: tab.id, page: true });
      await waitFor(async () => !(await tabInfo()).muted, { message: "unmuted" });
      await waitFor(async () => toolbar.evaluate(`!document.querySelector('.tab[data-tab-id="${tab.id}"] .tab-audio')`), { message: "no speaker on a quiet tab" });
    },
  },
  {
    name: "picked tabs move into a new window together, pinned ones still pinned",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const [a, b] = await openTabs(k, site, waitFor, ["Mover1", "Mover2", "Stayer"]);
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${a.id}, "Pin tab")`);
      await toolbar.evaluate(`window.__kesselTest.activateTab(${a.id})`);
      await toolbar.clickSelector(`.tab[data-tab-id="${b.id}"]`, { modifiers: ["Control"] });
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${a.id}, "Move 2 tabs to new window")`);
      await waitFor(async () => (await k.windows()).length === 2, { message: "a new window" });
      const moved = await waitFor(async () => {
        const t = await k.tabs("win-2").catch(() => []);
        return t.length === 2 && t;
      }, { message: "both tabs in the new window" });
      assert.deepEqual(moved.map((t) => [t.id, t.pinned]), [[a.id, true], [b.id, false]], "the same tabs, the first still pinned");
      const shown = await k.invoke("get_open_tabs", {}, { window: "win-2" });
      assert.equal(shown.active, moved.find((t) => t.active).id, "the new window really shows its active tab");
      await waitFor(async () => (await titles(k)).join() === "New Tab,Stayer", { message: "gone from the first window" });
    },
  },
  {
    name: "new tab to the right, and the search engine menu over the page",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const [a] = await openTabs(k, site, waitFor, ["Left", "Right"]);
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${a.id}, "New tab to the right")`);
      await waitFor(async () => (await titles(k)).join() === "New Tab,Left,New Tab,Right", { message: "a new tab right after Left" });
      assert.equal((await k.tabs())[2].active, true, "and it's shown");

      await toolbar.clickSelector("#engine-btn");
      let popup = await menuPopup(k);
      const labels = await menuLabels(popup);
      assert(labels.includes("Google") && labels.includes("Bing") && labels.includes("Manage search engines"), `engines listed (${labels.join(" | ")})`);
      await popup.waitFor(`[...document.querySelectorAll('.item')].find(i => i.querySelector('.check svg'))?.querySelector('.label').textContent === "Google"`, { message: "the current engine is ticked" });
      await pickItem(popup, "Bing");
      await popupClosed(k, waitFor);
      await waitFor(async () => (await k.invoke("get_settings")).search_engine === "bing", { message: "Bing chosen" });

      // The button toggles its menu. (A click right as a menu closes counts
      // as the click that closed it.)
      await sleep(500);
      await toolbar.clickSelector("#engine-btn");
      popup = await menuPopup(k);
      await popup.waitFor(`[...document.querySelectorAll('.item')].find(i => i.querySelector('.check svg'))?.querySelector('.label').textContent === "Bing"`, { message: "Bing ticked now" });
      await toolbar.clickSelector("#engine-btn");
      await popupClosed(k, waitFor);
    },
  },
];
