// Spelling and grammar (proof.rs, page-tools.js startProofing): words
// Windows' spell checker doesn't know are underlined in what you type, with
// suggestions on right-click; grammar, when turned on, from LanguageTool
// (here the test server's stand-in).

// A misspelled sentence in a language this computer has a dictionary for.
const SAMPLES = {
  en: { text: "This is a wrnog sentence", start: 10, fix: "wrong" },
  hu: { text: "Ez egy hibás mondaat itt", start: 13, fix: "mondat" },
};

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete" && !!window.__kesselProof`, { message: "proofing started" });
  return page;
}

const marks = (page) => page.evaluate(`window.__kesselProof.marks()`);

async function rightClick(page, mark) {
  await page.click(mark.x, mark.y, { button: "right" });
}

export const tests = [
  {
    name: "a misspelled word is underlined, in a text box and an editable block; right-click offers the fix, Add to dictionary and Ignore",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { shields_https_upgrade: false } });
      const langs = await k.invoke("proof_languages");
      const lang = langs.find((l) => SAMPLES[l.split("-")[0].toLowerCase()]);
      if (!lang) {
        assert(true, `no dictionary to test with (${langs.join(", ")})`);
        return;
      }
      const sample = SAMPLES[lang.split("-")[0].toLowerCase()];
      const s = await k.invoke("get_settings");
      await k.invoke("update_settings", { settings: { ...s, features: { ...s.features, proofing: { spell: true, grammar: false, lang } } } });

      const page = await open(k, `${site.origin}/write`);
      await page.evaluate(`document.getElementById('box').focus()`);
      await page.type(sample.text);
      await waitFor(async () => (await marks(page)).some((m) => m.kind === "spell" && m.start === sample.start), { message: `"${sample.text}" marked at ${sample.start}` }).catch(async (e) => {
        throw new Error(`${e.message}; marks: ${JSON.stringify(await marks(page))}`);
      });
      assert.equal((await marks(page)).length, 1, "only the misspelled word");

      const [mark] = await marks(page);
      await rightClick(page, mark);
      await page.waitFor(`!!window.__kesselProof.menu()`, { message: "the menu" });
      const items = await page.evaluate(`window.__kesselProof.menu()`);
      assert(items.includes(sample.fix), `the fix offered: ${items.join(" | ")}`);
      assert(items.includes("Add to dictionary") && items.includes("Ignore"), `Add to dictionary and Ignore: ${items.join(" | ")}`);
      await page.evaluate(`window.__kesselProof.pick(${JSON.stringify(sample.fix)})`);
      await page.waitFor(`document.getElementById('box').value.includes(${JSON.stringify(sample.fix + " ")})`, { message: "the fix put in" });
      await waitFor(async () => (await marks(page)).length === 0, { message: "and the mark gone" });

      // An editable block (the CSS Highlight API's underlines).
      await page.evaluate(`document.getElementById('block').focus()`);
      await page.type(sample.text);
      await waitFor(async () => (await marks(page)).some((m) => m.kind === "spell" && m.start === sample.start && m.x > 0), { message: "marked in the editable block" }).catch(async (e) => {
        throw new Error(`${e.message}; marks: ${JSON.stringify(await marks(page))}`);
      });

      // Spelling off: nothing marked.
      const s2 = await k.invoke("get_settings");
      await k.invoke("update_settings", { settings: { ...s2, features: { ...s2.features, proofing: { spell: false, grammar: false, lang } } } });
      const off = `${site.origin}/write?off`;
      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url: off });
      const again = await k.page((t) => t.url === off);
      await again.waitFor(`document.readyState === "complete"`);
      await again.evaluate(`document.getElementById('box').focus()`);
      await again.type(sample.text);
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(await again.evaluate(`window.__kesselProof ? window.__kesselProof.marks().length : 0`), 0, "spelling off: no marks");
    },
  },
  {
    name: "grammar, when turned on, is underlined with the checker's suggestion",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { shields_https_upgrade: false, features: { proofing: { spell: false, grammar: true, lang: "en-US", grammar_server: `${site.origin}/v2/check` } } } });
      const page = await open(k, `${site.origin}/write`);
      await page.evaluate(`document.getElementById('box').focus()`);
      await page.type("I ate a apple today");
      await waitFor(async () => (await marks(page)).some((m) => m.kind === "grammar" && m.start === 6), { message: "a grammar mark on “a”", timeout: 15000 }).catch(async (e) => {
        throw new Error(`${e.message}; marks: ${JSON.stringify(await marks(page))}`);
      });
      const [mark] = (await marks(page)).filter((m) => m.kind === "grammar");
      await rightClick(page, mark);
      await page.waitFor(`!!window.__kesselProof.menu()`, { message: "the menu" });
      const items = await page.evaluate(`window.__kesselProof.menu()`);
      assert(items.includes("an"), `the suggestion: ${items.join(" | ")}`);
      await page.evaluate(`window.__kesselProof.pick("an")`);
      await page.waitFor(`document.getElementById('box').value === "I ate an apple today"`, { message: "the fix put in" });
    },
  },
];
