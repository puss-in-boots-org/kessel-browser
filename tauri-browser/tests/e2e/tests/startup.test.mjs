// Starting and network (main.rs startup_pages, proxy_args): pages to start
// with, a proxy server of your own and your own engine switches; search
// keywords in the address bar; only the tab you're on playing sound;
// forgetting a site when its last tab closes.

import http from "node:http";
import { startServer } from "../lib/server.mjs";

const focus = async (k, id) => (await k.toolbar()).evaluate(`window.__kesselTest.activateTab(${id})`);
const close = async (k, id) => (await k.toolbar()).evaluate(`window.__kesselTest.closeTab(${id})`);

export const tests = [
  {
    name: "pages to start with; a proxy of your own and your own engine switches",
    async run({ launch, site, assert, waitFor }) {
      const seen = [];
      const proxy = http.createServer((req, res) => {
        seen.push(req.url);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><title>Through the proxy</title><h1>proxied</h1>");
      });
      await new Promise((r) => proxy.listen(0, "127.0.0.5", r));
      try {
        const k = await launch({
          settings: {
            features: {
              startup_pages: [`${site.origin}/page/StartA`, `${site.origin}/page/StartB`],
              proxy: { mode: "fixed", server: `http://127.0.0.5:${proxy.address().port}` },
              engine_flags: "--enable-features=KesselTestFlag",
            },
          },
        });
        await waitFor(async () => {
          const urls = (await k.tabs()).map((t) => t.url);
          return urls.includes(`${site.origin}/page/StartA`) && urls.includes(`${site.origin}/page/StartB`);
        }, { message: "both start pages open" });
        const info = await k.invoke("graphics_info");
        assert(info.engine_args.includes("--proxy-server="), "the proxy given to the engine");
        assert(info.engine_args.includes("KesselTestFlag"), "your engine switch too");
        // A name nobody could look up: only the proxy can answer it.
        const id = (await k.activeTab()).id;
        await k.invoke("navigate", { id, url: "http://kessel-proxy-test.example/" });
        await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.title === "Through the proxy", { message: "the page came through the proxy", timeout: 15000 });
        assert(seen.includes("http://kessel-proxy-test.example/"), "the proxy was asked for it");
      } finally {
        proxy.close();
      }
    },
  },
  {
    name: "a keyword in the address bar searches that engine (your own too)",
    async run({ launch, site, waitFor }) {
      const k = await launch({ settings: { features: { search_engines: [{ id: "local", name: "Local", url: `${site.origin}/page/results?q=%s`, keyword: "lo" }] } } });
      const [tab] = await k.tabs();
      const toolbar = await k.toolbar();
      await toolbar.evaluate(`(() => { const i = document.getElementById('url-input'); i.focus(); i.value = 'lo glass light'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await waitFor(async () => (await k.tabs()).find((t) => t.id === tab.id)?.url === `${site.origin}/page/results?q=glass%20light`, { message: "the local engine's results" });
    },
  },
  {
    name: "only the tab you're on plays sound; a forgotten site's data goes with its last tab",
    async run({ launch, site, waitFor }) {
      const other = await startServer("127.0.0.3");
      try {
        const k = await launch({ settings: { features: { mute_background: true, forget_sites: ["127.0.0.3"] } } });
        const [tab] = await k.tabs();
        const sound = await k.createTab(`${site.origin}/sound/Background`);
        const p = await k.page(`${site.origin}/sound/Background`);
        await p.waitFor(`document.readyState === 'complete'`);
        await focus(k, sound);
        await p.evaluate(`startSound()`, { userGesture: true });
        await waitFor(async () => (await k.tabs()).find((t) => t.id === sound)?.audible, { message: "it plays" });
        await focus(k, tab.id);
        await waitFor(async () => (await k.tabs()).find((t) => t.id === sound)?.muted, { message: "muted in the background" });
        await focus(k, sound);
        await waitFor(async () => !(await k.tabs()).find((t) => t.id === sound)?.muted, { message: "heard again when you go back" });
        await p.evaluate(`stopSound()`);

        const forget = await k.createTab(`${other.origin}/page/Forget`);
        const f = await k.page(`${other.origin}/page/Forget`);
        await f.waitFor(`document.readyState === 'complete'`);
        await f.evaluate(`document.cookie = 'kept=1; max-age=3600; path=/'`);
        await waitFor(async () => (await k.invoke("get_cookies", { site: "127.0.0.3" })).length > 0, { message: "the site's cookie" });
        await close(k, forget);
        await waitFor(async () => (await k.invoke("get_cookies", { site: "127.0.0.3" })).length === 0, { message: "forgotten with its last tab" });
      } finally {
        await other.close();
      }
    },
  },
];
