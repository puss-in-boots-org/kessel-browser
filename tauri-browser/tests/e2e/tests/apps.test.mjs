// Sites installed as apps (apps.rs) and one Kessel per profile
// (instance.rs): a later start hands what it was asked for -- a link, an
// app -- to the Kessel already open, and goes.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXE, Kessel } from "../lib/kessel.mjs";

// Starts kessel.exe again with `args`; resolves with its exit code.
function startAgain(args, { timeout = 20000 } = {}) {
  const child = spawn(EXE, args, { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the second Kessel didn't go within ${timeout} ms`));
    }, timeout);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export const tests = [
  {
    name: "a site with a manifest: the address bar offers it; installed, it's in the Start menu with its icon, opens in a window of its own, and can go again",
    async run({ launch, site, assert }) {
      const folder = mkdtempSync(path.join(tmpdir(), "kessel-apps-"));
      try {
        const k = await launch();
        const toolbar = await k.toolbar();
        const [tab] = await k.tabs();
        await k.invoke("navigate", { id: tab.id, url: `${site.origin}/webapp/` });
        await toolbar.waitFor(`!document.getElementById('install-app-btn').hidden`, { message: "the address bar's install button" });
        assert.equal(await toolbar.evaluate(`document.getElementById('install-app-btn').title`), "Install Test Web App as an app");

        const app = await k.invoke("install_app", { id: tab.id, dir: folder });
        assert.equal(app.name, "Test Web App", "the manifest's name");
        assert.equal(app.url, `${site.origin}/webapp/start?from=app`, "its start page");
        assert(existsSync(path.join(folder, "Test Web App.lnk")), "a shortcut");
        const ico = readFileSync(path.join(k.profileDir, "Data", "apps", `${app.id}.ico`));
        assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0], "its icon, as an .ico");
        await toolbar.waitFor(`document.getElementById('install-app-btn').hidden`, { message: "installed: no button" });
        assert.deepEqual((await k.invoke("list_apps")).map((a) => a.name), ["Test Web App"]);

        // Its window: the start page, without the browser's toolbar.
        const before = (await k.windows()).length;
        await k.invoke("open_app", { id: app.id });
        await k.page((t) => t.url === app.url, { timeout: 15000 });
        assert.equal((await k.windows()).length, before, "no browser window more");

        await k.invoke("uninstall_app", { id: app.id });
        assert(!existsSync(path.join(folder, "Test Web App.lnk")), "the shortcut gone");
        assert.deepEqual(await k.invoke("list_apps"), [], "no apps");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  },
  {
    name: "started again on the same profile, Kessel hands the link or the app to the one already open and goes",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const link = `${site.origin}/page/Handed`;
      assert.equal(await startAgain(["--profile-dir", k.profileDir, link]), 0, "the second Kessel went");
      await waitFor(async () => (await k.tabs()).some((t) => t.url === link && t.active), { message: "the link as a tab, in front" });
      assert.equal((await k.windows()).length, 1, "in the window already open");

      const start = `${site.origin}/webapp/start`;
      assert.equal(await startAgain(["--profile-dir", k.profileDir, `--app=${start}`]), 0, "and again");
      await k.page((t) => t.url === start, { timeout: 15000 });
    },
  },
  {
    name: "an app's shortcut with Kessel closed: just the app's window",
    async run({ site, assert, waitFor }) {
      const profileDir = mkdtempSync(path.join(tmpdir(), "kessel-e2e-"));
      // (As launch() does: the test pages are plain http.)
      mkdirSync(path.join(profileDir, "Data"), { recursive: true });
      writeFileSync(path.join(profileDir, "Data", "settings.json"), JSON.stringify({ shields_https_upgrade: false }));
      const port = 9850 + Math.floor(Math.random() * 100);
      const start = `${site.origin}/webapp/start`;
      const child = spawn(EXE, ["--profile-dir", profileDir, `--app=${start}`], { env: { ...process.env, KESSEL_REMOTE_DEBUGGING_PORT: String(port) }, stdio: "ignore" });
      const k = new Kessel(child, port, profileDir, []);
      try {
        await waitFor(async () => (await k.targets().catch(() => [])).some((t) => t.url === start), { timeout: 30000, message: "the app's page" });
        await new Promise((r) => setTimeout(r, 1000));
        assert.deepEqual(await k.windows(), [], "no browser window");
      } finally {
        await k.close();
      }
    },
  },
];
