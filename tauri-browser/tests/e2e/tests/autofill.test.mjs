// Addresses and cards (forms.rs, page-tools.js, forms.html): the list under
// a form's field is Kessel's own -- the page never sees what's saved until
// you pick one -- and picking fills the form; a form sent with a new address
// is offered to keep. (4242 4242 4242 4242 is a payment provider's
// published test card number.)

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id: tab.id, page };
}

const center = (page, selector) => page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);

// The list under the field: its webview, once it shows `text`.
async function list(k, waitFor, text) {
  const popup = await k.page((t) => t.url.includes("forms.html"));
  await popup.waitFor(`[...document.querySelectorAll('.item .label')].some((l) => l.textContent === ${JSON.stringify(text)})`, { message: `"${text}" in the list` });
  return popup;
}

async function pick(popup, text) {
  const [x, y] = await popup.evaluate(`(() => { const row = [...document.querySelectorAll('.item')].find((r) => r.textContent.includes(${JSON.stringify(text)})); const b = row.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  // (The press picks it and the list closes: the release then has nowhere to go.)
  await popup.click(x, y).catch((e) => {
    if (!/connection closed|closed/i.test(String(e))) throw e;
  });
}

const values = (page, ids) => page.evaluate(`Object.fromEntries(${JSON.stringify(ids)}.map((id) => [id, document.getElementById(id).value]))`);

export const tests = [
  {
    // (Kessel's pages come from its own http origin: no web page.)
    name: "no address list on Kessel's own pages: the new tab page's search box is no address field",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      await k.invoke("autofill_save_address", { address: { name: "Jane Doe", street: "1 Main St", city: "Budapest", postal_code: "1011", country: "Hungary" } });
      const page = await k.page((t) => t.url.includes("newtab"));
      await page.waitFor(`!!document.getElementById('omnibox')`);
      await page.session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      // (Away from it and back: the field gets the focus anew.)
      await page.evaluate(`document.getElementById('omnibox').blur()`);
      await page.click(...(await center(page, "#omnibox")));
      // (It would show at once -- and, taking the focus, close again.)
      for (let i = 0; i < 12; i++) {
        assert(!(await k.targets()).some((t) => t.url.includes("forms.html")), "no list");
        await new Promise((r) => setTimeout(r, 100));
      }
      await page.session.send("Input.insertText", { text: "b" });
      await waitFor(() => page.evaluate(`document.activeElement?.id === 'omnibox' && document.getElementById('omnibox').value === 'b'`), { message: "still typing in the search box" });
    },
  },
  {
    name: "addresses and cards: Kessel's own list under the field, the page sees nothing till you pick; picking fills the form",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await k.invoke("autofill_save_address", { address: { name: "Jane Doe", street: "1 Main St", city: "Budapest", postal_code: "1011", country: "Hungary", phone: "+36 1 234 5678", email: "jane@example.com" } });
      await k.invoke("autofill_save_card", { name: "Jane Doe", number: "4242 4242 4242 4242", expMonth: 3, expYear: 2031 });
      const listed = await k.invoke("autofill_list");
      assert.equal(listed.cards[0].label, "Visa •••• 4242, 03/31", "the card, as lists show it");
      assert(!JSON.stringify(listed).includes("4242424242424242"), "never its whole number");

      const { page } = await open(k, `${site.origin}/checkout`);
      // (An off-screen test window never has the system's focus, so the
      // engine would take it from the field at once; a person's window has it.)
      await page.session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      // Everything the page's own scripts could hear from Kessel.
      await page.evaluate(`(() => { window.heard = []; window.chrome.webview.addEventListener('message', (e) => window.heard.push(JSON.stringify(e.data))); return true; })()`);

      await page.click(...(await center(page, "#name")));
      let popup = await list(k, waitFor, "Jane Doe, 1 Main St").catch(async (e) => {
        const why = await page.evaluate(`(document.activeElement && document.activeElement.id) + ' focus=' + document.hasFocus() + ' heard=' + window.heard.join(' ')`);
        throw new Error(`${e.message}; ${why}; targets: ${(await k.targets()).map((t) => t.url).join(" | ")}`);
      });
      const before = await page.evaluate(`window.heard.join(' ')`);
      assert(!before.includes("Jane") && !before.includes("Main St"), `the page heard nothing of it: ${before}`);
      await pick(popup, "Jane Doe");
      await page.waitFor(`document.getElementById('name').value === 'Jane Doe'`, { message: "the name filled in" });
      assert.deepEqual(await values(page, ["email", "tel", "street", "city", "zip", "country", "ccnum"]), { email: "jane@example.com", tel: "+36 1 234 5678", street: "1 Main St", city: "Budapest", zip: "1011", country: "HU", ccnum: "" }, "the address -- the country picked by its name -- and not the card");
      await waitFor(async () => !(await k.targets()).some((t) => t.url.includes("forms.html")), { message: "the list gone" });

      // The card.
      await page.click(...(await center(page, "#ccnum")));
      popup = await list(k, waitFor, "Visa •••• 4242, 03/31");
      assert(!(await page.evaluate(`window.heard.join(' ')`)).includes("4242"), "the page heard nothing of the card");
      // Picked with the keyboard, which stays in the page: Down, Enter.
      await page.key("Down");
      await popup.waitFor(`!!document.querySelector('.item.on')`, { message: "the first one chosen" });
      await page.key("Enter");
      await page.waitFor(`document.getElementById('ccnum').value === '4242424242424242'`, { message: "the number filled in" });
      assert.deepEqual(await values(page, ["ccname", "ccexp", "cvc"]), { ccname: "Jane Doe", ccexp: "03/31", cvc: "" }, "name and expiry; never a security code");
    },
  },
  {
    name: "a form sent with a new address in it: offered to keep, and kept",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/checkout`);
      await page.evaluate(`(() => {
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set('name', 'Joe Bloggs'); set('street', '22 Acacia Ave'); set('city', 'Leeds'); set('email', 'joe@example.com');
        document.getElementById('f').requestSubmit();
        return true;
      })()`);
      const notice = await waitFor(async () => (await k.invoke("kessel_notices")).find((n) => n.id === "form-offer"), { message: "Save this address?" });
      assert.equal(notice.detail.label, "Joe Bloggs, 22 Acacia Ave", "which one");
      const toolbar = await k.toolbar();
      await toolbar.waitFor(`document.getElementById('notice-btn').textContent.includes('Save address?')`, { message: "in the toolbar" });
      await k.invoke("autofill_offer_answer", { offer: notice.detail.offer, save: true });
      const saved = (await k.invoke("autofill_list")).addresses;
      assert.equal(saved.length, 1, "kept");
      assert.equal(saved[0].city, "Leeds", "with all it had");
      await toolbar.waitFor(`document.getElementById('notice-btn').hidden`, { message: "the notice gone" });

      // The same again: nothing to ask.
      await open(k, `${site.origin}/checkout`).then(({ page: p }) => p.evaluate(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; }; set('name', 'joe bloggs'); set('street', '22 acacia ave'); set('email', 'joe@example.com'); document.getElementById('f').requestSubmit(); return true; })()`));
      await new Promise((r) => setTimeout(r, 1500));
      assert(!(await k.invoke("kessel_notices")).some((n) => n.id === "form-offer"), "already kept");
    },
  },
];
