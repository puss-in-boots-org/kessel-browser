// Passwords (passwords.rs, password-offer.html, passwords.html): saving the
// password you sign in with -- a form, a sign-in without one, a changed
// password, a locked vault -- "never for this site", none from private
// windows, password health, the breach check and the CSV export.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MASTER = "correct-horse-battery-9";

async function open(k, url) {
  const { id } = await k.activeTab();
  await k.invoke("navigate", { id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id, page };
}

// Types a user name and password into the page and presses its button.
const signIn = (page, user, pass, { newPass = null } = {}) =>
  page.evaluate(`(() => {
    const set = (id, v) => { const f = document.getElementById(id); if (f) { f.value = v; f.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('user', ${JSON.stringify(user)});
    set('pass', ${JSON.stringify(pass)});
    set('old', ${JSON.stringify(pass)});
    ${newPass ? `set('new', ${JSON.stringify(newPass)});` : ""}
    document.getElementById('go').click();
  })()`);

// The "Save your password?" popup, once it's filled in.
async function offer(k, { timeout = 8000 } = {}) {
  const p = await k.page((t) => t.url.includes("password-offer.html"), { timeout });
  await p.waitFor(`document.getElementById('title').textContent.length > 0`, { message: "the offer, filled in" });
  return p;
}

// No offer shows within `ms`.
async function noOffer(k, sleep, ms = 1500) {
  await sleep(ms);
  return !(await k.targets()).some((t) => t.url.includes("password-offer.html"));
}

const items = (k) => k.invoke("vault_list_items");

export const tests = [
  {
    name: "signing in offers to save the password; saved, it isn't offered again, a new one is offered as an update",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      await k.invoke("vault_setup", { masterPassword: MASTER });
      const { page } = await open(k, `${site.origin}/login`);
      await signIn(page, "ada@example.com", "First-Secret-42");

      const p = await offer(k);
      assert.equal(await p.evaluate(`document.getElementById('title').textContent`), "Save your password for 127.0.0.2?", "what it asks");
      assert.equal(await p.evaluate(`document.getElementById('user').value`), "ada@example.com", "the user name it picked up");
      assert.equal(await p.evaluate(`document.getElementById('unlock-row').hidden`), true, "the vault is open: no master password asked");
      await p.evaluate(`document.getElementById('save').click()`);
      const saved = await waitFor(async () => (await items(k)).find((i) => i.site === "127.0.0.2"), { message: "saved in the vault" });
      assert.deepEqual([saved.username, saved.password], ["ada@example.com", "First-Secret-42"], "what was saved");

      // The same again: nothing to ask.
      await open(k, `${site.origin}/login`).then(({ page }) => signIn(page, "ada@example.com", "First-Secret-42"));
      assert(await noOffer(k, sleep), "no offer for a login saved as it is");

      // A sign-in with no form (a button that only runs script), with a new
      // password: an update.
      const app = await open(k, `${site.origin}/app-login`);
      await signIn(app.page, "ada@example.com", "Second-Secret-77");
      const q = await offer(k);
      assert.equal(await q.evaluate(`document.getElementById('title').textContent`), "Update the saved password for 127.0.0.2?", "an update this time");
      assert.equal(await q.evaluate(`document.getElementById('save').textContent`), "Update", "its button");
      await q.evaluate(`document.getElementById('save').click()`);
      await waitFor(async () => (await items(k)).find((i) => i.site === "127.0.0.2")?.password === "Second-Secret-77", { message: "updated" });
      assert.equal((await items(k)).filter((i) => i.site === "127.0.0.2").length, 1, "updated, not added twice");
    },
  },
  {
    name: "a change-password form saves the new password; Never for this site stops the offers",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      await k.invoke("vault_setup", { masterPassword: MASTER });
      await k.invoke("vault_add_item", { site: "127.0.0.2", username: "bob", password: "Old-Pass-123", notes: "" });

      const { page } = await open(k, `${site.origin}/change-password`);
      await signIn(page, "bob", "Old-Pass-123", { newPass: "Brand-New-456!" });
      const p = await offer(k);
      assert(/Update/.test(await p.evaluate(`document.getElementById('title').textContent`)), "an update");
      await p.evaluate(`document.getElementById('save').click()`);
      await waitFor(async () => (await items(k)).find((i) => i.username === "bob")?.password === "Brand-New-456!", { message: "the new password, not the old one" });

      // "Never for this site".
      await open(k, `${site.origin}/login`).then(({ page }) => signIn(page, "carol", "Carols-Pass-1"));
      const q = await offer(k);
      await q.evaluate(`document.getElementById('never').click()`);
      await waitFor(async () => ((await k.invoke("get_settings")).features?.password_never || []).includes("127.0.0.2"), { message: "the site on the never list" });
      await sleep(500);
      await open(k, `${site.origin}/login`).then(({ page }) => signIn(page, "dave", "Daves-Pass-2"));
      assert(await noOffer(k, sleep), "no more offers for the site");
      assert(!(await items(k)).some((i) => i.username === "carol" || i.username === "dave"), "nothing saved");
    },
  },
  {
    name: "a locked vault is unlocked in the offer; with no vault it offers to set one up; private windows never offer",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      // No vault yet: a way to set one up.
      const first = await open(k, `${site.origin}/login`);
      await signIn(first.page, "erin", "Erins-Pass-3");
      const setup = await offer(k);
      assert.equal(await setup.evaluate(`document.getElementById('save').textContent`), "Set up", "set up a vault first");
      assert.equal(await setup.evaluate(`document.getElementById('note').hidden`), false, "and why");
      await setup.evaluate(`document.getElementById('later').click()`);
      await waitFor(async () => !(await k.targets()).some((t) => t.url.includes("password-offer.html")), { message: "the offer closed" });

      // Locked: the master password, right there.
      await k.invoke("vault_setup", { masterPassword: MASTER });
      await k.invoke("vault_lock");
      await sleep(500);
      await open(k, `${site.origin}/login`).then(({ page }) => signIn(page, "erin", "Erins-Pass-3"));
      const p = await offer(k);
      assert.equal(await p.evaluate(`document.getElementById('unlock-row').hidden`), false, "asks for the master password");
      await p.evaluate(`(() => { document.getElementById('master').value = 'not it'; document.getElementById('save').click(); })()`);
      await p.waitFor(`document.getElementById('error').textContent.length > 0`, { message: "a wrong master password is refused" });
      await p.evaluate(`(() => { document.getElementById('master').value = ${JSON.stringify(MASTER)}; document.getElementById('save').click(); })()`);
      await waitFor(async () => (await items(k).catch(() => [])).some((i) => i.username === "erin"), { message: "unlocked and saved" });

      // A private window: never. (The main window's tab leaves the sign-in
      // page first, so the one found below is the private window's.)
      await open(k, `${site.origin}/page/Main`);
      await sleep(500);
      const before = (await k.windows()).length;
      await k.invoke("new_window", { private: true, url: `${site.origin}/login` });
      await waitFor(async () => (await k.windows()).length > before, { message: "the private window" });
      const priv = await k.page((t) => t.url === `${site.origin}/login`);
      await priv.waitFor(`document.readyState === "complete" && !!document.getElementById('go')`);
      await signIn(priv, "frank", "Franks-Pass-4");
      assert(await noOffer(k, sleep, 2000), "no offer from a private window");
    },
  },
  {
    name: "password health flags weak and reused passwords; export needs the master password and writes Chrome's CSV",
    async run({ launch, assert }) {
      const dir = mkdtempSync(path.join(tmpdir(), "kessel-passwords-"));
      try {
        const k = await launch();
        await k.invoke("vault_setup", { masterPassword: MASTER });
        const weak = await k.invoke("vault_add_item", { site: "weak.example", username: "a", password: "password1", notes: "" });
        const r1 = await k.invoke("vault_add_item", { site: "one.example", username: "b", password: "Shared-Pass-2026!", notes: "" });
        const r2 = await k.invoke("vault_add_item", { site: "two.example", username: "c", password: "Shared-Pass-2026!", notes: "note, with \"quotes\"" });
        const strong = await k.invoke("vault_add_item", { site: "https://strong.example/login", username: "d", password: "q7#Vt9!pLm2@xZ4&", notes: "" });

        const health = Object.fromEntries((await k.invoke("vault_health")).map((h) => [h.id, h]));
        assert.equal(health[weak].strength, 0, "a common password is weak");
        assert.deepEqual([health[r1].reused, health[r2].reused], [1, 1], "the shared one is reused on 1 other site");
        assert.deepEqual([health[strong].strength, health[strong].reused], [4, 0], "a strong, unique one");

        // The Passwords page shows it.
        await k.invoke("open_singleton_tab", { route: "kessel://passwords" });
        const pw = await k.page((t) => t.url.includes("passwords.html"));
        await pw.waitFor(`document.querySelectorAll('#vault-health .chip').length >= 3`, { message: "the health chips" });
        assert.deepEqual(
          await pw.evaluate(`[...document.querySelectorAll('#vault-health .chip')].map((c) => c.textContent)`),
          ["All 4", "Weak 1", "Reused 2"],
          "counts"
        );
        await pw.evaluate(`[...document.querySelectorAll('#vault-health .chip')].find((c) => c.textContent.startsWith('Reused')).click()`);
        await pw.waitFor(`[...document.querySelectorAll('#vault-list .item-site')].map((e) => e.textContent).sort().join() === 'one.example,two.example'`, { message: "the reused filter" });
        assert(/also used on 1 other site/.test(await pw.evaluate(`document.getElementById('vault-list').innerText`)), "the flag on each");

        // Export: refused without the master password, then Chrome's columns.
        const file = path.join(dir, "passwords.csv");
        let refused = null;
        await k.invoke("vault_export_csv", { masterPassword: "wrong", path: file }).catch((e) => (refused = String(e)));
        assert(refused && /master password/.test(refused), `a wrong master password is refused (${refused})`);
        assert.equal(await k.invoke("vault_export_csv", { masterPassword: MASTER, path: file }), file, "saved where asked");
        const csv = readFileSync(file, "utf8").split("\n");
        assert.equal(csv[0], "name,url,username,password,note", "Chrome's header");
        assert(csv.includes("strong.example,https://strong.example/login,d,q7#Vt9!pLm2@xZ4&,"), "a full address kept as it is");
        assert(csv.includes(`two.example,https://two.example/,c,Shared-Pass-2026!,"note, with ""quotes"""`), "a bare site gets https://, a note is quoted");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "a saved login is offered on the site's sign-in page and filled in with one click -- only the user name until then",
    async run({ launch, site, assert, sleep }) {
      const k = await launch();
      await k.invoke("vault_setup", { masterPassword: MASTER });
      await k.invoke("vault_add_item", { site: "127.0.0.2", username: "gina", password: "Ginas-Saved-Pass-5", notes: "" });
      const { page } = await open(k, `${site.origin}/login`);
      const chip = `[...document.querySelectorAll('div')].find((d) => d.textContent.startsWith('Fill saved password'))`;
      await page.waitFor(`!!${chip}`, { message: "the fill chip" });
      assert.equal(await page.evaluate(`${chip}.textContent`), "Fill saved password (gina)", "it names the account");
      assert.equal(await page.evaluate(`document.getElementById('pass').value`), "", "nothing filled before the click");
      await page.evaluate(`${chip}.click()`);
      await page.waitFor(`document.getElementById('pass').value.length > 0`, { message: "filled in" });
      assert.deepEqual(await page.evaluate(`[document.getElementById('user').value, document.getElementById('pass').value]`), ["gina", "Ginas-Saved-Pass-5"], "both fields");

      // Locked: no chip at all.
      await k.invoke("vault_lock");
      await open(k, `${site.origin}/app-login`).then(() => sleep(1500));
      const other = await k.page((t) => t.url.endsWith("/app-login"));
      assert.equal(await other.evaluate(`!!${chip}`), false, "nothing offered from a locked vault");
    },
  },
  {
    name: "the breach check finds a leaked password (needs a connection)",
    async run({ launch, assert }) {
      const k = await launch();
      await k.invoke("vault_setup", { masterPassword: MASTER });
      const leaked = await k.invoke("vault_add_item", { site: "leaked.example", username: "a", password: "password", notes: "" });
      const fresh = await k.invoke("vault_add_item", { site: "fresh.example", username: "b", password: `Kessel-${Date.now()}-${Math.random().toString(36).slice(2)}`, notes: "" });
      const found = await k.invoke("vault_breach_check");
      assert(found[leaked] > 1000, `"password" is in many breaches (${found[leaked]})`);
      assert.equal(found[fresh], 0, "a random new one is in none");
    },
  },
];
