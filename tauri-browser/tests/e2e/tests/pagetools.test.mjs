// Page tools (tools.rs, src/shared/page-tools.js) and the command palette:
// screenshots and their editor, highlights, feeds, reader view, a site's own
// CSS / filter / hidden elements / auto-reload, link hints, De-AMP, the
// Wayback offer, duplicate tabs, command chains, pausing everything,
// forgotten tabs, mouse gestures and the page's right-click extras.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";

const run = (k, id) => k.invoke("run_command", { id });
// The toolbar's own switching and closing (so it knows which tab is yours).
const focus = async (k, id) => (await k.toolbar()).evaluate(`window.__kesselTest.activateTab(${id})`);
const close = async (k, id) => (await k.toolbar()).evaluate(`window.__kesselTest.closeTab(${id})`);

// Tab `id` (default: the one you're on) at `url`, loaded.
async function open(k, url, id = null) {
  id = id ?? (await k.activeTab()).id;
  await focus(k, id);
  await k.invoke("navigate", { id, url });
  const page = await k.page((t) => t.url === url);
  // (The DevTools list shows the new address a moment before the old page
  // is gone: wait for the new page itself.)
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id, page };
}

async function setFeatures(k, patch) {
  const s = await k.invoke("get_settings");
  await k.invoke("update_settings", { settings: { ...s, features: { ...(s.features || {}), ...patch } } });
}

const filesIn = (dir) => {
  try {
    return readdirSync(dir).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};
// A PNG's width and height.
const pngSize = (file) => {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

export const tests = [
  {
    name: "the command palette lists every command and finds one",
    async run({ launch, site, assert }) {
      const k = await launch();
      await open(k, `${site.origin}/article/Palette`);
      await run(k, "command-palette");
      const palette = await k.page((t) => t.url.includes("palette.html"));
      await palette.waitFor(`document.querySelectorAll('#list > *').length > 20`, { message: "the list of commands" });
      const all = await palette.evaluate(`document.querySelectorAll('#list > *').length`);
      await palette.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'reader'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await palette.waitFor(`document.querySelectorAll('#list > *').length < ${all} && /Reader view/.test(document.getElementById('list').innerText)`, { message: "Reader view found" });
      assert(all > 20, `${all} commands`);
    },
  },
  {
    name: "screenshots: what's on screen, the whole page, a dragged part, and into the editor",
    async run({ launch, site, assert, waitFor, sleep }) {
      const folder = mkdtempSync(path.join(tmpdir(), "kessel-shots-"));
      try {
        const k = await launch({ settings: { features: { screenshot: { action: "save", folder, format: "png" } } } });
        const { page } = await open(k, `${site.origin}/article/Shots`);
        const next = async (before) => waitFor(() => filesIn(folder).find((f) => !before.has(f)), { message: "a new screenshot file", timeout: 20000 });

        await run(k, "screenshot-visible");
        const [vw, vh] = pngSize(await next(new Set()));
        await sleep(1100); // file names go by the second
        await run(k, "screenshot-full");
        const [, fh] = pngSize(await next(new Set(filesIn(folder))));
        assert(fh > vh * 1.5, `the whole page (${fh}px) is taller than the view (${vh}px)`);

        await sleep(1100);
        const before = new Set(filesIn(folder));
        await run(k, "screenshot-area");
        await page.waitFor(`[...document.querySelectorAll('div')].some((d) => d.style.cursor === 'crosshair')`, { message: "the area picker" });
        const s = page.session;
        await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 100 });
        await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100, button: "left", buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 5; i++) await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100 + i * 40, y: 100 + i * 30, button: "left", buttons: 1 });
        await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 300, y: 250, button: "left", buttons: 0, clickCount: 1 });
        assert.deepEqual(pngSize(await next(before)), [200, 150], "the dragged box");

        await setFeatures(k, { screenshot: { action: "edit", folder, format: "png" } });
        await run(k, "screenshot-visible");
        const editor = await k.page((t) => t.url.includes("shot.html"), { timeout: 15000 });
        await editor.waitFor(`document.getElementById('canvas').width === ${vw}`, { message: "the picture in the editor" });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  },
  {
    name: "a highlight on selected text is found again after a reload",
    async run({ launch, site, assert }) {
      const k = await launch();
      const { id, page } = await open(k, `${site.origin}/article/Highlights`);
      await page.evaluate(`(() => { const p = document.querySelectorAll('article p')[3]; const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 30); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
      await run(k, "highlight");
      await page.waitFor(`document.querySelectorAll('mark[data-hl]').length > 0`, { message: "the highlight" });
      // { page address: [its highlights] }
      assert.equal(Object.values(await k.invoke("highlights_all")).flat().length, 1, "kept");
      await k.invoke("reload", { id });
      await page.waitFor(`document.readyState === 'complete' && document.querySelectorAll('mark[data-hl]').length > 0`, { message: "the highlight after reloading", timeout: 15000 });
    },
  },
  {
    name: "following a page's feed; kessel://feeds shows its stories",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      await open(k, `${site.origin}/article/Feeds`);
      await run(k, "follow-feed");
      await waitFor(async () => ((await k.invoke("get_settings")).features.feeds || []).some((f) => f.url === `${site.origin}/feed.xml`), { message: "the feed followed" });
      await k.createTab("kessel://feeds");
      const feeds = await k.page((t) => t.url.includes("feeds.html"));
      await feeds.waitFor(`document.getElementById('list').innerText.includes('Test News')`, { message: "the feed listed", timeout: 15000 });
      await feeds.evaluate(`[...document.querySelectorAll('#list *')].find((e) => e.children.length === 0 && e.textContent.includes('Test News'))?.click()`);
      await feeds.waitFor(`document.getElementById('items').innerText.includes('Story 3')`, { message: "its stories", timeout: 15000 });
    },
  },
  {
    name: "reader view shows the article on its own, and goes back",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const url = `${site.origin}/article/Reader`;
      const { id } = await open(k, url);
      await run(k, "reader-mode");
      await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.url.startsWith("kessel://reader"), { message: "the tab in reader view" });
      const reader = await k.page((t) => t.url.includes("reader.html"));
      await reader.waitFor(`document.querySelectorAll('#article p').length >= 40`, { message: "the article's paragraphs" });
      assert.equal(await reader.evaluate(`document.querySelector('#article h1, #article h2')?.textContent`), "How glass bends light", "its heading");
      assert.equal(await reader.evaluate(`document.querySelectorAll('#article nav, #article #banner').length`), 0, "without the rest of the page");
      assert(await reader.evaluate(`!!document.getElementById('speak-btn') && !!document.getElementById('progress')`), "read aloud and reading progress");
      await run(k, "reader-mode");
      await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.url === url, { message: "back to the page" });
    },
  },
  {
    name: "changing a site: its own CSS and page filter, hidden elements, auto-reload",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const url = `${site.origin}/article/Tweaks`;
      let { id, page } = await open(k, url);
      await setFeatures(k, { site_tweaks: { "127.0.0.2": { css: "h1 { outline: 7px solid rgb(255, 0, 0) }", filter: "grayscale" } } });
      await page.waitFor(`getComputedStyle(document.querySelector('h1')).outlineWidth === '7px'`, { message: "the site's CSS, applied at once" });
      assert(/grayscale/.test(await page.evaluate(`getComputedStyle(document.documentElement).filter`)), "the page filter");

      // The element zapper: pick the banner, and it stays hidden.
      await run(k, "zap-element");
      await page.waitFor(`[...document.querySelectorAll('html > div')].some((d) => /Click what to hide/.test(d.textContent))`, { message: "the zapper" });
      const box = await page.evaluate(`(() => { const b = document.getElementById('banner'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 }; })()`);
      await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await page.click(box.x, box.y);
      await page.waitFor(`getComputedStyle(document.getElementById('banner')).display === 'none'`, { message: "the banner hidden" });
      await waitFor(async () => (await k.invoke("get_settings")).features.site_tweaks?.["127.0.0.2"]?.zapped?.includes("#banner"), { message: "kept for the site" });
      ({ page } = await open(k, url, id));
      await page.waitFor(`getComputedStyle(document.getElementById('banner')).display === 'none'`, { message: "still hidden, opened again" });

      // Auto-reload (5 seconds at least).
      const tweaks = (await k.invoke("get_settings")).features.site_tweaks;
      await setFeatures(k, { site_tweaks: { ...tweaks, "127.0.0.2": { ...tweaks["127.0.0.2"], reload: 5 } } });
      await page.evaluate(`window.__before = 1`);
      await waitFor(async () => page.evaluate(`window.__before === undefined && document.readyState === 'complete'`).catch(() => false), { message: "the page reloaded by itself", timeout: 20000 });
    },
  },
  {
    name: "link hints label the links on screen",
    async run({ launch, site }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/article/Hints`);
      await run(k, "link-hints");
      await page.waitFor(`[...document.querySelectorAll('html > div')].some((d) => d.style.zIndex === '2147483647' && d.children.length >= 2)`, { message: "hint labels" });
      await page.key("Escape");
    },
  },
  {
    name: "an AMP copy opens the real page; a missing page offers the Wayback Machine",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await open(k, `${site.origin}/page/Start`);
      await k.invoke("navigate", { id, url: `${site.origin}/amp/Real` });
      await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.url === `${site.origin}/article/Real`, { message: "the canonical page" });
      const { page } = await open(k, `${site.origin}/missing`, id);
      await page.waitFor(`/Wayback Machine/.test(document.documentElement.innerText)`, { message: "the Wayback offer" });
    },
  },
  {
    name: "duplicate tabs close; a command chain runs its commands in turn",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const dup = `${site.origin}/page/Dup`;
      await k.createTab(dup);
      await k.createTab(dup);
      await waitFor(async () => (await k.tabs()).filter((t) => t.url === dup).length === 2, { message: "two copies" });
      await run(k, "close-duplicate-tabs");
      await waitFor(async () => (await k.tabs()).filter((t) => t.url === dup).length === 1, { message: "one left" });
      const before = (await k.tabs()).length;
      await k.invoke("run_commands", { ids: ["new-tab", "new-tab"] });
      await waitFor(async () => (await k.tabs()).length === before + 2, { message: "two new tabs" });
    },
  },
  {
    name: "pause everything stops what plays; forgotten tabs close by themselves",
    async run({ launch, site, waitFor }) {
      const k = await launch({ settings: { features: { auto_close_days: 1 } } });
      const { id } = await open(k, `${site.origin}/article/Break`);
      const player = await k.createTab(`${site.origin}/media/Player`);
      const p = await k.page(`${site.origin}/media/Player`);
      await p.waitFor(`document.readyState === 'complete'`);
      // Muted first: nothing out of the speakers.
      await k.invoke("page_action", { id: player, action: "mute", value: null });
      await waitFor(async () => (await k.tabs()).find((t) => t.id === player)?.muted, { message: "muted" });
      await p.evaluate(`startMedia()`, { userGesture: true });
      await focus(k, id);
      await run(k, "break-mode");
      await p.waitFor(`document.getElementById('player').paused`, { message: "the player paused" });
      const toolbar = await k.toolbar();
      await toolbar.waitFor(`document.documentElement.classList.contains('break-mode')`, { message: "on a break" });
      await run(k, "break-mode");
      await toolbar.waitFor(`!document.documentElement.classList.contains('break-mode')`, { message: "back from the break" });
      await close(k, player);

      const old = await k.createTab(`${site.origin}/page/Old`);
      await focus(k, id);
      await toolbar.evaluate(`window.__kesselTest.age(${old}, 2 * 24 * 60)`);
      const fresh = await k.createTab(`${site.origin}/page/Fresh`);
      await focus(k, id);
      await waitFor(async () => !(await k.tabs()).some((t) => t.id === old), { message: "the tab not looked at for two days closed" });
      await waitFor(async () => (await k.tabs()).some((t) => t.id === fresh), { message: "a fresh one stays" });
    },
  },
  {
    name: "a mouse gesture (right button, left) goes back",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { id } = await open(k, `${site.origin}/page/GestureA`);
      const { page } = await open(k, `${site.origin}/page/GestureB`, id);
      const s = page.session;
      await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 300 });
      await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 300, button: "right", buttons: 2, clickCount: 1 });
      for (let i = 1; i <= 6; i++) await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400 - i * 30, y: 300, button: "right", buttons: 2 });
      await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 220, y: 300, button: "right", buttons: 0, clickCount: 1 });
      await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.url.endsWith("/GestureA"), { message: "back" });
    },
  },
  {
    name: "the page's right-click: peek at a link, search for the selection or an image",
    async run({ launch, site, waitFor }) {
      const other = await startServer("127.0.0.3");
      try {
        const k = await launch({ settings: { search_engine: "local", features: { search_engines: [{ id: "local", name: "Local", url: `${other.origin}/page/results?q=%s`, keyword: "lo" }] } } });
        const toolbar = await k.toolbar();
        const { id } = await open(k, `${site.origin}/article/Menu`);
        // The items are in WebView2's own menu: picked as the menu reports them.
        const pick = (action, value) => toolbar.evaluate(`window.__TAURI__.event.emit("page-menu", ${JSON.stringify({ action, value, page: `${site.origin}/article/Menu`, title: "Menu", tab: id })})`);

        await pick("peek-link", `${site.origin}/page/linked`);
        await waitFor(async () => (await k.targets()).some((t) => t.url === `${site.origin}/page/linked`), { message: "the link in a pop-out" });
        await pick("search-selection", "glass light");
        await waitFor(async () => (await k.tabs()).some((t) => t.url === `${other.origin}/page/results?q=glass%20light`), { message: "a search tab" });
        await setFeatures(k, { image_search: "bing" });
        await pick("search-image", `${site.origin}/pic.png`);
        // (The address itself, or Kessel's page saying it can't be reached.)
        const opened = (t) => [t.url, decodeURIComponent(t.url)].some((u) => u.includes("bing.com") && u.includes(encodeURIComponent(`${site.origin}/pic.png`)));
        await waitFor(async () => (await k.tabs()).some(opened), { message: "an image search tab" });
      } finally {
        await other.close();
      }
    },
  },
];
