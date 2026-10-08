// Smaller things: theater mode (page-tools.js), a search engine for private
// windows (main.js searchSettings), downloads sorted into folders by kind
// (downloads.rs kind_folder).

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id: tab.id, page };
}

export const tests = [
  {
    name: "theater mode: the video fills the tab, on black; Esc puts it back",
    async run({ launch, site, assert }) {
      const k = await launch();
      const { id, page } = await open(k, `${site.origin}/video/Film`);
      await k.invoke("page_tool", { id, tool: "theater" });
      await page.waitFor(`(() => { const r = document.getElementById('v').getBoundingClientRect(); return Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight; })()`, { message: "the video fills the tab" });
      assert(await page.evaluate(`!!document.querySelector('[data-kessel="theater"]')`), "on a black backdrop");
      await page.session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.waitFor(`Math.round(document.getElementById('v').getBoundingClientRect().width) === 320`, { message: "back as it was" });
      assert.equal(await page.evaluate(`Math.round(document.getElementById('v').getBoundingClientRect().height)`), 180, "its own size again");
      assert(!(await page.evaluate(`!!document.querySelector('[data-kessel="theater"]')`)), "no backdrop");
    },
  },
  {
    // (Only the key: a real picture-in-picture window would open on screen.)
    name: "Alt+P is picture-in-picture's key; with no video there's nothing to do",
    async run({ launch, site, assert }) {
      const k = await launch();
      // (In a page the page goes first and hands back keys it doesn't use;
      // in the toolbar Kessel takes them straight away.)
      const { page } = await open(k, `${site.origin}/page/NoVideo`);
      assert(await k.press("Alt+P"), "one of Kessel's keys");
      assert.equal(await page.evaluate(`document.pictureInPictureElement`), null, "nothing popped out");
    },
  },
  {
    name: "a search engine of their own for private windows",
    async run({ launch, assert, waitFor }) {
      const k = await launch({ settings: { shields_https_upgrade: false, search_engine: "bing", features: { private_search_engine: "duckduckgo" } } });
      await k.invoke("new_window", { private: true });
      const priv = await waitFor(async () => (await k.toolbars()).find((t) => t.private), { message: "a private window" });
      // Typed as a person would, once the window has settled on its new tab.
      const search = async (toolbar, label) => {
        await waitFor(async () => (await k.tabs(label)).some((t) => t.active && t.url === "kessel://newtab"), { message: "the window's new tab" });
        await toolbar.evaluate(`(() => { const i = document.getElementById('url-input'); i.focus(); i.select(); })()`);
        await toolbar.session.send("Input.insertText", { text: "kessel lock" });
        await toolbar.waitFor(`document.getElementById('url-input').value === 'kessel lock'`, { message: "typed" });
        await toolbar.key("Enter");
      };
      // (The address itself, or Kessel's page saying it can't be reached.)
      const went = (t, start) => [t.url, decodeURIComponent(t.url)].some((u) => u.startsWith(start) || u.includes(`url=${start}`));
      await search(priv.page, priv.label);
      await waitFor(async () => (await k.tabs(priv.label)).some((t) => went(t, "https://duckduckgo.com/?q=kessel")), { message: "DuckDuckGo in the private window" }).catch(async (e) => {
        const typed = await priv.page.evaluate(`document.getElementById('url-input').value`);
        throw new Error(`${e.message}; its tabs: ${JSON.stringify((await k.tabs(priv.label)).map((t) => t.url))}; typed: ${typed}`);
      });
      const normal = await k.toolbar("win-1");
      await search(normal, "win-1");
      await waitFor(async () => (await k.tabs("win-1")).some((t) => went(t, "https://www.bing.com/search?q=kessel")), { message: "your usual engine elsewhere" });
      assert(true, "both");
    },
  },
  {
    name: "a search engine for one window only, from the address bar's engine menu",
    async run({ launch, assert, waitFor }) {
      const k = await launch({ settings: { shields_https_upgrade: false, search_engine: "bing" } });
      const toolbar = await k.toolbar("win-1");
      // (A click within 400 ms of a menu closing only closes it.)
      const pick = async (label) => {
        await new Promise((r) => setTimeout(r, 500));
        await toolbar.clickSelector("#engine-btn");
        const menu = await k.page((t) => t.url.includes("/context.html"));
        await menu.waitFor(`document.querySelectorAll('.item').length > 0`);
        const box = await menu.evaluate(`(() => { const el = [...document.querySelectorAll('.item')].find((i) => i.querySelector('.label').textContent === ${JSON.stringify(label)}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await menu.click(box.x, box.y);
      };
      const search = async (tb, label) => {
        await waitFor(async () => (await k.tabs(label)).some((t) => t.active && t.url === "kessel://newtab"), { message: "the window's new tab" });
        await tb.evaluate(`(() => { const i = document.getElementById('url-input'); i.focus(); i.select(); })()`);
        await tb.session.send("Input.insertText", { text: "kessel window" });
        await tb.waitFor(`document.getElementById('url-input').value === 'kessel window'`, { message: "typed" });
        await tb.key("Enter");
      };
      const went = (t, start) => [t.url, decodeURIComponent(t.url)].some((u) => u.startsWith(start) || u.includes(`url=${start}`));

      await pick("For this window only");
      await pick("DuckDuckGo");
      await search(toolbar, "win-1");
      await waitFor(async () => (await k.tabs("win-1")).some((t) => went(t, "https://duckduckgo.com/?q=kessel")), { message: "DuckDuckGo in this window" });
      assert.equal((await k.invoke("get_settings")).search_engine, "bing", "everywhere else's engine unchanged");

      await k.invoke("new_window", { private: false });
      await waitFor(async () => (await k.windows()).length === 2, { message: "another window" });
      await search(await k.toolbar("win-2"), "win-2");
      await waitFor(async () => (await k.tabs("win-2")).some((t) => went(t, "https://www.bing.com/search?q=kessel")), { message: "Bing in the other window" });
    },
  },
  {
    name: "downloads sorted into folders by kind",
    async run({ launch, site, waitFor }) {
      const folder = mkdtempSync(path.join(tmpdir(), "kessel-sorted-"));
      try {
        const k = await launch({ settings: { shields_https_upgrade: false, features: { download_dir: folder, download_sort: true } } });
        const { page } = await open(k, `${site.origin}/page/Files`);
        await page.evaluate(`(() => { const a = document.createElement('a'); a.href = '/download/notes.txt'; a.download = 'notes.txt'; document.body.append(a); a.click(); })()`, { userGesture: true });
        await waitFor(() => existsSync(path.join(folder, "Documents", "notes.txt")), { message: "notes.txt in Documents", timeout: 20000 });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  },
];
