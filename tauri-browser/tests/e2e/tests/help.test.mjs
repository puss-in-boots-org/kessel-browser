// Help's guide (help.js, shared/guide.js): a tour of Kessel by topic, before
// the shortcut reference; searchable; its links open Kessel's own pages.

export const tests = [
  {
    name: "Help opens at the guide; searching finds a topic; its links open Settings",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      await k.invoke("open_singleton_tab", { route: "kessel://help" });
      const page = await k.page("help.html");
      await page.waitFor(`document.querySelectorAll('#start .tip').length > 3 && document.querySelectorAll('#shortcuts .line').length > 40`, { message: "the guide and the shortcuts" });
      const groups = await page.evaluate(`[...document.querySelectorAll('#nav .nav-group')].map((g) => g.textContent)`);
      assert.deepEqual(groups, ["Guide", "Reference"], "the nav's two parts");
      assert.equal(await page.evaluate(`document.querySelector('.nav-item.active')?.dataset.section`), "start", "opens at Getting started");

      // Search: "surfshark" leaves the VPN topic.
      await page.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'surfshark'; q.dispatchEvent(new Event('input')); })()`);
      const shown = await page.evaluate(`[...document.querySelectorAll('section:not(.hidden-by-search)')].map((s) => s.id)`);
      assert.deepEqual(shown, ["network"], "only the VPN topic matches");

      // A link to Settings opens it at that section.
      await page.evaluate(`document.querySelector('#network a[data-open="kessel://settings/network"]').click()`);
      await waitFor(async () => (await k.tabs()).some((t) => t.url.startsWith("kessel://settings/network") && t.active), { message: "Settings -> Network" });

      // All features knows the newer ones too.
      await k.invoke("open_singleton_tab", { route: "kessel://settings/features" });
      const settings = await k.page((t) => t.url.includes("settings.html"));
      await settings.waitFor(`!!document.querySelector('#features-list .setting-row')`, { message: "All features" });
      const text = await settings.evaluate(`document.getElementById('features-list').innerText`);
      for (const name of ["VPN", "Spelling and grammar", "Workspaces", "Install a site as an app"]) assert(text.includes(name), `All features lists ${name}`);
    },
  },
];
