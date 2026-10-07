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
];
