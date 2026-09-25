// Tab groups: making, naming, colouring, folding and ungrouping them;
// grouping tabs by site; keeping groups across a restart; and saved groups
// on the bookmarks bar.

async function openTabs(k, site, waitFor, names, host = site.origin) {
  for (const name of names) await k.createTab(`${host}/page/${name}`);
  return waitFor(async () => {
    const tabs = await k.tabs();
    const found = names.map((n) => tabs.find((t) => t.url.endsWith(`/page/${n}`)));
    return found.every(Boolean) && found;
  }, { message: `tabs ${names.join(", ")}` });
}

const menuPopup = (k) => k.page((t) => t.url.includes("/context.html"));
const titles = async (k) => (await k.tabs()).map((t) => t.title);
const command = (toolbar, id) => toolbar.evaluate(`window.__TAURI__.event.emitTo("toolbar-1", "browser-command", { command: ${JSON.stringify(id)} })`);

async function pickItem(popup, label) {
  await popup.waitFor(`document.querySelectorAll('.item').length > 0`);
  const box = await popup.evaluate(`(() => {
    const el = [...document.querySelectorAll('.item')].find(i => i.querySelector('.label').textContent === ${JSON.stringify(label)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) throw new Error(`no menu item "${label}"`);
  await popup.click(box.x, box.y);
}

export const tests = [
  {
    name: "a new group from the tab menu: named right in the strip, coloured, folded, ungrouped",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const [a, b, c] = await openTabs(k, site, waitFor, ["A", "B", "C"]);
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.activateTab(${a.id})`);
      await toolbar.clickSelector(`.tab[data-tab-id="${b.id}"]`, { modifiers: ["Control"] });
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${a.id}, "Add 2 tabs to new group")`);
      // The name is typed right in the group's label.
      await toolbar.waitFor(`document.activeElement && document.activeElement.classList.contains('group-name-input')`, { message: "a name box in the strip" });
      await toolbar.session.send("Input.insertText", { text: "Wo" });
      // The strip redraws while you type (a tab finished loading...): the
      // box stays, with what's typed so far.
      await toolbar.evaluate(`window.__TAURI__.event.emitTo("toolbar-1", "tab-load-finished", { id: ${a.id} })`);
      await toolbar.waitFor(`document.activeElement && document.activeElement.classList.contains('group-name-input') && document.activeElement.value === 'Wo'`, { message: "the box survived a redraw" });
      await toolbar.session.send("Input.insertText", { text: "rk" });
      await toolbar.key("Enter");
      const group = await waitFor(async () => {
        const g = await toolbar.evaluate(`window.__kesselTest.groups()`);
        return g.length === 1 && g[0].name === "Work" && g[0];
      }, { message: "a group named Work" });
      let strip = await k.tabs();
      assert.deepEqual(strip.filter((t) => t.group === group.id).map((t) => t.title), ["A", "B"], "A and B in it");
      assert.equal(await toolbar.evaluate(`document.querySelector('[data-user-group]').textContent`), "Work", "its label says Work");
      assert(await toolbar.evaluate(`document.querySelectorAll('.tab.in-group .group-line').length === 2`), "a line in its colour under both");

      // Colour from the group's menu.
      await toolbar.clickSelector(`[data-user-group="${group.id}"]`, { button: "right" });
      const popup = await menuPopup(k);
      await pickItem(popup, "Green");
      await waitFor(async () => (await toolbar.evaluate(`window.__kesselTest.groups()`))[0]?.color === "green", { message: "green" });

      // Folding the group you're in moves you out of it; its tabs hide.
      await sleep(400);
      await toolbar.clickSelector(`[data-user-group="${group.id}"]`);
      await waitFor(async () => (await k.activeTab()).id === c.id, { message: "moved to C, outside the folded group" });
      await toolbar.waitFor(`document.querySelectorAll('.tab.in-group').length === 0`, { message: "the group's tabs are hidden" });
      assert.equal(await toolbar.evaluate(`document.querySelector('[data-user-group]').textContent`), "Work · 2", "the label counts them");
      // Ctrl+Tab skips a folded group.
      await k.press("Ctrl+Tab");
      await waitFor(async () => (await k.activeTab()).title === "New Tab", { message: "Ctrl+Tab went past the folded group" });
      await toolbar.clickSelector(`[data-user-group="${group.id}"]`);
      await toolbar.waitFor(`document.querySelectorAll('.tab.in-group').length === 2`, { message: "unfolded" });

      // New tab in group, then Ungroup.
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${a.id})`); // (menu builds fine for a grouped tab)
      await command(toolbar, "new-tab");
      strip = await waitFor(async () => {
        const t = await k.tabs();
        return t.length === 5 && t;
      });
      assert(!strip[strip.length - 1].group, "Ctrl+T's tab isn't grouped");
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${a.id}, "Remove from group")`);
      strip = await k.tabs();
      assert.deepEqual(strip.filter((t) => t.group).map((t) => t.title), ["B"], "A left the group");
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${b.id}, "Remove from group")`);
      await waitFor(async () => (await toolbar.evaluate(`window.__kesselTest.groups()`)).length === 0, { message: "an emptied group is gone" });
    },
  },
  {
    name: "group tabs by site, and new tabs of a site joining its group by themselves",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      // 127.0.0.2 (the test site) and localhost: two sites.
      const other = site.origin.replace("127.0.0.2", "localhost");
      await openTabs(k, site, waitFor, ["S1", "S2"]);
      await openTabs(k, site, waitFor, ["L1"], other);
      const toolbar = await k.toolbar();
      await command(toolbar, "group-tabs-by-site");
      const groups = await waitFor(async () => {
        const g = await toolbar.evaluate(`window.__kesselTest.groups()`);
        return g.length === 1 && g;
      }, { message: "one site group" });
      const strip = await k.tabs();
      assert.deepEqual(strip.filter((t) => t.group === groups[0].id).map((t) => t.title), ["S1", "S2"], "the two tabs of the same site");
      assert(groups[0].name, `named after the site (${groups[0].name})`);

      // Automatic: a new tab of that site joins; switching the setting on.
      await k.invoke("update_settings", { settings: { ...(await k.invoke("get_settings")), auto_group_tabs: true } });
      await openTabs(k, site, waitFor, ["S3"]);
      await waitFor(async () => (await k.tabs()).find((t) => t.title === "S3")?.group === groups[0].id, { message: "S3 joined the site's group" });
      await openTabs(k, site, waitFor, ["L2"], other);
      await waitFor(async () => (await toolbar.evaluate(`window.__kesselTest.groups()`)).length === 2, { message: "L1 and L2 made a group of their own" });
    },
  },
  {
    name: "groups come back after a restart; a saved group opens again from the bookmarks bar",
    async run({ launch, site, assert, waitFor }) {
      let k = await launch({ settings: { restore_tabs: true }, keepProfile: true });
      const [a, b] = await openTabs(k, site, waitFor, ["G1", "G2", "Loose"]);
      let toolbar = await k.toolbar();
      await toolbar.evaluate(`window.__kesselTest.activateTab(${a.id})`);
      await toolbar.clickSelector(`.tab[data-tab-id="${b.id}"]`, { modifiers: ["Control"] });
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${a.id}, "Add 2 tabs to new group")`);
      await toolbar.key("Escape"); // keep it unnamed for now...
      const [group] = await toolbar.evaluate(`window.__kesselTest.groups()`);
      await toolbar.evaluate(`window.__kesselTest.renameGroup(${JSON.stringify(group.id)}, "Trip")`); // ...then name it
      await waitFor(async () => {
        const saved = JSON.parse(k.readProfileFile("Data/session.json") || "{}");
        const w = saved.windows?.[0];
        return w?.groups?.some((g) => g.name === "Trip") && w.tabs.filter((t) => t.group === group.id).length === 2;
      }, { message: "the group in session.json" });

      // Save it.
      await toolbar.clickSelector(`[data-user-group="${group.id}"]`, { button: "right" });
      await pickItem(await menuPopup(k), "Save group");
      await waitFor(async () => (await k.invoke("get_saved_groups")).some((g) => g.name === "Trip" && g.tabs.length === 2), { message: "saved" });
      await toolbar.waitFor(`!!document.querySelector('.bm-chip.saved-group')`, { message: "a chip on the bookmarks bar" });

      const profileDir = k.profileDir;
      await k.close({ keepProfile: true });
      k = await launch({ profileDir });
      try {
        toolbar = await k.toolbar();
        const groups = await waitFor(async () => {
          const g = await toolbar.evaluate(`window.__kesselTest.groups ? window.__kesselTest.groups() : []`);
          return g.length === 1 && g;
        }, { message: "the group back" });
        assert.equal(groups[0].name, "Trip", "named Trip");
        const strip = await k.tabs();
        assert.deepEqual(strip.filter((t) => t.group === groups[0].id).map((t) => t.url.split("/").pop()), ["G1", "G2"], "with its tabs");

        // Close the group; the saved chip opens it again.
        for (const t of (await k.tabs()).filter((x) => x.group)) await toolbar.evaluate(`window.__kesselTest.closeTab(${t.id})`);
        await waitFor(async () => (await toolbar.evaluate(`window.__kesselTest.groups()`)).length === 0, { message: "group closed" });
        assert((await k.invoke("get_saved_groups")).some((g) => g.name === "Trip"), "still saved");
        await toolbar.clickSelector(".bm-chip.saved-group");
        const reopened = await waitFor(async () => {
          const t = (await k.tabs()).filter((x) => x.group);
          return t.length === 2 && t;
        }, { message: "the saved group's tabs open again" });
        assert(reopened[0].active, "its first tab shown");
        assert(reopened[1].discarded, "the rest asleep until clicked");
      } finally {
        await k.close({ keepProfile: false });
      }
    },
  },
  {
    name: "tab search lists every tab, sleeping and closed ones too; Enter goes there",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const [alpha, , gamma] = await openTabs(k, site, waitFor, ["Alpha", "Beta", "Gamma"]);
      const toolbar = await k.toolbar();
      // Gamma asleep, a closed tab on the list.
      await toolbar.evaluate(`window.__kesselTest.activateTab(${alpha.id})`);
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${gamma.id}, "Put to sleep")`);
      await waitFor(async () => (await k.tabs()).find((t) => t.title === "Gamma")?.discarded, { message: "Gamma asleep" });
      await openTabs(k, site, waitFor, ["Doomed"]);
      const doomed = (await k.tabs()).find((t) => t.title === "Doomed" || t.url.endsWith("/Doomed"));
      // (From another tab: closing the one you're on shows its neighbour --
      // Gamma, which would wake up.)
      await toolbar.evaluate(`window.__kesselTest.activateTab(${alpha.id})`);
      await toolbar.evaluate(`window.__kesselTest.closeTab(${doomed.id})`);
      await sleep(300);

      await k.press("Ctrl+Shift+A");
      const search = await k.page((t) => t.url.includes("/tabsearch.html"));
      await search.waitFor(`document.querySelectorAll('.row').length >= 5`, { message: "the list" });
      const listed = await search.evaluate(`[...document.querySelectorAll('.row .title')].map(e => e.textContent)`);
      for (const t of ["Alpha", "Beta", "Gamma", "Doomed"]) assert(listed.includes(t), `lists ${t} (${listed.join(", ")})`);
      assert(await search.evaluate(`[...document.querySelectorAll('.row.sleeping .title')].some(e => e.textContent === 'Gamma')`), "Gamma shown as asleep");

      await search.evaluate(`document.getElementById('q').focus()`);
      await search.session.send("Input.insertText", { text: "gam" });
      await search.waitFor(`document.querySelectorAll('.row').length === 1`, { message: "filtered to Gamma" });
      await search.key("Enter");
      await waitFor(async () => {
        const t = (await k.tabs()).find((x) => x.title === "Gamma" || x.url.endsWith("/Gamma"));
        return t?.active && !t.discarded;
      }, { message: "Gamma woke up and is shown" });
      await waitFor(async () => !(await k.targets()).some((t) => t.url.includes("/tabsearch.html")), { message: "the search closed" });
    },
  },
  {
    name: "a full strip shrinks its tabs, then scrolls; vertical tabs move the page aside",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const toolbar = await k.toolbar();
      // With room to spare, a tab is full width, title and all.
      await toolbar.waitFor(`document.querySelectorAll('.tab').length === 1`);
      const alone = await toolbar.evaluate(`(() => { const t = document.querySelector('.tab'); return { w: t.getBoundingClientRect().width, title: getComputedStyle(t.querySelector('.tab-title')).display }; })()`);
      assert(alone.w >= 150 && alone.title !== "none", `a lone tab is full width (${Math.round(alone.w)}px, title ${alone.title})`);
      for (let i = 0; i < 24; i++) await toolbar.evaluate(`window.__kesselTest.createTab(null)`);
      await waitFor(async () => (await k.tabs()).length === 25, { message: "25 tabs" });
      await sleep(300);
      const strip = await toolbar.evaluate(`(() => { const s = document.getElementById('tabs'); const w = [...s.querySelectorAll('.tab')].map(t => t.getBoundingClientRect().width); return { over: s.scrollWidth > s.clientWidth + 1, min: Math.min(...w), right: !document.getElementById('tabs-scroll-right').hidden, left: !document.getElementById('tabs-scroll-left').hidden }; })()`);
      assert(strip.min < 100, `tabs shrank (narrowest ${Math.round(strip.min)}px)`);
      if (strip.over) assert(strip.left || strip.right, "scroll arrows when it overflows");
      // The tab you're on is in view.
      assert(await toolbar.evaluate(`(() => { const s = document.getElementById('tabs').getBoundingClientRect(); const a = document.querySelector('.tab.active').getBoundingClientRect(); return a.left >= s.left - 1 && a.right <= s.right + 1; })()`), "the active tab is scrolled into view");

      // Keep titles: wider tabs, a scrolling strip.
      const settings = await k.invoke("get_settings");
      await k.invoke("update_settings", { settings: { ...settings, tab_overflow: "scroll" } });
      await toolbar.waitFor(`document.documentElement.classList.contains('tabs-scroll')`);
      const wide = await toolbar.evaluate(`(() => { const s = document.getElementById('tabs'); return { over: s.scrollWidth > s.clientWidth + 1, min: Math.min(...[...s.querySelectorAll('.tab')].map(t => t.getBoundingClientRect().width)) }; })()`);
      assert(wide.min >= 149 && wide.over, `titles kept (${Math.round(wide.min)}px) and the strip scrolls`);

      // Vertical: the strip becomes a column, and the page moves right of it.
      await command(toolbar, "close-other-tabs");
      await waitFor(async () => (await k.tabs()).length === 1, { message: "one tab left" });
      await openTabs(k, site, waitFor, ["V1", "V2"]);
      const before = await toolbar.evaluate(`document.getElementById('rail').getBoundingClientRect().right`);
      await k.invoke("update_settings", { settings: { ...(await k.invoke("get_settings")), tab_layout: "vertical" } });
      await toolbar.waitFor(`!document.getElementById('vtabs').hidden && document.getElementById('vtabs-list').contains(document.getElementById('tabs'))`, { message: "tabs in the column" });
      const col = await toolbar.evaluate(`document.getElementById('vtabs').getBoundingClientRect().right`);
      assert(col > before + 150, `a column beside the rail (${Math.round(col)}px)`);
      const tabsInColumn = await toolbar.evaluate(`(() => { const t = [...document.querySelectorAll('.tab')].slice(0, 3).map(e => e.getBoundingClientRect()); return t[1].top > t[0].top && t[2].top > t[1].top; })()`);
      assert(tabsInColumn, "tabs one under another");
      // The page's webview moved: the active page is as wide as what's left.
      const active = await k.activeTab();
      const page = await k.page(`${site.origin}/page/V2`);
      const pageWidth = await page.evaluate(`window.innerWidth`);
      const toolbarWidth = await toolbar.evaluate(`window.innerWidth`);
      assert(pageWidth <= toolbarWidth - col + 2, `the page starts after the column (page ${pageWidth}px, window ${toolbarWidth}px, column ends ${Math.round(col)}px; tab ${active.id})`);
      // Collapsed to icons.
      await toolbar.clickSelector("#vtabs-collapse");
      await toolbar.waitFor(`document.documentElement.classList.contains('vtabs-collapsed') && document.getElementById('vtabs').getBoundingClientRect().width < 70`, { message: "collapsed" });
      await command(toolbar, "toggle-vertical-tabs");
      await toolbar.waitFor(`document.getElementById('vtabs').hidden && document.getElementById('tab-bar').contains(document.getElementById('tabs'))`, { message: "back on top" });
    },
  },
];
