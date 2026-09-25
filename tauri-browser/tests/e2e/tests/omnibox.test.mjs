// The address bar (src/omnibox.js, suggest.html): suggestions as you type,
// in-place completion, answers, commands, switching to a tab, and the Home
// and Share buttons next to it.

import { execFileSync } from "node:child_process";

// Types `text` into the address bar as a person would (input events).
async function typeInAddressBar(k, text) {
  const toolbar = await k.toolbar();
  await toolbar.evaluate(`(() => { const i = document.getElementById('url-input'); i.focus(); i.select(); })()`);
  await toolbar.session.send("Input.insertText", { text });
  return toolbar;
}

// The suggestion rows once `ready(rows)` holds: [{ kind, text, selected }].
async function suggestions(k, waitFor, ready, message) {
  return waitFor(
    async () => {
      const target = (await k.targets()).find((t) => t.url.includes("suggest.html"));
      if (!target) return null;
      const popup = await k.attach(target);
      const rows = await popup.evaluate(
        `document.visibilityState === 'visible' ? [...document.querySelectorAll('.row')].map(r => ({ kind: [...r.classList].find(c => c.startsWith('kind-')).slice(5), text: r.innerText.replace(/\\s+/g, ' ').trim(), selected: r.classList.contains('selected') })) : []`,
      );
      return ready(rows) && rows;
    },
    { message },
  );
}

async function openPage(k, site, name, id = null) {
  id = id ?? (await k.tabs())[0].id;
  const url = `${site.origin}/page/${encodeURIComponent(name)}`;
  await k.invoke("navigate", { id, url });
  const page = await k.page(url);
  await page.waitFor(`document.readyState === 'complete' && document.title === ${JSON.stringify(name)}`);
  return { id, page, url };
}

const clipboard = {
  read: () => execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" }).replace(/\r?\n$/, ""),
  write: (text) => execFileSync("powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value $input"], { input: text, encoding: "utf8" }),
};

export const tests = [
  {
    name: "typing shows what you typed, your history and bookmarks, answers and commands",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { search_suggestions: false } });
      await openPage(k, site, "Omnibox Visited");
      await k.invoke("add_bookmark", { url: `${site.origin}/page/Omnibox%20Kept`, title: "Omnibox Kept" });
      await waitFor(async () => (await k.invoke("get_history")).some((h) => h.title === "Omnibox Visited"));

      await typeInAddressBar(k, "omnibox");
      const rows = await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "history"), "history in the list");
      assert.equal(rows[0].kind, "search", "first: search for what you typed");
      assert(rows[0].selected, "and it's selected");
      assert(rows.some((r) => r.kind === "bookmark" && r.text.includes("Omnibox Kept")), "the bookmark");
      assert(rows.some((r) => r.kind === "history" && r.text.includes("Omnibox Visited") && r.text.includes("/page/Omnibox Visited")), "the visit, its address readable");

      await typeInAddressBar(k, "12*12");
      const calc = await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "answer"), "a calculator answer");
      assert(calc.find((r) => r.kind === "answer").text.startsWith("= 144"), "12*12 = 144");

      await typeInAddressBar(k, "clear cache");
      const cmd = await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "command"), "a command");
      assert(cmd.find((r) => r.kind === "command").text.includes("Clear browsing data"), "Kessel's command, by another name");
    },
  },
  {
    name: "a site you've been to completes in place, and Enter goes to its real address",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { search_suggestions: false } });
      await openPage(k, site, "Completed");
      const port = new URL(site.origin).port;
      await k.createTab();
      await waitFor(async () => (await k.tabs()).length === 2);
      const toolbar = await typeInAddressBar(k, "127.0");
      await toolbar.waitFor(`document.getElementById('url-input').value === '127.0.0.2:${port}'`, { message: "completed to the site with its port" });
      assert.deepEqual(await toolbar.evaluate(`[document.getElementById('url-input').selectionStart, document.getElementById('url-input').selectionEnd]`), [5, `127.0.0.2:${port}`.length], "the added part is selected");
      await toolbar.key("Enter");
      await waitFor(async () => (await k.activeTab()).url === `${site.origin}/`, { message: "went to http://127.0.0.2:port/ (not https)" });
    },
  },
  {
    name: "Up / Down pick a suggestion; Enter opens it, Alt+Enter in a new tab",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { search_suggestions: false } });
      const { id } = await openPage(k, site, "Arrow Target");
      // Somewhere else now, so it's a visit to go back to, not an open tab
      // to switch to.
      await openPage(k, site, "Elsewhere", id);
      const toolbar = await typeInAddressBar(k, "arrow target");
      await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "history"), "the visit listed");
      await toolbar.key("down");
      await suggestions(k, waitFor, (r) => r[1]?.selected, "second row selected");
      assert((await toolbar.evaluate(`document.getElementById('url-input').value`)).includes("/page/Arrow%20Target"), "the address shows the pick");
      await toolbar.key("Alt+Enter");
      await waitFor(async () => (await k.tabs()).length === 2 && (await k.activeTab()).title === "Arrow Target", { message: "opened in a new tab" });
      await typeInAddressBar(k, "arrow target");
      await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "history"), "listed again");
      await toolbar.key("down");
      await toolbar.key("Enter");
      await waitFor(async () => (await k.activeTab()).url.includes("/page/Arrow%20Target"), { message: "opened here" });
    },
  },
  {
    name: "Shift+Delete removes a page from history",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { search_suggestions: false } });
      await openPage(k, site, "Forget This");
      await waitFor(async () => (await k.invoke("get_history")).some((h) => h.title === "Forget This"));
      const toolbar = await typeInAddressBar(k, "forget this");
      await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "history"), "the visit listed");
      await toolbar.key("down");
      await toolbar.key("Shift+Delete");
      await waitFor(async () => !(await k.invoke("get_history")).some((h) => h.title === "Forget This"), { message: "gone from history" });
      await suggestions(k, waitFor, (r) => r.length && !r.some((x) => x.kind === "history"), "and from the list");
      assert(true, "removed");
    },
  },
  {
    name: "Switch to tab",
    async run({ launch, site, waitFor }) {
      const k = await launch({ settings: { search_suggestions: false } });
      const { id: first } = await openPage(k, site, "Faraway Tab");
      await k.createTab(`${site.origin}/page/Here`);
      await waitFor(async () => (await k.activeTab()).title === "Here");
      const toolbar = await typeInAddressBar(k, "faraway");
      const rows = await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "tab"), "a Switch to tab row");
      const index = rows.findIndex((r) => r.kind === "tab");
      for (let i = 0; i < index; i++) await toolbar.key("down");
      await toolbar.key("Enter");
      await waitFor(async () => (await k.activeTab()).id === first, { message: "switched to it" });
    },
  },
  {
    name: "an answer is copied with Enter",
    async run({ launch, assert, waitFor }) {
      const k = await launch({ settings: { search_suggestions: false } });
      const saved = clipboard.read();
      try {
        const toolbar = await typeInAddressBar(k, "3*7");
        await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "answer"), "the answer");
        await toolbar.key("down");
        await toolbar.key("Enter");
        await waitFor(() => clipboard.read() === "21", { message: "21 on the clipboard" });
        assert(true, "copied");
      } finally {
        clipboard.write(saved);
      }
    },
  },
  {
    name: "a command runs from the address bar",
    async run({ launch, waitFor }) {
      const k = await launch({ settings: { search_suggestions: false } });
      const toolbar = await typeInAddressBar(k, "browsing history");
      const rows = await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "command"), "the History command");
      const index = rows.findIndex((r) => r.kind === "command");
      for (let i = 0; i < index; i++) await toolbar.key("down");
      await toolbar.key("Enter");
      await waitFor(async () => (await k.activeTab())?.url === "kessel://history", { message: "History opened" });
    },
  },
  {
    name: "Escape closes the list and drops the completion",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { search_suggestions: false } });
      await openPage(k, site, "Esc Page");
      const toolbar = await typeInAddressBar(k, "127.0");
      await toolbar.waitFor(`document.getElementById('url-input').value.startsWith('127.0.0.2:')`, { message: "completed" });
      await toolbar.key("Escape");
      assert.equal(await toolbar.evaluate(`document.getElementById('url-input').value`), "127.0", "back to what you typed");
      await suggestions(k, waitFor, (r) => r.length === 0, "the list closed");
    },
  },
  {
    name: "an address typed without https falls back to http",
    async run({ launch, site, waitFor }) {
      const k = await launch({ settings: { search_suggestions: false } });
      const host = new URL(site.origin).host;
      const toolbar = await typeInAddressBar(k, `${host}/page/Plain%20Http`);
      await toolbar.key("Enter");
      await waitFor(async () => (await k.activeTab()).title === "Plain Http", { message: "loaded over http after https failed", timeout: 20000 });
    },
  },
  {
    name: "answers from the internet: currency, definitions, search suggestions (needs a connection)",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      await typeInAddressBar(k, "100 usd to eur");
      const money = (await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "answer"), "a currency answer")).find((r) => r.kind === "answer").text;
      assert(money.includes("100.00 USD =") && /[\d.]+ EUR/.test(money) && /ECB rate of \d{4}-\d{2}-\d{2}/.test(money), money);
      await typeInAddressBar(k, "define ephemeral");
      const word = await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "answer" && x.text.startsWith("ephemeral")), "a definition");
      assert(/ephemeral · adjective .*Wiktionary/.test(word.find((r) => r.kind === "answer").text), word.find((r) => r.kind === "answer").text);
      await typeInAddressBar(k, "weather");
      await suggestions(k, waitFor, (r) => r.some((x) => x.kind === "suggestion"), "Google's suggestions");
    },
  },
  {
    name: "search suggestions can be turned off",
    async run({ launch, assert, waitFor, sleep }) {
      const k = await launch({ settings: { search_suggestions: false } });
      await typeInAddressBar(k, "weather");
      await suggestions(k, waitFor, (r) => r.length >= 1, "the list");
      await sleep(2500);
      const rows = await suggestions(k, waitFor, () => true, "the list again");
      assert(!rows.some((r) => r.kind === "suggestion"), "no search engine suggestions");
    },
  },
  {
    name: "the Home button goes home, and Settings can hide it",
    async run({ launch, site, waitFor }) {
      const k = await launch({ settings: { homepage: `${site.origin}/page/Home%20Base` } });
      await openPage(k, site, "Away");
      const toolbar = await k.toolbar();
      await toolbar.clickSelector("#home-btn");
      await waitFor(async () => (await k.activeTab()).title === "Home Base", { message: "home" });
      const settings = await k.invoke("get_settings");
      await k.invoke("update_settings", { settings: { ...settings, show_home_button: false } });
      await toolbar.waitFor(`document.getElementById('home-btn').hidden`, { message: "hidden" });
    },
  },
  {
    name: "Home with the new-tab page as home stays in the same tab",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id } = await openPage(k, site, "Leaving");
      await (await k.toolbar()).clickSelector("#home-btn");
      await waitFor(async () => (await k.activeTab()).url === "kessel://newtab", { message: "the new-tab page" });
      assert.equal((await k.tabs()).length, 1, "no extra tab");
      assert.equal((await k.activeTab()).id, id, "the same tab");
      await k.page("newtab.html");
    },
  },
  {
    name: "the Share button: the page's QR code, and Copy link",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const { url } = await openPage(k, site, "Shared Page");
      const toolbar = await k.toolbar();
      await toolbar.waitFor(`!document.getElementById('share-btn').hidden`, { message: "share button on a web page" });
      await toolbar.clickSelector("#share-btn");
      const share = await k.page("share.html");
      await share.waitFor(`!!document.querySelector('#qr svg')`, { message: "a QR code" });
      assert.equal(await share.evaluate(`document.getElementById('url').textContent`), url, "for this page");
      const saved = clipboard.read();
      try {
        await share.clickSelector("#copy-link");
        await waitFor(() => clipboard.read() === url, { message: "the link on the clipboard" });
        // The popup closes after copying; open it again for the QR image.
        await waitFor(async () => !(await k.targets()).some((t) => t.url.includes("share.html")), { message: "closed" });
        await sleep(500); // a click right as a popup closes is the click that closed it
        await toolbar.clickSelector("#share-btn");
        const again = await k.page("share.html");
        await again.waitFor(`!!document.querySelector('#qr svg')`);
        await again.clickSelector("#copy-qr");
        const imageSize = () => execFileSync("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { \"$($i.Width)x$($i.Height)\" }"], { encoding: "utf8" }).trim();
        await waitFor(() => imageSize() === "512x512", { message: "the QR code as an image on the clipboard" });
      } finally {
        clipboard.write(saved);
      }
      // Windows' own Share window opens for the page.
      await k.invoke("share_page", { url, title: "Shared Page" });
    },
  },
];
