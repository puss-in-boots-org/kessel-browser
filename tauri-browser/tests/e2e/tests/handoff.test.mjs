// Links from other apps (instance.rs): a second kessel.exe start with an
// address -- what Windows runs when Kessel is your default browser -- hands
// it to the Kessel already running, which opens it in a tab in front. With
// the window minimized too: WebView2 can't make a page in a minimized window
// (main.rs restore_for_new_page), so such tabs used to stay blank for good.

import { spawn } from "node:child_process";
import { EXE } from "../lib/kessel.mjs";

// Another app opening `url` in your default browser.
function linkFromAnotherApp(k, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, ["--profile-dir", k.profileDir, url], { stdio: "ignore" });
    const timer = setTimeout(() => reject(new Error("the second start didn't hand the link over")), 15000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const minimize = async (k) => (await k.toolbar()).evaluate(`window.__TAURI__.window.getCurrentWindow().minimize()`);
const minimized = async (k) => (await k.toolbar()).evaluate(`window.__TAURI__.window.getCurrentWindow().isMinimized()`);

// The page at `url` has loaded in a real tab (there's a page to talk to,
// and it says its own title).
async function loads(k, waitFor, url, title) {
  const page = await k.page(url, { timeout: 15000 });
  await page.waitFor(`document.readyState === "complete" && document.title === ${JSON.stringify(title)}`, { timeout: 15000 });
  await waitFor(async () => (await k.tabs()).some((t) => t.url === url && t.title === title && t.active), { message: `an active tab titled ${title}` });
}

export const tests = [
  {
    name: "a link from another app opens in a tab in front",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const url = `${site.origin}/page/FromApp`;
      await linkFromAnotherApp(k, url);
      await loads(k, waitFor, url, "FromApp");
    },
  },
  {
    name: "a link from another app while Kessel is minimized: the window comes back and the page loads",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await minimize(k);
      await waitFor(() => minimized(k), { message: "the window minimized" });
      const url = `${site.origin}/page/WhileMinimized`;
      await linkFromAnotherApp(k, url);
      await loads(k, waitFor, url, "WhileMinimized");
      assert(!(await minimized(k)), "the window is back on screen");
    },
  },
  {
    name: "a tab opened while the window is minimized still gets its page",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      await minimize(k);
      await waitFor(() => minimized(k), { message: "the window minimized" });
      const url = `${site.origin}/page/MadeMinimized`;
      await k.createTab(url);
      await loads(k, waitFor, url, "MadeMinimized");
    },
  },
];
