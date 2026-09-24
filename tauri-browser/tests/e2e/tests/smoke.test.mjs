// Kessel starts on a throw-away profile, opens its first tab and loads a
// website; the tab strip follows the page's title.

export const tests = [
  {
    name: "starts with one tab on the new-tab page",
    async run({ launch, assert }) {
      const k = await launch();
      const tabs = await k.tabs();
      assert.equal(tabs.length, 1, "one tab at startup");
      assert.equal(tabs[0].url, "kessel://newtab", "first tab shows the new-tab page");
      assert(tabs[0].active, "first tab is active");
    },
  },
  {
    name: "keeps everything in the test profile",
    async run({ launch, assert }) {
      const k = await launch();
      assert(k.readProfileFile("Data/settings.json"), "settings.json lives in the profile folder");
    },
  },
  {
    name: "loads a website and shows its title in the tab strip",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url: `${site.origin}/page/Smoke` });
      await k.page(`${site.origin}/page/Smoke`);
      await waitFor(async () => (await k.tabs())[0].title === "Smoke", { message: "tab title 'Smoke'" });
    },
  },
];
