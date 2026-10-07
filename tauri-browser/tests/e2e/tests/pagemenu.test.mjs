// The page's right-click menu (sidebar.rs install_page_menu): the engine's
// own items with Kessel's -- on a link, an image, selected text and the
// page itself. A test can't see a native menu: the menu is kept instead of
// shown (test_page_menu), and Kessel's items are picked from it.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as clipboard from "../lib/clipboard.mjs";
import { sleep } from "../lib/kessel.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id: tab.id, page };
}

const middle = (page, selector) =>
  page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + Math.min(8, r.width / 2), r.y + r.height / 2]; })()`);

// Right-clicks at (x, y) and returns the menu: { engine: [names], kessel: [{ action, label, value }] }.
async function menuAt(k, page, waitFor, [x, y]) {
  await k.invoke("test_page_menu", { capture: true });
  await page.click(x, y, { button: "right" });
  return waitFor(() => k.invoke("test_page_menu", {}), { message: "the menu" });
}

// Tab `t` shows `url` -- or Kessel's page saying it can't be reached.
const shows = (t, url) => t.url === url || (t.url.startsWith("kessel://warning") && new URLSearchParams(t.url.slice(t.url.indexOf("?") + 1)).get("url") === url);

const pick = (k, action) => k.invoke("test_page_menu", { pick: action });
const actions = (menu) => menu.kessel.map((i) => i.action);

export const tests = [
  {
    name: "on a link: open it in a new tab, a new window or a private window, copy its text, search for it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/page/Links`);
      const menu = await menuAt(k, page, waitFor, await middle(page, "#link-other"));
      assert.deepEqual(actions(menu).slice(0, 3), ["open-link-tab", "open-link-window", "open-link-private"], "opening it, on top");
      assert(actions(menu).includes("copy-link-text") && actions(menu).includes("search-selection"), "its text: copy, search");
      assert(!menu.engine.includes("openLinkInNewWindow"), "instead of the engine's own new window");
      assert(menu.engine.includes("copyLinkLocation") && menu.engine.includes("saveLinkAs"), "the engine's copy link and save link as stay");
      assert.equal(menu.kessel.find((i) => i.action === "search-selection").label, "Search the web for “Other page”", "searching its text");

      const linked = `${site.origin}/page/other`;
      await pick(k, "open-link-tab");
      await waitFor(async () => (await k.tabs()).some((t) => t.url === linked), { message: "a new tab" });

      await pick(k, "open-link-window");
      await waitFor(async () => (await k.toolbars()).length === 2, { message: "a new window" });
      const second = (await k.toolbars()).find((t) => t.label !== "win-1");
      assert(!second.private, "an ordinary one");
      await waitFor(async () => (await k.tabs(second.label)).some((t) => t.url === linked), { message: "with the link" });

      await pick(k, "open-link-private");
      const priv = await waitFor(async () => (await k.toolbars()).find((t) => t.private), { message: "a private window" });
      await waitFor(async () => (await k.tabs(priv.label)).some((t) => t.url === linked), { message: "with the link" });

      const saved = clipboard.save();
      try {
        await pick(k, "copy-link-text");
        await waitFor(() => clipboard.readText() === "Other page", { message: "the link's text on the clipboard" });
      } finally {
        clipboard.restore(saved);
      }
    },
  },
  {
    name: "on an image: open it in a new tab, search for it; the engine saves and copies it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/content/Pictures?other=${encodeURIComponent(site.origin)}`);
      const menu = await menuAt(k, page, waitFor, await middle(page, "#own"));
      assert.deepEqual(actions(menu).slice(0, 2), ["open-image-tab", "search-image"], "Kessel's");
      for (const name of ["saveImageAs", "copyImage", "copyImageLocation"]) assert(menu.engine.includes(name), `the engine's ${name}`);
      assert.equal(menu.kessel[0].value, `${site.origin}/img/own.png`, "the image's address");
      await pick(k, "open-image-tab");
      await waitFor(async () => (await k.tabs()).some((t) => t.url === `${site.origin}/img/own.png`), { message: "the image in a new tab" });
    },
  },
  {
    name: "on selected text: translate it, define a word, read it aloud and stop",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { shields_https_upgrade: false, features: { translate_to: "hu" } } });
      const { page } = await open(k, `${site.origin}/page/Zqxjvbwor`);
      await page.evaluate(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('top')); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
      const at = await page.evaluate(`(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return [r.x + 6, r.y + r.height / 2]; })()`);
      let menu = await menuAt(k, page, waitFor, at);
      for (const a of ["search-selection", "translate-selection", "define-selection", "speak-selection", "share-selection"]) assert(actions(menu).includes(a), a);
      assert(menu.engine.includes("copy"), "the engine's Copy");

      await pick(k, "translate-selection");
      await waitFor(async () => (await k.tabs()).some((t) => shows(t, "https://translate.google.com/?sl=auto&tl=hu&text=Zqxjvbwor&op=translate")), { message: "Google Translate, into the language you picked" });
      // A word nobody has defined: your search engine instead.
      await pick(k, "define-selection");
      await waitFor(async () => (await k.tabs()).some((t) => /define(\+|%20| )Zqxjvbwor/i.test(decodeURIComponent(t.url))), { message: "a search for its definition", timeout: 20000 });

      const toolbar = await k.toolbar();
      await pick(k, "speak-selection");
      await waitFor(() => toolbar.evaluate(`speechSynthesis.speaking || speechSynthesis.pending`), { message: "reading aloud" });
      await k.invoke("switch_tab", { id: (await k.tabs())[0].id });
      menu = await menuAt(k, page, waitFor, at);
      assert(actions(menu).includes("stop-speaking") && !actions(menu).includes("speak-selection"), "the menu offers to stop");
      await pick(k, "stop-speaking");
      await waitFor(async () => !(await toolbar.evaluate(`speechSynthesis.speaking`)), { message: "stopped" });
    },
  },
  {
    name: "on the page: translate it, take a screenshot; turned off in Settings, translate isn't offered",
    async run({ launch, site, assert, waitFor }) {
      const folder = mkdtempSync(path.join(tmpdir(), "kessel-shots-"));
      try {
        const k = await launch({ settings: { shields_https_upgrade: false, features: { translate_to: "de", screenshot: { action: "save", folder, format: "png" } } } });
        const url = `${site.origin}/page/Plain`;
        const { page } = await open(k, url);
        let menu = await menuAt(k, page, waitFor, [8, 400]);
        assert.deepEqual(actions(menu).slice(0, 2), ["translate-page", "screenshot-page"], "Kessel's");
        for (const name of ["back", "reload", "saveAs", "print"]) assert(menu.engine.includes(name), `the engine's ${name}`);
        await pick(k, "screenshot-page");
        await waitFor(() => readdirSync(folder).some((f) => f.endsWith(".png")), { message: "a screenshot saved", timeout: 20000 });
        await pick(k, "translate-page");
        await waitFor(async () => (await k.tabs()).some((t) => shows(t, `https://translate.google.com/translate?sl=auto&tl=de&u=${encodeURIComponent(url)}`) || /translate\.goog/.test(t.url)), { message: "the page in Google Translate" });

        await k.invoke("switch_tab", { id: (await k.tabs())[0].id });
        await sleep(300);
        const settings = await k.invoke("get_settings");
        await k.invoke("update_settings", { settings: { ...settings, features: { ...settings.features, page_menu: { translate: false, define: false } } } });
        menu = await menuAt(k, page, waitFor, [8, 400]);
        assert(!actions(menu).includes("translate-page"), "no Translate");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  },
];
