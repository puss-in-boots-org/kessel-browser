// Security hardening: a site on this PC is a website like any other, and a
// website's links can't open files on this PC or your network.

import { startServer } from "../lib/server.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`document.readyState === "complete"`);
  return page;
}

// A Ctrl+click on a link the page adds (the frame script opens it).
const ctrlClick = (page, href) =>
  page.evaluate(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(href)}; a.textContent = 'x'; document.body.append(a);
    a.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true, button: 0 })); })()`);

export const tests = [
  {
    name: "a site on localhost is a website: it's in the history, and gets none of Kessel's commands",
    async run({ launch, assert, waitFor }) {
      const local = await startServer("127.0.0.1");
      try {
        const k = await launch();
        const url = `${local.origin}/page/Local`;
        const page = await open(k, url);
        await waitFor(async () => (await k.invoke("query_history", {})).some((v) => v.url === url), { message: "the visit in the history" });
        const err = await page.evaluate(`window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke('get_settings').then(() => 'allowed', (e) => String(e)) : 'no ipc'`);
        assert(err !== "allowed", `Kessel's commands refused: ${err}`);
      } finally {
        await local.close();
      }
    },
  },
  {
    name: "Ctrl+click on a website's file:// link opens nothing; other links still open",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const page = await open(k, `${site.origin}/page/Links`);
      await ctrlClick(page, "file://127.0.0.9/share/x.txt");
      await ctrlClick(page, `${site.origin}/page/Opened`);
      await waitFor(async () => (await k.tabs()).some((t) => t.url === `${site.origin}/page/Opened`), { message: "the web link opened" });
      // (The web link came after the file one: had that opened, it would be here by now.)
      await new Promise((r) => setTimeout(r, 500));
      const urls = (await k.tabs()).map((t) => t.url);
      if (urls.some((u) => u.startsWith("file:"))) throw new Error(`a file link opened: ${urls.join(" | ")}`);
    },
  },
];
