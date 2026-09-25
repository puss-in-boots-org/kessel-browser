// Every shortcut of the requested table, through Kessel's real key path:
// k.press() hands a key to commands.rs exactly as WebView2's
// AcceleratorKeyPressed does (or, with page: true, as a page's script hands
// back a key it didn't use); page.key() sends a DevTools key event into the
// page itself, so the page script's hand-back is tested too. The keys the
// engine handles on its own (scrolling, copy/paste, undo) are pressed for
// real through Windows (realkeys.ps1).
//
// One DevTools quirk: a key it injects skips WebView2's "browser keys off"
// setting, so the engine itself also reloads on F5 / Ctrl+R, goes back on
// Alt+Left and zooms on Ctrl+Plus. Those are tested with k.press() -- and
// with real key presses, which show each happens exactly once.

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Tab `id` (default: the first tab) showing /page/<name>, loaded.
async function openPage(k, site, name, { id = null, window = null } = {}) {
  id = id ?? (await k.tabs(window))[0].id;
  const url = `${site.origin}/page/${encodeURIComponent(name)}`;
  await k.invoke("navigate", { id, url }, { window });
  const page = await k.page(url);
  await page.waitFor(`document.readyState === 'complete' && document.title === ${JSON.stringify(name)}`);
  return { id, page, url };
}

async function tabCount(k, window = null) {
  return (await k.tabs(window)).length;
}

export const tests = [
  // --- Page and navigation ---------------------------------------------------
  {
    name: "F5 and Ctrl+R reload the page",
    async run({ launch, site, assert }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "Reloader");
      await page.evaluate(`window.__mark = 1`);
      assert(await k.press("F5", { tab: id, page: true }), "F5 is Kessel's");
      await page.waitFor(`window.__mark === undefined && document.readyState === 'complete'`, { message: "reloaded by F5" });
      await page.evaluate(`window.__mark = 2`);
      await k.press("Ctrl+R", { tab: id, page: true });
      await page.waitFor(`window.__mark === undefined && document.readyState === 'complete'`, { message: "reloaded by Ctrl+R" });
    },
  },
  {
    name: "a page that uses a key itself keeps it (F5 in a web app)",
    async run({ launch, site, assert, sleep }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "App");
      await page.evaluate(`window.__mark = 1; addEventListener('keydown', e => { if (e.key === 'F5') { e.preventDefault(); window.__f5 = true; } })`);
      // A real key press, through Windows (a key injected through DevTools
      // runs the engine's own F5 whatever the page does).
      await k.invoke("page_action", { id, action: "focus", value: null });
      k.realKeys(["F5"]);
      await sleep(800);
      assert.equal(await page.evaluate(`window.__f5 === true && window.__mark === 1`), true, "the page got F5 and wasn't reloaded");
    },
  },
  {
    name: "Ctrl+F5 reloads without the cache",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const [tab] = await k.tabs();
      const url = `${site.origin}/echo-headers`;
      await k.invoke("navigate", { id: tab.id, url });
      const page = await k.page(url);
      await page.waitFor(`document.readyState === 'complete' && document.body && document.body.innerText.includes('{')`);
      const headers = () => page.evaluate(`JSON.parse(document.body.innerText)`);
      await page.evaluate(`window.__mark = 1`);
      await k.press("Ctrl+F5", { tab: tab.id, page: true });
      await page.waitFor(`window.__mark === undefined && document.readyState === 'complete' && document.body.innerText.includes('{')`, { message: "hard reload" });
      const hard = await headers();
      assert.equal(hard["cache-control"], "no-cache", "a hard reload asks for a fresh copy");
      assert.equal(hard["pragma"], "no-cache", "for old servers too");
      await page.evaluate(`window.__mark = 1`);
      await k.press("F5", { tab: tab.id, page: true });
      await page.waitFor(`window.__mark === undefined && document.readyState === 'complete' && document.body.innerText.includes('{')`, { message: "normal reload" });
      const normal = await waitFor(headers);
      assert(normal["cache-control"] !== "no-cache", "a normal reload may use the cache");
    },
  },
  {
    name: "Alt+Left and Alt+Right go back and forward",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "First");
      await openPage(k, site, "Second", { id });
      await k.press("Alt+Left", { tab: id, page: true });
      await waitFor(async () => (await k.activeTab()).title === "First", { message: "back to First" });
      await (await k.page(`/page/First`)).waitFor(`document.readyState === 'complete'`);
      await k.press("Alt+Right", { tab: id, page: true });
      await waitFor(async () => (await k.activeTab()).title === "Second", { message: "forward to Second" });
    },
  },
  {
    name: "Alt+Home goes to the home page",
    async run({ launch, site, waitFor }) {
      const k = await launch({ settings: { homepage: `${site.origin}/page/Home` } });
      const { id } = await openPage(k, site, "Elsewhere");
      await k.press("Alt+Home", { tab: id, page: true });
      await waitFor(async () => (await k.activeTab()).title === "Home", { message: "on the home page" });
    },
  },
  {
    name: "Escape stops a page that's loading, and only then",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "Before");
      await page.evaluate(`window.__mark = 1`);
      // Not loading: Escape stays the page's (it closes the page's own dialogs).
      assert.equal(await k.press("Escape", { tab: id }), false, "Escape isn't taken from a page that isn't loading");
      k.invoke("navigate", { id, url: `${site.origin}/slow/4000/Slow` });
      await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.loading, { message: "loading" });
      await k.press("Escape", { tab: id, page: true });
      await waitFor(async () => !(await k.tabs()).find((t) => t.id === id)?.loading, { message: "stopped" });
      await sleep(4500);
      assert((await k.activeTab()).title !== "Slow", "the slow page never replaced the old one");
    },
  },
  {
    name: "F6, Ctrl+L and Alt+D select the address bar",
    async run({ launch, site, assert }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "Focus");
      const toolbar = await k.toolbar();
      for (const keys of ["F6", "Ctrl+L", "Alt+D"]) {
        await toolbar.evaluate(`document.activeElement.blur()`);
        if (keys === "Ctrl+L") await page.key("Ctrl+L");
        else await k.press(keys, { tab: id, page: true });
        await toolbar.waitFor(
          `(() => { const i = document.getElementById('url-input'); return document.activeElement === i && i.selectionStart === 0 && i.selectionEnd === i.value.length && i.value.includes('/page/Focus'); })()`,
          { message: `${keys}: address selected` },
        );
      }
      assert(true, "all three");
    },
  },
  {
    name: "Ctrl+E and Ctrl+K start a search in the address bar",
    async run({ launch, site }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Searchy");
      const toolbar = await k.toolbar();
      for (const keys of ["Ctrl+E", "Ctrl+K"]) {
        await toolbar.evaluate(`document.activeElement.blur()`);
        await k.press(keys, { tab: id, page: true });
        await toolbar.waitFor(`(() => { const i = document.getElementById('url-input'); return document.activeElement === i && i.value === '? '; })()`, { message: `${keys}: search started` });
      }
    },
  },
  {
    name: "F11 turns full screen on and off",
    async run({ launch, site, assert }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Wide");
      const toolbar = await k.toolbar();
      assert(await k.press("F11", { tab: id }), "F11 is always Kessel's");
      await toolbar.waitFor(`document.documentElement.classList.contains('fullscreen') && window.__TAURI__.window.getCurrentWindow().isFullscreen()`, { message: "full screen" });
      await k.press("F11", { tab: id });
      await toolbar.waitFor(`(async () => !document.documentElement.classList.contains('fullscreen') && !(await window.__TAURI__.window.getCurrentWindow().isFullscreen()))()`, { message: "back to normal" });
    },
  },

  // --- Bookmarks, find, help ----------------------------------------------------
  {
    name: "Ctrl+D bookmarks the page",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id, url } = await openPage(k, site, "Keeper");
      await k.press("Ctrl+D", { tab: id, page: true });
      await waitFor(async () => (await k.invoke("get_bookmarks")).some((b) => b.url === url && b.title === "Keeper"), { message: "bookmarked" });
    },
  },
  {
    name: "F1 opens Help -- once -- with every shortcut",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Lost");
      await k.press("F1", { tab: id, page: true });
      const help = await waitFor(async () => (await k.tabs()).find((t) => t.url === "kessel://help" && t.active), { message: "a Help tab" });
      const page = await k.page("help.html");
      await page.waitFor(`document.querySelectorAll('#shortcuts .line').length > 40`, { message: "the shortcut list" });
      assert(await page.evaluate(`document.getElementById('shortcuts').innerText.includes('Reopen closed tab')`), "lists Kessel's commands");
      assert(await page.evaluate(`document.getElementById('about').innerText.includes('WebView2')`), "and the versions");
      await k.press("F1", { tab: id, page: true });
      await waitFor(async () => (await k.activeTab()).id === help.id, { message: "the same Help tab again" });
      assert.equal((await k.tabs()).filter((t) => t.url.startsWith("kessel://help")).length, 1, "no second Help tab");
    },
  },
  {
    name: "Ctrl+F finds the selected text; F3, Ctrl+G, Shift+F3 and Ctrl+Shift+G step through the matches",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "Findable");
      await page.evaluate(`(() => { const r = document.createRange(); const t = document.getElementById('p3').firstChild; const i = t.data.indexOf('lazy dog'); r.setStart(t, i); r.setEnd(t, i + 8); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
      // As the page hands back a key it doesn't use (a key injected through
      // DevTools now and then never reaches the page at all).
      await k.press("Ctrl+F", { tab: id, page: true });
      const status = () => k.invoke("page_find_status", { id });
      const first = await waitFor(async () => {
        const s = await status();
        return s.count > 0 && s;
      }, { message: "matches found" });
      assert.equal(first.count, 120, "every paragraph's 'lazy dog'");
      const step = async (keys, expected) => {
        await k.press(keys, { tab: id, page: true });
        await waitFor(async () => (await status()).active === expected, { message: `${keys} -> match ${expected}` });
      };
      const start = first.active;
      await step("F3", (start + 1) % 120);
      await step("Ctrl+G", (start + 2) % 120);
      await step("Shift+F3", (start + 1) % 120);
      await step("Ctrl+Shift+G", start);
    },
  },

  // --- Browser pages ----------------------------------------------------------
  {
    name: "Ctrl+H opens History: your visits, searchable, deletable",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Alpha Page");
      await openPage(k, site, "Beta Page", { id });
      await waitFor(async () => (await k.invoke("get_history")).some((h) => h.title === "Beta Page"), { message: "visits recorded with titles" });
      await k.press("Ctrl+H", { tab: id, page: true });
      await waitFor(async () => (await k.activeTab())?.url === "kessel://history", { message: "History tab" });
      const history = await k.page("history.html");
      await history.waitFor(`[...document.querySelectorAll('.visit .title')].map(a => a.textContent).join('|').includes('Beta Page')`, { message: "visits listed" });
      assert(await history.evaluate(`document.querySelector('.day').textContent.startsWith('Today')`), "grouped under Today");
      await history.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'alpha'; q.dispatchEvent(new Event('input')); })()`);
      await history.waitFor(`(() => { const t = [...document.querySelectorAll('.visit .title')].map(a => a.textContent); return t.length === 1 && t[0] === 'Alpha Page'; })()`, { message: "search narrows it to Alpha" });
      // Remove it from the row's menu.
      await history.clickSelector(`.visit .row-btn`);
      await history.evaluate(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Remove from history')).click()`);
      await waitFor(async () => !(await k.invoke("get_history")).some((h) => h.title === "Alpha Page"), { message: "Alpha removed from history" });
      assert((await k.invoke("get_history")).some((h) => h.title === "Beta Page"), "Beta is still there");
    },
  },
  {
    name: "History by site, and deleting a whole site",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "One");
      await openPage(k, site, "Two", { id });
      await waitFor(async () => (await k.invoke("get_history")).length >= 2);
      const sites = await k.invoke("history_sites", {});
      const mine = sites.find((s) => s.host === "127.0.0.2");
      assert(mine && mine.visits >= 2, "the test site with its visits");
      await k.press("Ctrl+H", { tab: id, page: true });
      const history = await k.page("history.html");
      await history.waitFor(`document.querySelectorAll('.visit').length >= 2`);
      await history.evaluate(`document.querySelector('.nav-item[data-view=sites]').click()`);
      await history.waitFor(`[...document.querySelectorAll('.visit .title')].some(a => a.textContent === '127.0.0.2')`, { message: "the site listed" });
      const n = await history.evaluate(`window.__TAURI__.core.invoke('delete_history', { site: '127.0.0.2' })`);
      assert(n >= 2, "its visits deleted");
      assert(!(await k.invoke("get_history")).some((h) => h.url.includes("127.0.0.2")), "none left");
    },
  },
  {
    name: "History lists your searches and what you closed, and reopens it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await k.invoke("test_record_visit", { url: "https://www.google.com/search?q=kessel+browser&hl=en", title: "kessel browser - Google Search" });
      await k.invoke("test_record_visit", { url: "https://www.youtube.com/results?search_query=lofi+beats", title: "lofi beats - YouTube" });
      const { id } = await openPage(k, site, "Closed Later");
      await k.createTab(`${site.origin}/page/Keeper`);
      await waitFor(async () => (await k.tabs()).length === 2);
      await (await k.toolbar()).evaluate(`window.__kesselTest.closeTab(${id})`);
      await waitFor(async () => (await k.tabs()).length === 1, { message: "tab closed" });

      await k.invoke("open_singleton_tab", { route: "kessel://history" });
      const history = await k.page("history.html");
      await history.waitFor(`document.querySelectorAll('.visit').length > 0`);
      await history.evaluate(`document.querySelector('.nav-item[data-view=searches]').click()`);
      await history.waitFor(`(() => { const t = [...document.querySelectorAll('.visit .title')].map(a => a.textContent); return t.includes('kessel browser') && t.includes('lofi beats'); })()`, { message: "both searches listed" });
      assert(await history.evaluate(`document.body.innerText.includes('YouTube')`), "with where you searched");

      await history.evaluate(`document.querySelector('.nav-item[data-view=closed]').click()`);
      await history.waitFor(`[...document.querySelectorAll('.visit .title')].some(t => t.textContent === 'Closed Later')`, { message: "the closed tab listed" });
      await history.evaluate(`[...document.querySelectorAll('.visit')].find(r => r.querySelector('.title').textContent === 'Closed Later').querySelector('button').click()`);
      await waitFor(async () => (await k.tabs()).some((t) => t.url.includes("/page/Closed%20Later")), { message: "reopened" });
    },
  },
  {
    name: "websites can't read or delete your history",
    async run({ launch, site, assert }) {
      const k = await launch();
      const { page } = await openPage(k, site, "Snoop");
      const hasIpc = await page.evaluate(`typeof window.__TAURI__ !== 'undefined' && !!window.__TAURI__.core`);
      if (hasIpc) {
        let error = null;
        await page.evaluate(`window.__TAURI__.core.invoke('query_history', {})`).catch((e) => (error = String(e)));
        assert(error, "refused");
      } else {
        assert(true, "no IPC at all on websites");
      }
    },
  },
  {
    name: "Ctrl+J opens Downloads",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Files");
      await k.press("Ctrl+J", { tab: id, page: true });
      await waitFor(async () => (await k.activeTab())?.url === "kessel://downloads", { message: "Downloads tab" });
    },
  },
  {
    name: "Ctrl+O opens a file from this PC",
    async run({ launch, waitFor }) {
      const dir = mkdtempSync(path.join(tmpdir(), "kessel-file-"));
      const file = path.join(dir, "local page.html");
      writeFileSync(file, `<!doctype html><title>Local File</title><p>Hello from disk</p>`);
      const k = await launch({ env: { KESSEL_TEST_OPEN_FILE: file } });
      const [tab] = await k.tabs();
      await k.press("Ctrl+O", { tab: tab.id, page: true });
      await waitFor(async () => (await k.tabs()).some((t) => t.url.startsWith("file:///") && t.title === "Local File" && t.active), { message: "the file in a new tab" });
    },
  },
  {
    name: "Ctrl+U shows the page's source",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id, url } = await openPage(k, site, "Sourcey");
      await k.press("Ctrl+U", { tab: id, page: true });
      await waitFor(async () => (await k.tabs()).some((t) => t.url === `view-source:${url}` && t.active), { message: "a view-source tab" });
      const source = await k.page((t) => t.url === `view-source:${url}`);
      await source.waitFor(`document.body && document.body.innerText.includes('<title>Sourcey</title>')`, { message: "the page's HTML" });
      assert(true, "shown");
    },
  },
  {
    name: "F12 opens the developer tools",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Inspect");
      await k.press("F12", { tab: id, page: true });
      await waitFor(async () => (await (await fetch(`http://127.0.0.1:${k.port}/json/list`)).json()).some((t) => t.url.startsWith("devtools://")), { message: "a DevTools window" });
    },
  },
  {
    name: "Ctrl+P opens the print preview",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Printable");
      await k.press("Ctrl+P", { tab: id, page: true });
      await waitFor(async () => (await (await fetch(`http://127.0.0.1:${k.port}/json/list`)).json()).some((t) => t.url.startsWith("edge://print")), { message: "the print preview" });
    },
  },
  {
    name: "Ctrl+S opens Save As",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Savable");
      const before = k.dialogs().length;
      await k.press("Ctrl+S", { tab: id, page: true });
      await waitFor(() => k.dialogs().length > before, { message: "a Save As dialog", interval: 400 });
    },
  },
  {
    name: "in the address bar: Alt+Enter opens a new tab, Shift+Enter a new window, Ctrl+Enter adds www. and .com, Escape undoes",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const toolbar = await k.toolbar();
      const typeInto = (text) => toolbar.evaluate(`(() => { const i = document.getElementById('url-input'); i.focus(); i.value = ${JSON.stringify(text)}; })()`);

      await typeInto(`${site.origin}/page/Tabbed`);
      await toolbar.key("Alt+Enter");
      await waitFor(async () => {
        const tabs = await k.tabs();
        return tabs.length === 2 && tabs.some((t) => t.title === "Tabbed" && t.active);
      }, { message: "Alt+Enter: a new tab, in front" });

      await typeInto(`${site.origin}/page/Windowed`);
      await toolbar.key("Shift+Enter");
      await waitFor(async () => (await k.windows()).length === 2, { message: "Shift+Enter: a new window" });
      const other = (await k.windows()).find((w) => w !== "win-1");
      await waitFor(async () => (await k.tabs(other)).some((t) => t.title === "Windowed"), { message: "showing the page" });

      await typeInto("kessel-e2e-nowhere");
      await toolbar.key("Ctrl+Enter");
      await waitFor(async () => ((await k.activeTab("win-1")).url || "").startsWith("https://www.kessel-e2e-nowhere.com"), { message: "Ctrl+Enter: www. and .com added" });

      // Escape: first back to the page's address, then out of the address bar.
      const shown = (await k.activeTab("win-1")).url;
      await typeInto("something half typed");
      await toolbar.key("Escape");
      assert.equal(await toolbar.evaluate(`document.getElementById('url-input').value`), shown, "Escape put the address back");
      await toolbar.key("Escape");
      await toolbar.waitFor(`document.activeElement !== document.getElementById('url-input')`, { message: "a second Escape leaves the address bar" });
    },
  },
  {
    name: "Ctrl+Shift+Del opens Clear browsing data, which clears history",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Forget Me");
      await waitFor(async () => (await k.invoke("get_history")).some((h) => h.title === "Forget Me"));
      await k.press("Ctrl+Shift+Delete", { tab: id, page: true });
      await waitFor(async () => (await k.activeTab())?.url?.startsWith("kessel://settings"), { message: "Settings" });
      const settings = await k.page("settings.html");
      await settings.waitFor(`!!document.querySelector('.clear-modal')`, { message: "the dialog" });
      await settings.evaluate(`document.getElementById('clear-range').value = 'all'`);
      await settings.evaluate(`document.getElementById('clear-go').click()`);
      await settings.waitFor(`!document.querySelector('.clear-modal')`, { message: "cleared and closed", timeout: 30000 });
      assert.equal((await k.invoke("get_history")).length, 0, "history is empty");
    },
  },
  {
    name: "Alt+F opens the Kessel menu; Escape closes it",
    async run({ launch, site, waitFor, sleep }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Menus");
      await k.press("Alt+F", { tab: id, page: true });
      const menu = await k.page("menu.html");
      await menu.waitFor(`document.querySelectorAll('.item').length > 10`, { message: "menu items" });
      // A DevTools key sent the instant the popup appears can be dropped by
      // the engine; nobody presses a key that fast.
      await sleep(300);
      await menu.key("Escape");
      await waitFor(async () => !(await k.targets()).some((t) => t.url.includes("menu.html")), { message: "menu closed" });
    },
  },

  // --- Tabs and windows --------------------------------------------------------
  {
    name: "Ctrl+T opens a tab, Ctrl+W and Ctrl+F4 close one, Ctrl+Shift+T brings it back",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Stay");
      assert(await k.press("Ctrl+T", { tab: id }), "Ctrl+T is always Kessel's");
      await waitFor(async () => (await tabCount(k)) === 2 && (await k.activeTab()).url === "kessel://newtab", { message: "a new tab, in front" });
      const second = (await k.activeTab()).id;
      await k.invoke("navigate", { id: second, url: `${site.origin}/page/Closing` });
      await waitFor(async () => (await k.activeTab()).title === "Closing");
      await k.press("Ctrl+W", { tab: second });
      await waitFor(async () => (await tabCount(k)) === 1, { message: "Ctrl+W closed it" });
      await k.press("Ctrl+Shift+T", { tab: id });
      await waitFor(async () => (await k.tabs()).some((t) => t.url.includes("/page/Closing")), { message: "reopened" });
      const again = (await k.tabs()).find((t) => t.url.includes("/page/Closing"));
      await k.press("Ctrl+F4", { tab: again.id });
      await waitFor(async () => (await tabCount(k)) === 1, { message: "Ctrl+F4 closed it" });
    },
  },
  {
    name: "Ctrl+Tab and Ctrl+Shift+Tab go round the tabs",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id: a } = await openPage(k, site, "A");
      await k.createTab(`${site.origin}/page/B`);
      await k.createTab(`${site.origin}/page/C`);
      await waitFor(async () => (await k.tabs()).filter((t) => ["A", "B", "C"].includes(t.title)).length === 3, { message: "three tabs" });
      await k.invoke("switch_tab", { id: a });
      await k.toolbar().then((t) => t.evaluate(`window.__kesselTest.activateTab(${a})`));
      const titles = [];
      for (const keys of ["Ctrl+Tab", "Ctrl+Tab", "Ctrl+Tab", "Ctrl+Shift+Tab"]) {
        const before = (await k.activeTab()).id;
        await k.press(keys, { tab: before });
        await waitFor(async () => (await k.activeTab()).id !== before, { message: keys });
        titles.push((await k.activeTab()).title);
      }
      if (titles.join(",") !== "B,C,A,C") throw new Error(`went ${titles.join(",")}`);
    },
  },
  {
    name: "Ctrl+1 ... Ctrl+8 go to that tab, Ctrl+9 to the last",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      await openPage(k, site, "T1");
      for (const n of [2, 3, 4]) await k.createTab(`${site.origin}/page/T${n}`);
      await waitFor(async () => (await k.tabs()).filter((t) => /^T\d$/.test(t.title)).length === 4, { message: "four tabs" });
      for (const [keys, title] of [["Ctrl+2", "T2"], ["Ctrl+1", "T1"], ["Ctrl+9", "T4"], ["Ctrl+3", "T3"]]) {
        await k.press(keys, { tab: (await k.activeTab()).id });
        await waitFor(async () => (await k.activeTab()).title === title, { message: `${keys} -> ${title}` });
      }
    },
  },
  {
    name: "Ctrl+N opens a new window and Alt+F4 closes it",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Main");
      await k.press("Ctrl+N", { tab: id });
      await waitFor(async () => (await k.windows()).length === 2, { message: "two windows" });
      const other = (await k.windows()).find((w) => w !== "win-1");
      await waitFor(async () => (await k.tabs(other).catch(() => [])).length === 1);
      k.press("Alt+F4", { window: other }).catch(() => {});
      await waitFor(async () => (await k.windows()).length === 1, { message: "back to one window" });
    },
  },

  {
    name: "Ctrl+Shift+N opens a private window",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Public");
      await k.press("Ctrl+Shift+N", { tab: id });
      await waitFor(async () => (await k.toolbars()).some((t) => t.private), { message: "a private window" });
    },
  },
  {
    name: "Ctrl+Shift+PgUp / PgDn move the tab; Ctrl+Shift+K duplicates it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await openPage(k, site, "One");
      await k.createTab(`${site.origin}/page/Two`);
      await k.createTab(`${site.origin}/page/Three`);
      const titles = async () => (await k.tabs()).map((t) => t.title).join(",");
      await waitFor(async () => (await titles()) === "One,Two,Three", { message: "three tabs" });
      const three = (await k.activeTab()).id;
      await k.press("Ctrl+Shift+PageUp", { tab: three, page: true });
      await waitFor(async () => (await titles()) === "One,Three,Two", { message: "moved left" });
      await k.press("Ctrl+Shift+PageUp", { tab: three, page: true });
      await waitFor(async () => (await titles()) === "Three,One,Two", { message: "moved left again" });
      await k.press("Ctrl+Shift+PageDown", { tab: three, page: true });
      await waitFor(async () => (await titles()) === "One,Three,Two", { message: "moved right" });
      await k.press("Ctrl+Shift+K", { tab: three, page: true });
      await waitFor(async () => (await k.tabs()).filter((t) => t.title === "Three").length === 2, { message: "a copy of the tab" });
      assert.equal((await k.tabs()).length, 4, "four tabs now");
    },
  },
  {
    name: "Ctrl+Shift+D bookmarks every tab; Ctrl+Shift+B shows and hides the bookmarks bar",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Mark One");
      await k.createTab(`${site.origin}/page/Mark%20Two`);
      await waitFor(async () => (await k.tabs()).filter((t) => t.title.startsWith("Mark")).length === 2);
      await k.press("Ctrl+Shift+D", { tab: id, page: true });
      await waitFor(async () => (await k.invoke("get_bookmarks")).length === 2, { message: "both tabs bookmarked" });
      const toolbar = await k.toolbar();
      const barShown = () => toolbar.evaluate(`!document.getElementById('bookmarks-bar').hidden`);
      const before = await barShown();
      await k.press("Ctrl+Shift+B", { tab: id, page: true });
      await waitFor(async () => (await barShown()) !== before, { message: "the bar toggled" });
      await k.press("Ctrl+Shift+B", { tab: id, page: true });
      await waitFor(async () => (await barShown()) === before, { message: "and back" });
      assert(true, "done");
    },
  },
  {
    name: "Shift+Esc opens the task manager",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Busy");
      const before = k.dialogs({ all: true }).length;
      await k.press("Shift+Escape", { tab: id, page: true });
      await waitFor(() => k.dialogs({ all: true }).length > before, { message: "a task manager window", interval: 400 });
    },
  },

  // --- Zoom ------------------------------------------------------------------------
  {
    name: "Ctrl+Plus, Ctrl+Minus and Ctrl + mouse wheel zoom the site; Ctrl+0 resets it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "Zoomy");
      const zoom = async () => (await k.invoke("get_zoom_levels"))["127.0.0.2"];
      await k.press("Ctrl+Plus", { tab: id, page: true });
      await waitFor(async () => (await zoom()) === 1.1, { message: "110%" });
      await k.press("Ctrl+Minus", { tab: id, page: true });
      await waitFor(async () => (await zoom()) === undefined, { message: "back to 100%" });
      // The mouse wheel for real (DevTools' wheel events don't zoom).
      await k.invoke("page_action", { id, action: "focus", value: null });
      k.realKeys(["Ctrl+WheelUp"]);
      await waitFor(async () => (await zoom()) > 1, { message: "Ctrl + wheel zoomed in" });
      void page;
      const toolbar = await k.toolbar();
      await toolbar.waitFor(`!document.getElementById('zoom-btn').hidden`, { message: "zoom shown in the address bar" });
      await k.press("Ctrl+0", { tab: id, page: true });
      await waitFor(async () => (await zoom()) === undefined, { message: "reset" });
      assert(await toolbar.evaluate(`document.getElementById('zoom-btn').hidden`), "zoom badge gone");
    },
  },
  {
    name: "a site's zoom sticks to the site",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Big");
      await k.press("Ctrl+Plus", { tab: id, page: true });
      await k.press("Ctrl+Plus", { tab: id, page: true });
      await waitFor(async () => (await k.invoke("get_zoom_levels"))["127.0.0.2"] === 1.25, { message: "125%" });
      const other = await k.createTab(`${site.origin}/page/Sibling`);
      const page = await k.page("/page/Sibling");
      await page.waitFor(`document.readyState === 'complete'`);
      await waitFor(async () => Math.abs((await page.evaluate(`window.devicePixelRatio`)) / (await (await k.toolbar()).evaluate(`window.devicePixelRatio`)) - 1.25) < 0.01, { message: "the other page of the site opens at 125%" });
      void other;
    },
  },

  // --- Mouse ---------------------------------------------------------------------------
  {
    name: "Ctrl+click opens a link in a new tab, Ctrl+Shift+click behind this one",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "Linker");
      await page.clickSelector("#link-other", { modifiers: ["ctrl"] });
      await waitFor(async () => (await tabCount(k)) === 2, { message: "a new tab" });
      assert((await k.activeTab()).id !== id, "it came to the front");
      await k.toolbar().then((t) => t.evaluate(`window.__kesselTest.activateTab(${id})`));
      await waitFor(async () => (await k.activeTab()).id === id);
      await page.clickSelector("#link-other", { modifiers: ["ctrl", "shift"] });
      await waitFor(async () => (await tabCount(k)) === 3, { message: "another new tab" });
      assert.equal((await k.activeTab()).id, id, "this one opened behind");
    },
  },
  {
    name: "middle-clicking a link opens it behind; middle-clicking a tab closes it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "Middle");
      await page.clickSelector("#link-other", { button: "middle" });
      await waitFor(async () => (await tabCount(k)) === 2, { message: "a new tab" });
      assert.equal((await k.activeTab()).id, id, "opened behind");
      const opened = (await k.tabs()).find((t) => t.id !== id);
      const toolbar = await k.toolbar();
      await toolbar.clickSelector(`.tab[data-tab-id="${opened.id}"]`, { button: "middle" });
      await waitFor(async () => (await tabCount(k)) === 1, { message: "middle click closed the tab" });
    },
  },
  {
    name: "Shift+click opens a link in a new window",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { page } = await openPage(k, site, "Shifty");
      await page.clickSelector("#link-other", { modifiers: ["shift"] });
      await waitFor(async () => (await k.windows()).length === 2, { message: "a new window" });
      const other = (await k.windows()).find((w) => w !== "win-1");
      await waitFor(async () => (await k.tabs(other)).some((t) => t.url.includes("/page/other")), { message: "showing the link" });
    },
  },
  {
    name: "middle-click on the page (not a link) starts autoscroll",
    async run({ launch, site, sleep }) {
      const k = await launch();
      const { page } = await openPage(k, site, "Scroller");
      const s = page.session;
      await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 300 });
      await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 300, button: "middle", buttons: 4, clickCount: 1 });
      await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 400, y: 300, button: "middle", buttons: 0, clickCount: 1 });
      for (let y = 310; y <= 500; y += 30) {
        await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y });
        await sleep(40);
      }
      await page.waitFor(`window.scrollY > 50`, { message: "the page scrolls by itself", timeout: 4000 });
      await page.key("Escape");
    },
  },

  // --- Keys the engine handles, pressed for real -----------------------------------
  {
    name: "real key presses: F5, Alt+Left, Ctrl+Plus and Ctrl+T reach Kessel from a website -- once each",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Earlier");
      const { page } = await openPage(k, site, "Physical", { id });
      await k.invoke("page_action", { id, action: "focus", value: null });
      await page.evaluate(`window.__mark = 1`);
      k.realKeys(["F5"]);
      await page.waitFor(`window.__mark === undefined`, { message: "F5 reloaded" });
      await page.waitFor(`document.readyState === 'complete'`);
      k.realKeys(["Ctrl+plus"]);
      await waitFor(async () => (await k.invoke("get_zoom_levels"))["127.0.0.2"] !== undefined, { message: "Ctrl+Plus zoomed" });
      await sleep(500);
      assert.equal((await k.invoke("get_zoom_levels"))["127.0.0.2"], 1.1, "one step, not two");
      k.realKeys(["Ctrl+0"]);
      await waitFor(async () => (await k.invoke("get_zoom_levels"))["127.0.0.2"] === undefined, { message: "Ctrl+0 reset it" });
      k.realKeys(["Alt+Left"]);
      await waitFor(async () => (await k.activeTab()).title === "Earlier", { message: "Alt+Left went back" });
      await sleep(800);
      assert.equal((await k.activeTab()).title, "Earlier", "one page back, not two");
      await (await k.page("/page/Earlier")).waitFor(`document.readyState === 'complete'`);
      await k.invoke("page_action", { id, action: "focus", value: null });
      k.realKeys(["Ctrl+T"]);
      await waitFor(async () => (await tabCount(k)) === 2, { message: "Ctrl+T opened a tab" });
    },
  },
  {
    name: "real key presses: Home, End, Space, Shift+Space, Page Down and Page Up scroll",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "Long");
      await k.invoke("page_action", { id, action: "focus", value: null });
      const y = () => page.evaluate(`Math.round(window.scrollY)`);
      k.realKeys(["End"]);
      await waitFor(async () => (await y()) > 1000, { message: "End: bottom" });
      k.realKeys(["Home"]);
      await waitFor(async () => (await y()) === 0, { message: "Home: top" });
      k.realKeys(["space"]);
      await waitFor(async () => (await y()) > 100, { message: "Space: down" });
      const afterSpace = await y();
      k.realKeys(["Shift+space"]);
      await waitFor(async () => (await y()) < afterSpace, { message: "Shift+Space: up" });
      k.realKeys(["pagedown"]);
      await waitFor(async () => (await y()) > 100, { message: "Page Down" });
      const afterPgDn = await y();
      k.realKeys(["pageup"]);
      await waitFor(async () => (await y()) < afterPgDn, { message: "Page Up" });
      assert(true, "scrolled every way");
    },
  },
  {
    name: "real key presses: Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+Z and Ctrl+Y edit text",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id, page } = await openPage(k, site, "Editor");
      // Keep whatever was on the clipboard.
      const clipboard = await import("../lib/clipboard.mjs");
      const saved = clipboard.save();
      try {
        await k.invoke("page_action", { id, action: "focus", value: null });
        await page.evaluate(`(() => { const t = document.getElementById('text'); t.value = 'hello world'; t.focus(); t.select(); })()`);
        const value = () => page.evaluate(`document.getElementById('text').value`);
        k.realKeys(["Ctrl+C", "End", "Ctrl+V"]);
        await waitFor(async () => (await value()) === "hello worldhello world", { message: "copy + paste" });
        k.realKeys(["Ctrl+Z"]);
        await waitFor(async () => (await value()) === "hello world", { message: "undo" });
        k.realKeys(["Ctrl+Y"]);
        await waitFor(async () => (await value()) === "hello worldhello world", { message: "redo" });
        k.realKeys(["Ctrl+A", "Ctrl+X"]);
        await waitFor(async () => (await value()) === "", { message: "cut" });
        k.realKeys(["Ctrl+V"]);
        await waitFor(async () => (await value()) === "hello worldhello world", { message: "paste what was cut" });
        assert(true, "all of them");
      } finally {
        clipboard.restore(saved);
      }
    },
  },

  // --- Your own shortcuts ------------------------------------------------------------
  {
    name: "a shortcut you set in Settings works, and the old one stops",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Custom");
      const settings = await k.invoke("get_settings");
      await k.invoke("update_settings", { settings: { ...settings, shortcuts: { "new-tab": ["Ctrl+Shift+Y"] } } });
      assert.equal(await k.press("Ctrl+T", { tab: id }), false, "Ctrl+T is free now");
      await k.press("Ctrl+Shift+Y", { tab: id });
      await waitFor(async () => (await tabCount(k)) === 2, { message: "Ctrl+Shift+Y opened a tab" });
      const commands = await k.invoke("get_commands");
      const newTab = commands.find((c) => c.id === "new-tab");
      assert.equal(JSON.stringify(newTab.keys), JSON.stringify(["Ctrl+Shift+Y"]), "the menu and help show the new keys");
      assert.equal(JSON.stringify(newTab.default_keys), JSON.stringify(["Ctrl+T"]), "and still know the default");
    },
  },
  {
    name: "Settings records a new shortcut from the keys you press",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      await k.invoke("open_singleton_tab", { route: "kessel://settings/shortcuts" });
      const settings = await k.page("settings.html");
      await settings.waitFor(`document.querySelectorAll('.shortcut-row').length > 40`, { message: "the shortcut list" });
      const tab = (await k.tabs()).find((t) => t.url.startsWith("kessel://settings"));
      // Click + on "Duplicate tab", then press Ctrl+Shift+U.
      await settings.evaluate(`(() => { const row = [...document.querySelectorAll('.shortcut-row')].find(r => r.querySelector('.title').textContent.startsWith('Duplicate tab')); row.querySelector('.add-key').click(); })()`);
      await settings.waitFor(`!!document.querySelector('.key-chip.recording')`, { message: "waiting for keys" });
      assert(await k.press("Ctrl+Shift+U", { tab: tab.id }), "the keys went to the recorder, not the page");
      await waitFor(async () => {
        const c = (await k.invoke("get_commands")).find((c) => c.id === "duplicate-tab");
        return c.keys.includes("Ctrl+Shift+U");
      }, { message: "saved" });
      // And a reserved key is recorded too, instead of opening a tab.
      await settings.evaluate(`(() => { const row = [...document.querySelectorAll('.shortcut-row')].find(r => r.querySelector('.title').textContent.startsWith('Duplicate tab')); row.querySelector('.add-key').click(); })()`);
      await settings.waitFor(`!!document.querySelector('.key-chip.recording')`);
      const before = (await k.tabs()).length;
      await k.press("Escape", { tab: tab.id });
      await settings.waitFor(`!document.querySelector('.key-chip.recording')`, { message: "Escape cancels" });
      assert.equal((await k.tabs()).length, before, "nothing else happened");
    },
  },
];
