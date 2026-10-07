// The translation chip (main.js translateMenu, page-tools.js page-lang): a
// page in another language than yours gets a Translate chip; Never quiets
// a language or a site; Always translates a language by itself.

import { startServer } from "../lib/server.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return tab.id;
}

const chip = (toolbar) => toolbar.evaluate(`(() => { const b = document.getElementById('translate-btn'); return b.hidden ? null : b.title; })()`);

async function pick(k, toolbar, label) {
  // (A click within 400 ms of a menu closing only closes it: Kessel's popups.)
  await new Promise((r) => setTimeout(r, 500));
  await toolbar.clickSelector("#translate-btn");
  const menu = await k.page((t) => t.url.includes("/context.html")).catch(async (e) => {
    const state = await toolbar.evaluate(`(() => { const b = document.getElementById('translate-btn'); const r = b.getBoundingClientRect(); return { hidden: b.hidden, rect: [r.x, r.y, r.width, r.height] }; })()`);
    throw new Error(`${e.message}; chip: ${JSON.stringify(state)}; targets: ${(await k.targets()).map((t) => t.url).join(" | ")}`);
  });
  await menu.waitFor(`document.querySelectorAll('.item').length > 0`);
  const box = await menu.evaluate(`(() => { const el = [...document.querySelectorAll('.item')].find((i) => i.querySelector('.label').textContent === ${JSON.stringify(label)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`no menu item "${label}": ${await menu.evaluate(`[...document.querySelectorAll('.item .label')].map((l) => l.textContent).join(' | ')`)}`);
  await menu.click(box.x, box.y);
}

export const tests = [
  {
    name: "a page in another language gets a Translate chip; Never quiets a language or a site; Always translates by itself",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { shields_https_upgrade: false, features: { translate_to: "en" } } });
      const toolbar = await k.toolbar();
      await open(k, `${site.origin}/lang/hu/Magyar`);
      await waitFor(async () => (await chip(toolbar)) === "This page is in Hungarian", { message: "the chip, for Hungarian" });
      await open(k, `${site.origin}/lang/en-GB/English`);
      await waitFor(async () => (await chip(toolbar)) === null, { message: "no chip on a page in your language" });

      await open(k, `${site.origin}/lang/de/Deutsch`);
      await waitFor(async () => (await chip(toolbar)) === "This page is in German", { message: "the chip, for German" });
      await pick(k, toolbar, "Never translate German");
      await waitFor(async () => (await k.invoke("get_settings")).features.translate_never_langs?.includes("de"), { message: "German: never" });
      await waitFor(async () => (await chip(toolbar)) === null, { message: "the chip gone" });

      await open(k, `${site.origin}/lang/hu/Again`);
      await waitFor(async () => (await chip(toolbar)) !== null, { message: "Hungarian again" });
      await pick(k, toolbar, "Never translate 127.0.0.2");
      await waitFor(async () => (await chip(toolbar)) === null, { message: "this site: never" });

      const other = await startServer("127.0.0.3");
      try {
        const french = `${other.origin}/lang/fr/Bonjour`;
        const id = await open(k, french);
        await waitFor(async () => (await chip(toolbar)) === "This page is in French", { message: "French elsewhere" });
        await pick(k, toolbar, "Always translate French");
        // Sent to Google Translate: the visit is in the history. (Google
        // can't reach a test page and sends the tab back to it; Kessel then
        // leaves it be rather than trying again and again.)
        const sent = async (page) =>
          (await k.invoke("query_history", { text: "translate.google.com" })).filter((v) => decodeURIComponent(v.url).includes(`translate.google.com/translate?sl=auto&tl=en&u=${other.origin}/lang/fr/${page}`)).length;
        await waitFor(async () => (await sent("Bonjour")) > 0, { message: "translated now" });
        // The next French page (a tab of its own, whatever Google makes of
        // the first): by itself.
        await k.createTab(`${other.origin}/lang/fr/Encore`);
        await waitFor(async () => (await sent("Encore")) > 0, { message: "the next French page translated by itself", timeout: 15000 }).catch(async (e) => {
          const visits = (await k.invoke("query_history", {})).map((v) => decodeURIComponent(v.url).slice(0, 110));
          throw new Error(`${e.message}; history: ${visits.join(" | ")}; the tab: ${(await k.tabs()).find((t) => t.id === id)?.url}`);
        });
        assert.deepEqual((await k.invoke("get_settings")).features.translate_always_langs, ["fr"], "French: always");

        // Settings lists them; German can be taken off its Never list.
        await k.invoke("open_singleton_tab", { route: "kessel://settings/tools" });
        const settings = await k.page((t) => t.url.includes("settings.html"));
        await settings.waitFor(`!!document.querySelector('#translate-lists [data-list]')`, { message: "the lists in Settings" });
        const listed = await settings.evaluate(`Object.fromEntries([...document.querySelectorAll('#translate-lists [data-list]')].map((r) => [r.dataset.list, [...r.querySelectorAll('[data-item]')].map((c) => c.dataset.item + '=' + c.firstElementChild.textContent)]))`);
        assert.deepEqual(listed, { translate_always_langs: ["fr=French"], translate_never_langs: ["de=German"], translate_never_sites: ["127.0.0.2=127.0.0.2"] }, "Always, Never and Never-on-these-sites");
        await settings.evaluate(`document.querySelector('#translate-lists [data-item="de"] .x').click()`);
        await waitFor(async () => !(await k.invoke("get_settings")).features.translate_never_langs, { message: "German off the Never list" });
        await settings.waitFor(`!document.querySelector('#translate-lists [data-list="translate_never_langs"]')`, { message: "and gone from Settings" });
      } finally {
        await other.close();
      }
    },
  },
];
