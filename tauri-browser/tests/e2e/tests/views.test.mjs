// Two pages at once and links dragged in (split.rs, main.js openSplit and
// wireExternalDrops): split view shows two tabs side by side and goes back;
// a link dropped between tabs opens there, onto a tab goes into that tab.

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id: tab.id, page };
}

export const tests = [
  {
    name: "split view: two tabs side by side, each half the width; exit puts the one you're on back on its own",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id: leftId, page: left } = await open(k, `${site.origin}/page/Left`);
      const full = await left.evaluate(`innerWidth`);
      const rightId = await k.createTab(`${site.origin}/page/Right`);
      const right = await k.page((t) => t.url === `${site.origin}/page/Right`);
      await right.waitFor(`document.readyState === 'complete'`);
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${leftId}, "Open side by side with this tab")`);
      await waitFor(async () => (await left.evaluate(`innerWidth`)) < full * 0.6 && (await right.evaluate(`innerWidth`)) < full * 0.6, { message: "both about half as wide" });
      assert.equal(await left.evaluate(`document.visibilityState`), "visible", "the left one showing");
      assert.equal(await right.evaluate(`document.visibilityState`), "visible", "and the right one");
      assert(Math.abs((await left.evaluate(`innerWidth`)) - (await right.evaluate(`innerWidth`))) < 20, "side by side, the same size");

      await k.invoke("unsplit");
      await waitFor(async () => (await k.activeTab()).id === leftId ? (await left.evaluate(`innerWidth`)) === full : (await right.evaluate(`innerWidth`)) === full, { message: "the one you're on full width again" });
      assert(rightId > 0, "both still open");
    },
  },
  {
    name: "a link dragged onto the tab strip: between tabs it opens there, onto a tab it goes into that tab",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id } = await open(k, `${site.origin}/page/Here`);
      const toolbar = await k.toolbar();
      const drop = async (x, y, url) => {
        const data = { items: [{ mimeType: "text/uri-list", data: url }, { mimeType: "text/plain", data: url }], dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver", "dragOver", "drop"]) await toolbar.session.send("Input.dispatchDragEvent", { type, x, y, data });
      };
      // Between tabs: the gap by the new tab button.
      const [gx, gy] = await toolbar.evaluate(`(() => { const b = document.getElementById('new-tab-btn').getBoundingClientRect(); return [b.left - 3, b.top + b.height / 2]; })()`);
      await drop(gx, gy, `${site.origin}/page/Dropped`);
      await waitFor(async () => (await k.tabs()).some((t) => t.url === `${site.origin}/page/Dropped`), { message: "a new tab with it" });
      assert.equal((await k.tabs()).length, 2, "one more tab");

      // Onto the middle of the first tab: it goes there.
      const [tx, ty] = await toolbar.evaluate(`(() => { const b = document.querySelector('.tab[data-tab-id="${id}"]').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
      await drop(tx, ty, `${site.origin}/page/Into`);
      await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.url === `${site.origin}/page/Into`, { message: "the first tab went there" });
      assert.equal((await k.tabs()).length, 2, "no tab more");
    },
  },
];
