// UI styles (src/shared/styles.js, Settings -> Appearance): a style or an
// option changed in Settings reaches the toolbar and the new tab page, is
// saved, and each style keeps its own changes.

async function openSettings(k) {
  await k.createTab("kessel://settings");
  const page = await k.page("settings.html");
  await page.waitFor(`document.querySelectorAll(".k-row").length > 100`);
  return page;
}

// Sets the control of option `key` in Settings the way a person would
// (value + the event the page listens for).
function setControl(page, key, selector, value, event) {
  return page.evaluate(`(() => {
    const el = document.querySelector('.k-row[data-key="${key}"] ${selector}');
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("${event}", { bubbles: true }));
    return true;
  })()`);
}

const cssVar = (page, name) => page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
const htmlAttr = (page, name) => page.evaluate(`document.documentElement.getAttribute(${JSON.stringify(name)})`);
const saved = (k) => JSON.parse(k.readProfileFile("Data/settings.json") || "{}");
const chromeTop = async (toolbar) => JSON.parse(await toolbar.evaluate(`localStorage.getItem("kessel.chrome")`)).top;

export const tests = [
  {
    name: "settings from before styles keep their look",
    async run({ launch, assert, waitFor }) {
      const k = await launch({ settings: { glass_enabled: false, theme: "light", accent: "#ff0000" } });
      const toolbar = await k.toolbar();
      await waitFor(async () => (await htmlAttr(toolbar, "data-ui-style")) === "clean", { message: "Hyper Clean for glass-off settings" });
      assert.equal(await htmlAttr(toolbar, "data-theme"), "light", "the light theme carries over");
      assert.equal(await cssVar(toolbar, "--accent"), "#ff0000", "the accent carries over");
    },
  },
  {
    name: "a style picked in Settings reaches the toolbar and is saved",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const toolbar = await k.toolbar();
      assert.equal(await htmlAttr(toolbar, "data-ui-style"), "glass", "Liquid Glass by default");
      const settings = await openSettings(k);
      await settings.evaluate(`document.querySelector('.style-card[data-style="robust"]').click()`);
      await waitFor(async () => (await htmlAttr(toolbar, "data-ui-style")) === "robust", { message: "toolbar in Robust" });
      assert(!(await toolbar.evaluate(`document.documentElement.classList.contains("glass")`)), "the glass is off");
      await waitFor(() => saved(k).ui_style === "robust", { message: "ui_style saved" });
      // The rail is Robust's width, and Rust was told where the page goes.
      await waitFor(async () => JSON.parse(await toolbar.evaluate(`localStorage.getItem("kessel.chrome")`)).left === 56, { message: "56px rail reported" });
    },
  },
  {
    name: "options apply to every page and each style keeps its own",
    async run({ launch, assert, waitFor }) {
      const k = await launch({ settings: { ui_style: "futuristic" } });
      const toolbar = await k.toolbar();
      const newtab = await k.page("newtab.html");
      const settings = await openSettings(k);
      const topBefore = await chromeTop(toolbar);

      await setControl(settings, "tabHeight", `input[type=range]`, "40", "input");
      await waitFor(async () => (await cssVar(toolbar, "--k-tab-h")) === "40px", { message: "taller tabs in the toolbar" });
      await waitFor(async () => (await chromeTop(toolbar)) === topBefore + 10, { message: "the page moved down with the taller tab strip" });

      await setControl(settings, "accent", `.k-hex`, "#ff3300", "change");
      await waitFor(async () => (await cssVar(toolbar, "--accent")) === "#ff3300", { message: "accent in the toolbar" });
      await waitFor(async () => (await cssVar(newtab, "--accent")) === "#ff3300", { message: "accent on the new tab page" });
      await waitFor(() => saved(k).ui_custom?.futuristic?.accent === "#ff3300", { message: "accent saved for Futuristic" });

      // Another style, and back: Futuristic still has its changes.
      await settings.evaluate(`document.querySelector('.style-card[data-style="vintage"]').click()`);
      await waitFor(async () => (await htmlAttr(toolbar, "data-ui-style")) === "vintage", { message: "Vintage" });
      assert((await cssVar(toolbar, "--accent")) !== "#ff3300", "Vintage has its own accent");
      await settings.evaluate(`document.querySelector('.style-card[data-style="futuristic"]').click()`);
      await waitFor(async () => (await cssVar(toolbar, "--accent")) === "#ff3300", { message: "Futuristic's accent is back" });
      assert.equal(await cssVar(toolbar, "--k-tab-h"), "40px", "and its tab height");
    },
  },
  {
    name: "presets, undo and reset",
    async run({ launch, assert, waitFor }) {
      const k = await launch({ settings: { ui_style: "futuristic" } });
      const toolbar = await k.toolbar();
      const settings = await openSettings(k);
      await settings.evaluate(`[...document.querySelectorAll(".k-builtin .k-preset")].find((b) => b.textContent.includes("Matrix")).click()`);
      await waitFor(async () => (await cssVar(toolbar, "--accent")) === "#00ff66", { message: "Matrix preset applied" });
      await settings.evaluate(`document.querySelector('[data-act="undo"]').click()`);
      await waitFor(async () => (await cssVar(toolbar, "--accent")) === "#00e5ff", { message: "undo brings the defaults back" });
      await settings.evaluate(`document.querySelector('[data-act="redo"]').click()`);
      await waitFor(async () => (await cssVar(toolbar, "--accent")) === "#00ff66", { message: "redo" });
      await settings.evaluate(`document.querySelector('.k-row[data-key="accent"] .k-reset').click()`);
      await waitFor(async () => (await cssVar(toolbar, "--accent")) === "#00e5ff", { message: "one option reset" });
      assert((await cssVar(toolbar, "--font")).includes("Consolas"), "the rest of the preset stays");
    },
  },
  {
    name: "your own CSS reaches every Kessel page",
    async run({ launch, waitFor }) {
      const k = await launch({ settings: { ui_style: "clean" } });
      const toolbar = await k.toolbar();
      const newtab = await k.page("newtab.html");
      const settings = await openSettings(k);
      await setControl(settings, "customCss", `textarea`, "#clock { outline: 3px solid red; }", "input");
      await waitFor(async () => (await toolbar.evaluate(`document.getElementById("k-user-css")?.textContent || ""`)).includes("outline"), { message: "custom CSS in the toolbar" });
      await waitFor(async () => (await newtab.evaluate(`getComputedStyle(document.getElementById("clock")).outlineStyle`)) === "solid", { message: "custom CSS on the new tab page" });
    },
  },
  {
    name: "the new tab page follows its options",
    async run({ launch, assert, waitFor }) {
      const k = await launch({ settings: { ui_style: "vintage", ui_custom: { vintage: { clockFormat: "12h", ntBookmarks: false } } } });
      const newtab = await k.page("newtab.html");
      await waitFor(async () => /AM|PM/.test(await newtab.evaluate(`document.getElementById("clock").textContent`)), { message: "12-hour clock" });
      assert.equal(await newtab.evaluate(`getComputedStyle(document.getElementById("bookmarks-section")).display`), "none", "bookmarks hidden");
    },
  },
  {
    name: "searching the options",
    async run({ launch, assert }) {
      const k = await launch();
      const settings = await openSettings(k);
      await settings.evaluate(`(() => { const s = document.querySelector(".k-search input"); s.value = "scanline"; s.dispatchEvent(new Event("input")); })()`);
      const shown = await settings.evaluate(`[...document.querySelectorAll(".k-row")].filter((r) => r.offsetParent).map((r) => r.dataset.key)`);
      assert(shown.includes("scanlines"), "the scanlines option is found");
      assert(shown.length <= 3, `only matching options show (${shown.join(", ")})`);
    },
  },
  {
    name: "density: Compact makes the chrome smaller, Touch bigger -- menus too",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const toolbar = await k.toolbar();
      const px = async (name) => parseFloat(await cssVar(toolbar, name));
      const normal = { top: await chromeTop(toolbar), tab: await px("--k-tab-h"), nav: await px("--k-nav-h") };
      assert.equal(await px("--k-menu-item-h"), 30, "normal menu items");
      const settings = await openSettings(k);
      const pick = (value) => settings.evaluate(`(() => { const s = document.getElementById('ui-density'); s.value = '${value}'; s.dispatchEvent(new Event('change')); })()`);

      await pick("compact");
      await waitFor(async () => (await htmlAttr(toolbar, "data-k-density")) === "compact", { message: "compact" });
      assert((await px("--k-tab-h")) < normal.tab && (await px("--k-nav-h")) < normal.nav, "smaller tabs and toolbar");
      await waitFor(async () => (await chromeTop(toolbar)) < normal.top, { message: "the page starts higher up" });
      assert.equal(await px("--k-menu-item-h"), 26, "smaller menu items");

      await pick("touch");
      await waitFor(async () => (await htmlAttr(toolbar, "data-k-density")) === "touch", { message: "touch" });
      assert((await px("--k-tab-h")) > normal.tab && (await px("--k-nav-h")) > normal.nav, "bigger tabs and toolbar");
      await waitFor(async () => (await chromeTop(toolbar)) > normal.top, { message: "the page starts lower down" });
      assert.equal(await px("--k-menu-item-h"), 40, "menu items big enough for a finger");
      assert.equal(await htmlAttr(settings, "data-k-density"), "touch", "every Kessel page follows");
      await waitFor(() => saved(k).features?.ui_density === "touch", { message: "saved" });

      await pick("normal");
      await waitFor(async () => (await chromeTop(toolbar)) === normal.top, { message: "back as it was" });
      assert.equal(saved(k).features?.ui_density, undefined, "nothing kept for Normal");
    },
  },
];
