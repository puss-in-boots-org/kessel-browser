// Several browser windows: new and private windows, tabs moving between
// windows without reloading, closing and reopening windows, and the
// session coming back window by window.

async function openInTab(k, window, id, url) {
  await k.invoke("navigate", { id, url }, { window });
  return k.page(url);
}

export const tests = [
  {
    name: "Ctrl+N's command opens a second window with its own tab",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const label = await k.invoke("new_window", { private: false });
      assert.equal(label, "win-2", "second window's label");
      await waitFor(async () => (await k.windows()).length === 2, { message: "two windows" });
      const tabs = await waitFor(async () => {
        const t = await k.tabs("win-2");
        return t.length === 1 && t;
      }, { message: "a tab in the new window" });
      assert.equal(tabs[0].url, "kessel://newtab", "new window starts on the new-tab page");
      assert.equal((await k.tabs("win-1")).length, 1, "first window still has its own single tab");
    },
  },
  {
    name: "a private window's visits stay out of history",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      await k.invoke("new_window", { private: true });
      const privateWin = await waitFor(async () => (await k.toolbars()).find((t) => t.private), { message: "a private window" });
      assert(await privateWin.page.evaluate(`!document.getElementById("private-badge").hidden`), "private window shows its badge");
      assert(await (await k.toolbar("win-1")).evaluate(`document.getElementById("private-badge").hidden`), "a normal window doesn't");
      const [tab] = await waitFor(async () => {
        const t = await k.tabs(privateWin.label);
        return t.length && t;
      });
      await openInTab(k, privateWin.label, tab.id, `${site.origin}/page/Secret`);
      await waitFor(async () => (await k.tabs(privateWin.label))[0].title === "Secret", { message: "private tab loaded" });
      // And a normal visit, which must be recorded, for comparison.
      const [normal] = await k.tabs("win-1");
      await openInTab(k, "win-1", normal.id, `${site.origin}/page/Public`);
      await waitFor(async () => (await k.invoke("get_history")).some((h) => h.url.includes("/page/Public")), { message: "normal visit in history" });
      await sleep(300);
      const history = await k.invoke("get_history");
      assert(!history.some((h) => h.url.includes("/page/Secret")), "private visit is not in history");
    },
  },
  {
    name: "a tab moves to a new window without reloading",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await k.createTab(`${site.origin}/page/Mover`);
      const page = await k.page(`${site.origin}/page/Mover`);
      await page.waitFor(`document.readyState === 'complete'`);
      await page.evaluate(`window.__keptAlive = 42`);
      const mover = await waitFor(async () => (await k.tabs()).find((t) => t.url.includes("/page/Mover")), { message: "the tab in the strip" });

      const win = await k.invoke("move_tab_to_new_window", { id: mover.id });
      const moved = await waitFor(async () => {
        const t = await k.tabs(win).catch(() => []);
        return t.length === 1 && t[0];
      }, { message: "the tab in the new window" });
      assert.equal(moved.id, mover.id, "same tab (same webview) in the new window");
      assert(moved.active, "it's the new window's active tab");
      assert.equal(await page.evaluate(`window.__keptAlive`), 42, "page wasn't reloaded");
      const left = await k.tabs("win-1");
      assert.equal(left.length, 1, "the first window kept its other tab");
      assert(!left.some((t) => t.id === mover.id), "and no longer shows the moved one");
    },
  },
  {
    name: "a tab sent to another window shows up there",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await k.invoke("new_window", { private: false });
      await waitFor(async () => (await k.tabs("win-2").catch(() => [])).length === 1, { message: "second window's tab" });
      await k.createTab(`${site.origin}/page/Traveller`, { window: "win-1" });
      const traveller = await waitFor(async () => (await k.tabs("win-1")).find((t) => t.url.includes("Traveller")), { message: "tab to send" });
      await k.invoke("send_tab_to_window", { id: traveller.id, target: "win-2" }, { window: "win-1" });
      const there = await waitFor(async () => (await k.tabs("win-2")).find((t) => t.id === traveller.id && t.active), { message: "tab arrived and active" });
      assert(there.active, "it's active where it arrived");
      await waitFor(async () => !(await k.tabs("win-1")).some((t) => t.id === traveller.id), { message: "tab gone from the first window" });
    },
  },
  {
    name: "a tab dropped on another window's strip moves there",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await k.createTab(`${site.origin}/page/Dropped`);
      const dropped = await waitFor(async () => (await k.tabs("win-1")).find((t) => t.url.includes("Dropped")), { message: "tab to drag" });
      await k.invoke("new_window", { private: false });
      await waitFor(async () => (await k.tabs("win-2").catch(() => [])).length === 1, { message: "second window" });
      // What the second window's drop handler does with the dragged tab's id.
      const info = await k.invoke("adopt_tab", { id: dropped.id }, { window: "win-2" });
      assert.equal(info.id, dropped.id, "adopt_tab hands back the same tab");
      assert(info.url.includes("/page/Dropped"), "with its address");
      await waitFor(async () => !(await k.tabs("win-1")).some((t) => t.id === dropped.id), { message: "gone from the first window" });
    },
  },
  {
    name: "tabs can't move between private and normal windows",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      await k.invoke("new_window", { private: true });
      const privateWin = await waitFor(async () => (await k.toolbars()).find((t) => t.private), { message: "a private window" });
      const [privateTab] = await waitFor(async () => {
        const t = await k.tabs(privateWin.label);
        return t.length && t;
      });
      let error = null;
      await k.invoke("adopt_tab", { id: privateTab.id }, { window: "win-1" }).catch((e) => (error = String(e)));
      assert(error && error.includes("private"), "refused with a reason");
      assert.equal((await k.tabs(privateWin.label)).length, 1, "the private tab stayed put");
    },
  },
  {
    name: "a closed window reopens with its tabs",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const win = await k.invoke("new_window", { private: false, url: `${site.origin}/page/One` });
      await waitFor(async () => (await k.tabs(win).catch(() => [])).length === 1, { message: "window with one tab" });
      await k.createTab(`${site.origin}/page/Two`, { window: win });
      await waitFor(async () => (await k.tabs(win)).filter((t) => t.title === "One" || t.title === "Two").length === 2, { message: "both tabs loaded" });
      await (await k.toolbar(win)).evaluate(`new Promise(r => setTimeout(r, 400))`); // let its snapshot reach Rust
      // Its toolbar goes away mid-call, so the call itself may never answer.
      k.invoke("close_window", {}, { window: win }).catch(() => {});
      await waitFor(async () => !(await k.windows()).includes(win), { message: "window closed" });
      const closed = await k.invoke("get_closed_windows");
      assert.equal(closed.length, 1, "one closed window remembered");
      const reopened = await k.invoke("reopen_closed_window", {});
      const tabs = await waitFor(async () => {
        const t = await k.tabs(reopened).catch(() => []);
        return t.length === 2 && t;
      }, { message: "reopened window with both tabs" });
      assert(tabs.some((t) => t.url.includes("/page/One")) && tabs.some((t) => t.url.includes("/page/Two")), "both pages are back");
    },
  },
  {
    name: "every window of the session comes back after a restart",
    async run({ launch, site, assert, waitFor }) {
      let k = await launch({ settings: { restore_tabs: true }, keepProfile: true });
      const [first] = await k.tabs("win-1");
      await openInTab(k, "win-1", first.id, `${site.origin}/page/Alpha`);
      const win2 = await k.invoke("new_window", { private: false, url: `${site.origin}/page/Beta` });
      await waitFor(async () => (await k.tabs(win2).catch(() => [])).some((t) => t.title === "Beta"), { message: "second window loaded" });
      await waitFor(async () => {
        const saved = JSON.parse(k.readProfileFile("Data/session.json") || "{}");
        return saved.windows?.length === 2;
      }, { message: "both windows in session.json" });
      const profileDir = k.profileDir;
      await k.close({ keepProfile: true });

      k = await launch({ profileDir });
      try {
        const labels = await waitFor(async () => {
          const w = await k.windows();
          return w.length === 2 && w;
        }, { message: "two windows restored" });
        // Each restored window opens its tabs once its toolbar has loaded.
        const perWindow = await waitFor(async () => {
          const lists = [await k.tabs(labels[0]), await k.tabs(labels[1])];
          return lists.every((l) => l.length) && lists;
        }, { message: "both windows' tabs" });
        const has = (list, page) => list.some((t) => t.url.includes(page));
        assert(perWindow.some((l) => has(l, "/page/Alpha")), "Alpha restored");
        assert(perWindow.some((l) => has(l, "/page/Beta")), "Beta restored");
        assert(!perWindow.some((l) => has(l, "/page/Alpha") && has(l, "/page/Beta")), "each in its own window");
      } finally {
        await k.close({ keepProfile: false });
      }
    },
  },
];
