// Windows of your own (browser_windows.rs set_window_name, saved_sessions.rs):
// a window's name -- in its tab bar, its title, and back with the session;
// saved sessions -- saved, listed in History, opened again, and what Kessel
// starts with.

async function open(k, url, window = null) {
  const [tab] = await k.tabs(window);
  await k.invoke("navigate", { id: tab.id, url }, { window });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return tab.id;
}

const shownName = (toolbar) => toolbar.evaluate(`(() => { const c = document.getElementById('window-name'); return c.hidden ? null : c.textContent; })()`);

export const tests = [
  {
    name: "a window of your own name: in its tab bar and title, and back with the session",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ keepProfile: true, settings: { restore_tabs: true } });
      await open(k, `${site.origin}/page/Named`);
      const toolbar = await k.toolbar();
      assert.equal(await shownName(toolbar), null, "no name to begin with");
      await k.invoke("run_command", { id: "name-window" });
      await toolbar.waitFor(`!!document.getElementById('window-name-input')`, { message: "a box to name it" });
      await toolbar.evaluate(`(() => { const i = document.getElementById('window-name-input'); i.value = '  Taxes 2026 '; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await waitFor(async () => (await shownName(toolbar)) === "Taxes 2026", { message: "the name in the tab bar" });
      assert.equal((await k.invoke("get_windows")).find((w) => w.current)?.name, "Taxes 2026", "and in the list of windows");
      assert.equal(await toolbar.evaluate(`window.__TAURI__.window.getCurrentWindow().title()`), "Taxes 2026 – Kessel", "the window's title");
      await waitFor(() => (k.readProfileFile("Data/session.json") || "").includes(`"name":"Taxes 2026"`), { message: "saved with the session" });
      // The command palette's "Save this window as a session": under its name.
      await k.invoke("run_command", { id: "save-window-session" });
      await waitFor(async () => (await k.invoke("list_saved_sessions")).some((s) => s.name === "Taxes 2026" && s.windows.length === 1 && s.tabs === 1), { message: "this window saved under its name" });

      const again = await launch({ profileDir: (await k.close({ keepProfile: true }), k.profileDir) });
      const back = await again.toolbar();
      await waitFor(async () => (await shownName(back)) === "Taxes 2026", { message: "the name back after a restart" });
      assert((await again.tabs()).some((t) => t.url === `${site.origin}/page/Named`), "with its tab");
      assert.equal(await back.evaluate(`window.__TAURI__.window.getCurrentWindow().title()`), "Taxes 2026 – Kessel", "and its title");

      // Cleared: just Kessel again.
      await again.invoke("set_window_name", { name: "" });
      await waitFor(async () => (await shownName(back)) === null, { message: "no name" });
      assert.equal(await back.evaluate(`window.__TAURI__.window.getCurrentWindow().title()`), "Kessel", "Kessel's own title");
    },
  },
  {
    name: "saved sessions: saved, listed in History, opened again -- and what Kessel starts with",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ keepProfile: true });
      await open(k, `${site.origin}/page/One`);
      // A tab group in the first window: it comes back with the session.
      const toolbar = await k.toolbar();
      const three = await k.createTab(`${site.origin}/page/Three`);
      await toolbar.evaluate(`window.__kesselTest.tabMenu(${three}, "Add tab to new group")`);
      const group = await waitFor(async () => (await toolbar.evaluate(`window.__kesselTest.groups()`))[0], { message: "a group" });
      await toolbar.evaluate(`window.__kesselTest.renameGroup(${JSON.stringify(group.id)}, "Docs")`);
      await k.invoke("new_window", { private: false, url: `${site.origin}/page/Two` });
      await waitFor(async () => (await k.windows()).length === 2, { message: "a second window" });
      await waitFor(() => {
        const s = k.readProfileFile("Data/session.json") || "";
        return s.includes("/page/One") && s.includes("/page/Three") && s.includes(`"name":"Docs"`) && s.includes("/page/Two");
      }, { message: "both windows' tabs known" });
      await k.invoke("set_window_name", { name: "Reading" }, { window: "win-2" });
      const work = await k.invoke("save_session", { name: "Work" });
      assert.equal(work.tabs, 3, "every tab");
      assert.deepEqual(work.windows.map((w) => w.name), [null, "Reading"], "both windows, the second with its name");

      // History -> Saved sessions
      await k.invoke("open_singleton_tab", { route: "kessel://history/sessions" });
      const history = await k.page((t) => t.url.includes("history.html"));
      const rows = `[...document.querySelectorAll('[data-session]')]`;
      await history.waitFor(`${rows}.some((r) => r.querySelector('.title').textContent === 'Work')`, { message: "listed in History" });
      const host = await history.evaluate(`${rows}[0].querySelector('.host').textContent`);
      assert(/^2 windows, 3 tabs/.test(host), `its windows and tabs: ${host}`);
      await history.evaluate(`(() => { document.getElementById('session-name').value = 'Evening'; document.getElementById('save-session-btn').click(); })()`);
      await history.waitFor(`${rows}.length === 2 && ${rows}[0].querySelector('.title').textContent === 'Evening'`, { message: "saved from the page, newest first" });
      const evening = (await k.invoke("list_saved_sessions"))[0];
      await k.invoke("rename_saved_session", { id: evening.id, name: "Late" });
      await k.invoke("delete_saved_session", { id: evening.id });
      assert.deepEqual((await k.invoke("list_saved_sessions")).map((s) => s.name), ["Work"], "renamed, then deleted");

      // Opened again: its two windows.
      await history.evaluate(`(() => { location.reload(); })()`);
      await history.waitFor(`document.readyState === 'complete' && ${rows}.length === 1`, { message: "the page again" });
      await history.evaluate(`${rows}[0].querySelector('[data-open]').click()`);
      await waitFor(async () => (await k.windows()).length === 4, { message: "two more windows" });
      const named = (await k.invoke("get_windows")).filter((w) => w.name === "Reading");
      assert.equal(named.length, 2, "the second one with its name again");
      await waitFor(async () => (await k.tabs(named.find((w) => w.label !== "win-2").label)).some((t) => t.url === `${site.origin}/page/Two`), { message: "with its tab" });

      // What Kessel starts with: Settings -> Search & Startup.
      await k.invoke("open_singleton_tab", { route: "kessel://settings/search" });
      const settingsPage = await k.page((t) => t.url.includes("settings.html"));
      await settingsPage.waitFor(`[...document.querySelectorAll('#startup-session option')].some((o) => o.textContent === 'Work')`, { message: "the saved session to start with" });
      await settingsPage.evaluate(`(() => { const s = document.getElementById('startup-session'); s.value = ${JSON.stringify(work.id)}; s.dispatchEvent(new Event('change')); })()`);
      await waitFor(async () => (await k.invoke("get_settings")).features.startup_session === work.id, { message: "picked" });
      const again = await launch({ profileDir: (await k.close({ keepProfile: true }), k.profileDir) });
      await waitFor(async () => (await again.windows()).length === 2, { message: "its two windows at startup" });
      const everyTab = async () => {
        const urls = [];
        for (const w of await again.windows()) urls.push(...(await again.tabs(w)).map((t) => t.url));
        return urls.sort();
      };
      const wanted = [`${site.origin}/page/One`, `${site.origin}/page/Three`, `${site.origin}/page/Two`];
      await waitFor(async () => JSON.stringify(await everyTab()) === JSON.stringify(wanted), { message: "with their tabs" }).catch(async (e) => {
        throw new Error(`${e.message}: ${JSON.stringify(await everyTab())}`);
      });
      const groups = await waitFor(async () => {
        for (const w of await again.toolbars()) {
          const g = await w.page.evaluate(`window.__kesselTest.groups()`);
          if (g.length) return g;
        }
      }, { message: "its tab group" });
      assert.equal(groups[0].name, "Docs", "the group, by its name");

      // Deleted: no longer what it starts with.
      await again.invoke("delete_saved_session", { id: work.id });
      assert.equal((await again.invoke("get_settings")).features.startup_session, undefined, "the startup choice cleared");
    },
  },
];
