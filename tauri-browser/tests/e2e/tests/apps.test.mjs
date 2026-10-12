// Sites installed as apps (apps.rs) and one Kessel per profile
// (instance.rs): a later start hands what it was asked for -- a link, an
// app -- to the Kessel already open, and goes.

import { execFileSync, spawn } from "node:child_process";
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

const regValue = (key, name = null) => {
  try {
    const out = execFileSync("reg", ["query", `HKCU\\${key}`, ...(name ? ["/v", name] : ["/ve"])], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).find((l) => /REG_SZ/.test(l))?.split("REG_SZ")[1].trim() ?? "";
  } catch {
    return null;
  }
};

export const tests = [
  {
    name: "an app's manifest: its shortcuts, the files it opens (Open with -> its launchQueue), its web+ links, links into it, its badge",
    async run({ launch, site, assert, waitFor }) {
      const folder = mkdtempSync(path.join(tmpdir(), "kessel-apps-"));
      const k = await launch();
      const root = `Software\\KesselTest\\${k.child.pid}`;
      try {
        const [tab] = await k.tabs();
        await k.invoke("navigate", { id: tab.id, url: `${site.origin}/webapp/` });
        const toolbar = await k.toolbar();
        await toolbar.waitFor(`!document.getElementById('install-app-btn').hidden`, { message: "installable" });
        const app = await k.invoke("install_app", { id: tab.id, dir: folder });
        const o = site.origin;
        assert.equal(app.extras.scope, `${o}/webapp/`, "its scope");
        assert.deepEqual(app.extras.shortcuts, [["New note", `${o}/webapp/new`]], "its shortcuts -- not another site's");
        assert.deepEqual(app.extras.file_handlers, [[`${o}/webapp/open`, [".kesseltxt"]]], "the files it opens");
        assert.deepEqual(app.extras.protocols, [["web+kesseltest", `${o}/webapp/handle?l=%s`]], "its web+ links -- not javascript:");

        const fileClass = `Kessel.App.${app.id}.File0`;
        assert(regValue(`${root}\\Classes\\${fileClass}\\shell\\open\\command`)?.endsWith(`--app-file "%1"`), "Open with: its command");
        assert.equal(regValue(`${root}\\Classes\\.kesseltxt\\OpenWithProgids`, fileClass), "", "offered for .kesseltxt files");
        assert(regValue(`${root}\\Classes\\web+kesseltest\\shell\\open\\command`)?.endsWith("--single-argument %1"), "web+kesseltest: links");

        // Opened with a file.
        const note = path.join(folder, "note.kesseltxt");
        writeFileSync(note, "hi there");
        assert.equal(await startAgain(["--profile-dir", k.profileDir, `--app=${o}/webapp/open`, "--app-file", note]), 0);
        const opened = await k.page((t) => t.url === `${o}/webapp/open`, { timeout: 15000 });
        await opened.waitFor(`document.title === "Opened note.kesseltxt: hi there"`, { message: "the file, through its launchQueue" });

        // Its links, from another program. (From a page too -- but the engine
        // only says so for schemes Windows knows, and a test run registers
        // them under a key of its own.)
        assert.equal(await startAgain(["--profile-dir", k.profileDir, "--single-argument", "web+kesseltest:hello"]), 0);
        await k.page((t) => t.url.startsWith(`${o}/webapp/handle?l=web%2Bkesseltest%3Ahello`), { timeout: 15000 });
        const page = await k.page((t) => t.url === `${o}/webapp/`);

        // A link into it from another program: its window, not a tab.
        assert.equal(await startAgain(["--profile-dir", k.profileDir, `${o}/webapp/start?captured=1`]), 0);
        await k.page((t) => t.url === `${o}/webapp/start?captured=1`, { timeout: 15000 });
        assert(!(await k.tabs()).some((t) => t.url.includes("captured=1")), "not a tab");

        // Badges: the app window's taskbar button, a tab's icon.
        await opened.evaluate(`navigator.setAppBadge(5)`);
        await waitFor(async () => Object.values(await k.invoke("app_badges")).includes(5), { message: "the app's badge" });
        await page.evaluate(`navigator.setAppBadge(3)`);
        await toolbar.waitFor(`document.querySelector('.tab.has-badge .tab-favicon')?.dataset.badge === "3"`, { message: "the tab's badge" });
        await page.evaluate(`navigator.clearAppBadge()`);
        await toolbar.waitFor(`!document.querySelector('.tab.has-badge')`, { message: "gone" });

        await k.invoke("uninstall_app", { id: app.id });
        assert.equal(regValue(`${root}\\Classes\\${fileClass}\\shell\\open\\command`), null, "Open with gone");
        assert.equal(regValue(`${root}\\Classes\\web+kesseltest\\shell\\open\\command`), null, "its links gone");
      } finally {
        rmSync(folder, { recursive: true, force: true });
        try {
          execFileSync("reg", ["delete", `HKCU\\${root}`, "/f"], { stdio: "ignore" });
          execFileSync("reg", ["delete", "HKCU\\Software\\KesselTest", "/f"], { stdio: "ignore" });
        } catch {}
      }
    },
  },
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
