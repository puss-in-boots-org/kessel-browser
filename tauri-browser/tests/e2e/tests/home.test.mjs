// The Home page's corner (newtab.html + home-corner.js, home.rs): recently
// opened pages, the weather card, music in one pinned music tab with what's
// playing, notes, PC & Kessel stats -- under a smaller clock and speed dial
// -- and Home staying put when it's the only tab left.

const visible = (page, id) => page.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return !!el && !el.closest("[hidden]") && el.getBoundingClientRect().height > 0; })()`);

export const tests = [
  {
    name: "Home shows the corner under a smaller clock and speed dial",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const home = await k.page("newtab.html");
      await waitFor(() => visible(home, "corner"), { message: "the corner shows" });
      for (const id of ["recent", "games", "weather", "music", "stats", "notes"]) assert(await visible(home, id), `the ${id} card shows`);
      assert(await home.evaluate(`document.documentElement.classList.contains("k-home-compact")`), "the top is the compact one");
      const clock = await home.evaluate(`parseFloat(getComputedStyle(document.getElementById("clock")).fontSize)`);
      assert(clock <= 56, `the clock shrank (${clock}px)`);
      // No place yet: the weather card asks for one instead of guessing.
      await waitFor(() => home.evaluate(`!!document.querySelector("#weather .w-search")`), { message: "the weather card asks for a town" });
      assert(await home.evaluate(`!!document.querySelector("#music .m-spotify") && !!document.querySelector("#music .m-apple")`), "Spotify and Apple Music lead the music card");

      // Customize: a card switched off goes; all off, the regular Home comes back.
      await home.evaluate(`document.getElementById("corner-customize").click()`);
      await waitFor(() => visible(home, "corner-menu"), { message: "the customize menu" });
      const settings = await k.invoke("get_settings");
      const off = { recent: false, games: false, weather: false, music: false, stats: false, notes: false };
      await k.invoke("update_settings", { settings: { ...settings, features: { ...(settings.features || {}), home: off } } });
      await waitFor(async () => !(await visible(home, "recent")) && !(await visible(home, "weather")), { message: "the cards went" });
      assert(!(await home.evaluate(`document.documentElement.classList.contains("k-home-compact")`)), "the full-size top is back");
      assert(await visible(home, "corner-customize"), "Customize stays, to bring them back");
    },
  },
  {
    name: "recently opened lists the pages you visited; one can be hidden",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const [first] = await k.tabs();
      await k.invoke("navigate", { id: first.id, url: `${site.origin}/login` });
      await k.page(`${site.origin}/login`);
      await waitFor(async () => (await k.invoke("query_history", { text: "", limit: 10 })).some((v) => v.url.includes("/login")), { message: "the visit is in history" });
      await k.createTab();
      const home = await k.page("newtab.html");
      const card = `[...document.querySelectorAll("#recent-grid .rc")].find((c) => c.title.includes("/login"))`;
      await waitFor(() => home.evaluate(`!!${card}`), { message: "a card for the page" });
      await home.evaluate(`${card}.querySelector(".rc-hide").click()`);
      await waitFor(async () => ((await k.invoke("get_settings")).features?.home?.hidden || []).some((u) => u.includes("/login")), { message: "remembered as hidden" });
      await waitFor(() => home.evaluate(`!${card}`), { message: "the card went" });
    },
  },
  {
    name: "closing the only tab leaves Home; closing Home itself keeps it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const toolbar = await k.toolbar();
      const [home] = await k.tabs();
      assert.equal(home.url, "kessel://newtab");
      await toolbar.evaluate(`window.__kesselTest.closeTab(${home.id})`);
      await new Promise((r) => setTimeout(r, 500));
      let tabs = await k.tabs();
      assert.equal(tabs.length, 1, "still one tab");
      assert.equal(tabs[0].id, home.id, "the same Home -- nothing was torn down and rebuilt");

      await k.invoke("navigate", { id: home.id, url: `${site.origin}/page/Away` });
      await waitFor(async () => (await k.tabs())[0].url.includes("/page/Away"), { message: "on a page" });
      await toolbar.evaluate(`window.__kesselTest.closeTab(${home.id})`);
      await waitFor(async () => {
        tabs = await k.tabs();
        return tabs.length === 1 && tabs[0].url === "kessel://newtab";
      }, { message: "Home in its place" });
    },
  },
  {
    name: "the music card opens one pinned music tab and reuses it",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const home = await k.page("newtab.html");
      await waitFor(() => home.evaluate(`!!document.querySelector("#music .m-spotify")`), { message: "the music card" });
      const musicTabs = async () => (await k.tabs()).filter((t) => t.pinned && /^https:\/\/(open\.spotify\.com|music\.apple\.com)\//.test(t.url));

      await home.evaluate(`document.querySelector("#music .m-spotify").click()`);
      const [spotify] = await waitFor(async () => {
        const list = await musicTabs();
        return list.length === 1 && list;
      }, { message: "a pinned Spotify tab", timeout: 15000 });
      assert((await k.activeTab()).id === spotify.id, "and it's shown");

      // Back to Home, Spotify again: the same tab, not another one.
      const homeTab = (await k.tabs()).find((t) => t.url === "kessel://newtab");
      await (await k.toolbar()).evaluate(`window.__kesselTest.activateTab(${homeTab.id})`);
      await home.evaluate(`document.querySelector("#music .m-spotify").click()`);
      await waitFor(async () => (await k.activeTab()).id === spotify.id, { message: "switched back to the music tab" });
      assert.equal((await musicTabs()).length, 1, "still one music tab");
    },
  },
  {
    name: "Home's notes are kept with the side panel's notes",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const home = await k.page("newtab.html");
      await waitFor(() => home.evaluate(`!!document.querySelector("#notes .n-text")`), { message: "the notes card" });
      await home.evaluate(`(() => { const t = document.querySelector("#notes .n-text"); t.focus(); t.value = "Buy milk"; t.dispatchEvent(new Event("input")); t.blur(); })()`);
      const note = await waitFor(async () => (await k.invoke("get_notes")).find((n) => n.url === "kessel://home"), { message: "saved as a note" });
      assert.equal(note.text, "Buy milk");
      assert.equal(note.title, "Home notes");
      // Changed elsewhere (the side panel): Home follows.
      await k.invoke("save_note", { note: { ...note, text: "Buy oat milk" } });
      await waitFor(async () => (await home.evaluate(`document.querySelector("#notes .n-text").value`)) === "Buy oat milk", { message: "Home shows the change" });
    },
  },
  {
    name: "stats count Kessel's processes; now playing lists a tab that plays",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const stats = await k.invoke("home_stats");
      assert(stats.memory.total > 0, "the PC's memory");
      assert(stats.kessel.memory > 0 && stats.kessel.processes >= 2, `Kessel and its engine (${stats.kessel.processes} processes)`);
      const home = await k.page("newtab.html");
      await waitFor(() => home.evaluate(`/%/.test(document.querySelector("#stats .s-gauge.ram span")?.textContent || "")`), { message: "the memory gauge fills in" });

      await k.createTab(`${site.origin}/sound/Tone`);
      const tab = await waitFor(async () => (await k.tabs()).find((t) => t.title === "Tone"), { message: "the sound page" });
      await k.press("Ctrl+M", { tab: tab.id, page: true });
      const page = await k.page(`${site.origin}/sound/Tone`);
      await page.evaluate(`startSound()`, { userGesture: true });
      await waitFor(async () => (await k.invoke("home_played")).some((t) => t.id === tab.id && t.playing), { message: "listed as playing", timeout: 15000 });
      // The other app's song (Windows' media controls) answers too -- null
      // when nothing else plays.
      const other = await k.invoke("home_system_media", { artFor: null });
      assert(other === null || typeof other.title === "string", "the system media answer has the right shape");
    },
  },
  {
    name: "a private window's Home leaves out your history and notes",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const [first] = await k.tabs();
      await k.invoke("navigate", { id: first.id, url: `${site.origin}/login` });
      await k.page(`${site.origin}/login`);
      await k.invoke("new_window", { private: true });
      const privateHome = await waitFor(async () => {
        for (const target of (await k.targets()).filter((t) => t.url.includes("newtab.html"))) {
          const page = await k.attach(target);
          if ((await page.evaluate(`window.__TAURI__.core.invoke("home_context")`).catch(() => null))?.private) return page;
        }
        return null;
      }, { message: "the private window's Home" });
      await waitFor(() => visible(privateHome, "weather"), { message: "the weather card shows" });
      assert(!(await visible(privateHome, "recent")), "no recently opened pages");
      assert(!(await visible(privateHome, "notes")), "no notes");
      await privateHome.evaluate(`document.getElementById("corner-customize").click()`);
      await waitFor(() => visible(privateHome, "corner-menu"), { message: "the customize menu" });
      assert(!(await privateHome.evaluate(`document.getElementById("corner-menu").textContent.includes("Recently opened")`)), "nor a switch for them");
      assert.equal((await k.invoke("get_settings")).features?.home?.recent, undefined, "and the normal windows' choice is untouched");
    },
  },
];
