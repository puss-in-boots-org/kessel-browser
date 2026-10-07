// Accessibility (a11y.rs, page-tools.js, Settings -> Accessibility): text
// size and fonts in pages, a smallest font size, less motion, the keyboard
// outline, caret browsing, F6 / Shift+F6, and names for every button of
// Kessel's own a screen reader says.

import { sleep } from "../lib/kessel.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  // (Not the page it was on: that one may answer first.)
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id: tab.id, page };
}

const setA11y = async (k, patch) => {
  const s = await k.invoke("get_settings");
  await k.invoke("update_settings", { settings: { ...s, features: { ...s.features, a11y: { ...(s.features.a11y || {}), ...patch } } } });
};

const bodySize = (page) => page.evaluate(`getComputedStyle(document.body).fontSize`);

export const tests = [
  {
    name: "text size: only the text grows, on every page and as you change it; your fonts for pages that don't pick their own",
    async run({ launch, site, assert }) {
      const k = await launch({ settings: { shields_https_upgrade: false, features: { a11y: { text_size: 24, fonts: { sans: "Verdana" } } } } });
      const { page } = await open(k, `${site.origin}/page/Big`);
      await page.waitFor(`getComputedStyle(document.body).fontSize === '24px'`, { message: "24 px text" });
      // A sans-serif text is drawn in Verdana: as wide as Verdana itself.
      const widths = await page.evaluate(`(() => { const w = (f) => { const s = document.createElement('span'); s.style.font = '20px ' + f; s.textContent = 'Kessel accessibility'; document.body.append(s); const x = s.getBoundingClientRect().width; s.remove(); return x; }; return [w('sans-serif'), w('Verdana'), w('Arial')]; })()`);
      assert.equal(widths[0], widths[1], "sans-serif is Verdana");
      assert(widths[0] !== widths[2], "not Arial any more");
      // The next page too.
      const { page: next } = await open(k, `${site.origin}/page/Next`);
      assert.equal(await bodySize(next), "24px", "the next page too");
      // Back to normal, in the page that's open.
      await setA11y(k, { text_size: 0, fonts: {} });
      await next.waitFor(`getComputedStyle(document.body).fontSize === '16px'`, { message: "back to 16 px" });
    },
  },
  {
    name: "a smallest font size, less motion and the keyboard outline reach the page",
    async run({ launch, site, assert }) {
      const k = await launch({ settings: { shields_https_upgrade: false, features: { a11y: { min_font: 14, reduce_motion: true, focus_rings: true } } } });
      const { page } = await open(k, `${site.origin}/page/Small`);
      await page.waitFor(`!!document.querySelector('style[data-kessel="tweaks"]') && /focus-visible/.test(document.querySelector('style[data-kessel="tweaks"]').textContent)`, { message: "the outline" });
      await page.evaluate(`(() => { const p = document.createElement('p'); p.id = 'tiny'; p.style.fontSize = '9px'; p.textContent = 'Small print'; document.body.append(p); const q = document.createElement('div'); q.id = 'moving'; q.style.cssText = 'animation: spin 5s infinite; transition: opacity 3s'; q.textContent = 'x'; document.body.append(q); })()`);
      await page.waitFor(`getComputedStyle(document.getElementById('tiny')).fontSize === '14px'`, { message: "small print at 14 px" });
      assert.equal(await page.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true, "the page hears: less motion");
      const moving = await page.evaluate(`(() => { const s = getComputedStyle(document.getElementById('moving')); return [s.animationDuration, s.transitionDuration]; })()`);
      assert.deepEqual(moving, ["0.001s", "0.001s"], "animations cut short");
      // Turned off: the page hears that too.
      await setA11y(k, { reduce_motion: false });
      await page.waitFor(`!matchMedia('(prefers-reduced-motion: reduce)').matches`, { message: "motion back" });
    },
  },
  {
    // (Moving the caret takes real keys -- the DevTools protocol's don't
    // reach caret browsing -- so this checks the engine got the switch.)
    name: "caret browsing (F7): the engine starts with it; F7 turns it on or off for the next start",
    async run({ launch, assert, waitFor }) {
      const k = await launch({ settings: { shields_https_upgrade: false, features: { a11y: { caret_browsing: true } } } });
      assert.equal(await k.invoke("caret_browsing_running"), true, "the engine has it");
      assert((await k.invoke("graphics_info")).engine_args.includes("--enable-caret-browsing"), "on its command line");
      await k.press("F7");
      await waitFor(async () => (await k.invoke("get_settings")).features.a11y.caret_browsing === false, { message: "F7: off" });
      await k.press("F7");
      await waitFor(async () => (await k.invoke("get_settings")).features.a11y.caret_browsing === true, { message: "F7: on again" });
    },
  },
  {
    name: "every button of Kessel's toolbar has a name a screen reader says; pages have their accessibility tree",
    async run({ launch, site, assert }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/page/Named`);
      await k.createTab(`${site.origin}/page/Second`);
      await sleep(800);
      const toolbar = await k.toolbar();
      await toolbar.session.send("Accessibility.enable");
      const { nodes } = await toolbar.session.send("Accessibility.getFullAXTree");
      const nameless = nodes.filter((n) => !n.ignored && ["button", "switch", "checkbox", "tab", "link"].includes(n.role?.value) && !(n.name?.value || "").trim());
      const where = [];
      for (const n of nameless) {
        const html = n.backendDOMNodeId ? await toolbar.session.send("DOM.getOuterHTML", { backendNodeId: n.backendDOMNodeId }).then((r) => r.outerHTML.slice(0, 120), () => "?") : "?";
        where.push(`${n.role.value}: ${html}`);
      }
      assert.equal(where.length, 0, `buttons without a name:\n${where.join("\n")}`);
      const tree = await page.session.send("Accessibility.getFullAXTree");
      assert(tree.nodes.some((n) => n.role?.value === "heading" && n.name?.value === "Named"), "the page's own tree, with its heading");
    },
  },
  {
    name: "Settings -> Accessibility: the text size reaches the pages that are open",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/page/Settings`);
      await k.invoke("open_singleton_tab", { route: "kessel://settings/accessibility" });
      const settings = await k.page((t) => t.url.includes("settings.html"));
      await settings.waitFor(`!!document.getElementById('a11y-size')`, { message: "the Accessibility section" });
      await settings.evaluate(`(() => { const s = document.getElementById('a11y-size'); s.value = '20'; s.dispatchEvent(new Event('change')); })()`);
      await waitFor(async () => (await k.invoke("get_settings")).features.a11y?.text_size === 20, { message: "saved" });
      await page.waitFor(`getComputedStyle(document.body).fontSize === '20px'`, { message: "the open page's text at 20 px" });
    },
  },
  {
    name: "subtitles: their size, colour and background from Settings reach the open pages",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/video/Captions`);
      const cue = `(document.querySelector('style[data-kessel="tweaks"]')?.textContent || '').split('\\n').find((l) => l.startsWith('::cue')) || null`;
      assert.equal(await page.evaluate(cue), null, "the site's own captions to begin with");
      await k.invoke("open_singleton_tab", { route: "kessel://settings/accessibility" });
      const settings = await k.page((t) => t.url.includes("settings.html"));
      await settings.waitFor(`!!document.getElementById('cue-size')`, { message: "the Subtitles card" });
      for (const [id, value] of [["cue-size", "150"], ["cue-color", "yellow"], ["cue-background", "none"]]) {
        await settings.evaluate(`(() => { const s = document.getElementById('${id}'); s.value = '${value}'; s.dispatchEvent(new Event('change')); })()`);
      }
      await waitFor(async () => (await k.invoke("get_settings")).features.a11y?.captions?.background === "none", { message: "saved" });
      await page.waitFor(`${cue} === '::cue{font-size:150%!important;color:#ffeb3b!important;background-color:transparent!important;}'`, { message: "the page's captions follow" });
    },
  },
];
