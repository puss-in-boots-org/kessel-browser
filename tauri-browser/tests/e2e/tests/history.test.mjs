// History search (history.rs, history.html): by title, by address, by site
// and by date -- what the history page asks the history for.

export const tests = [
  {
    name: "history is searched by title, by address, by site and by date; the history page shows it",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const visits = [
        ["https://alpha.example/one", "Glass bends light"],
        ["https://alpha.example/two", "Prisms and rainbows"],
        ["https://beta.example/notes/kessel-run", "Smugglers' routes"],
      ];
      for (const [url, title] of visits) await k.invoke("test_record_visit", { url, title });
      const titles = async (q) => (await k.invoke("query_history", q)).map((v) => v.title).sort();
      await waitFor(async () => (await titles({})).length >= 3, { message: "the visits recorded" });

      assert.deepEqual(await titles({ text: "rainbows" }), ["Prisms and rainbows"], "by a word of its title");
      assert.deepEqual(await titles({ text: "kessel-run" }), ["Smugglers' routes"], "by a piece of its address");
      assert.deepEqual(await titles({ site: "alpha.example" }), ["Glass bends light", "Prisms and rainbows"], "by site");
      const now = Math.floor(Date.now() / 1000);
      assert.equal((await titles({ from: now - 3600 })).length >= 3, true, "the last hour has them");
      assert.deepEqual(await titles({ to: now - 86400 }), [], "before yesterday: nothing");
      assert.deepEqual(await titles({ text: "light", from: now - 3600, site: "alpha.example" }), ["Glass bends light"], "all together");

      await k.invoke("open_singleton_tab", { route: "kessel://history" });
      const page = await k.page((t) => t.url.includes("history.html"));
      // (Ready once it has listed what's there.)
      await page.waitFor(`document.querySelectorAll('#list .visit').length >= 3`, { message: "the history page" });
      await page.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'smugglers'; q.dispatchEvent(new Event('input')); })()`);
      await page.waitFor(`(() => { const rows = [...document.querySelectorAll('#list .visit .title')].map((t) => t.textContent); return rows.length === 1 && rows[0] === "Smugglers' routes"; })()`, { message: "the page finds it" });
      await page.evaluate(`document.querySelector('[data-range="yesterday"]').click()`);
      await page.waitFor(`document.querySelectorAll('#list .visit').length === 0`, { message: "yesterday: not there" });
    },
  },
  {
    name: "right-click Back: the tab's own history, nearest first; picking a page goes straight there",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const [tab] = await k.tabs();
      for (const name of ["One", "Two", "Three"]) {
        const url = `${site.origin}/page/${name}`;
        await k.invoke("navigate", { id: tab.id, url });
        const page = await k.page((t) => t.url === url);
        await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
      }
      const history = await k.invoke("tab_history", { id: tab.id });
      assert.deepEqual(history.entries.slice(-3).map((e) => e.title), ["One", "Two", "Three"], "where it's been");
      assert.equal(history.entries[history.current].title, "Three", "where it is");

      const toolbar = await k.toolbar();
      await toolbar.clickSelector("#back-btn", { button: "right" });
      const menu = await k.page((t) => t.url.includes("/context.html"));
      await menu.waitFor(`document.querySelectorAll('.item').length > 0`);
      const labels = await menu.evaluate(`[...document.querySelectorAll('.item .label')].map((l) => l.textContent)`);
      assert.deepEqual(labels.slice(0, 2), ["Two", "One"], "nearest first");
      assert(labels.includes("Show full history"), "and the whole history");
      const box = await menu.evaluate(`(() => { const r = [...document.querySelectorAll('.item')].find((i) => i.querySelector('.label').textContent === 'One').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await menu.click(box.x, box.y);
      await waitFor(async () => (await k.tabs()).find((t) => t.id === tab.id)?.url === `${site.origin}/page/One`, { message: "two pages back" });
      const after = await k.invoke("tab_history", { id: tab.id });
      assert.equal(after.entries.slice(after.current + 1).length, 2, "Two and Three ahead, for Forward");
    },
  },
  {
    name: "remember what pages say: History finds a page by words on it, and forgets them when turned off",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { features: { history_page_text: true } } });
      const url = `${site.origin}/changing/Recipe`;
      await fetch(`${url}?set=${encodeURIComponent("Lentil soup with smoked paprika and a squeeze of lemon")}`);
      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url });
      const found = await waitFor(async () => (await k.invoke("query_history", { text: "smoked paprika" })).find((v) => v.url === url), { message: "found by its words", timeout: 15000 });
      assert(found.snippet.includes("smoked paprika"), `with them around it: ${found.snippet}`);

      // The history page shows where.
      await k.invoke("open_singleton_tab", { route: "kessel://history?q=paprika" });
      const history = await k.page((t) => t.url.includes("history.html"));
      await history.waitFor(`[...document.querySelectorAll('.visit .said')].some((s) => s.textContent.includes('smoked paprika'))`, { message: "the words on the history page" });

      // Turned off: forgotten.
      const settings = await k.invoke("get_settings");
      await k.invoke("update_settings", { settings: { ...settings, features: { ...settings.features, history_page_text: false } } });
      assert.equal((await k.invoke("query_history", { text: "paprika" })).length, 0, "not found by its words any more");
      assert((await k.invoke("query_history", { text: "Recipe" })).some((v) => v.url === url), "the visit itself is still there");
    },
  },
];
