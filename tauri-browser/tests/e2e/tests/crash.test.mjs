// Crashes and how Kessel copes (crash.rs), the task manager (tasks.rs,
// tasks.html) and kessel://diagnostics: a crashed page, a hung one, safe
// mode, tabs offered back after Kessel closed unexpectedly, a damaged
// settings file, and the engine itself going.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { sleep } from "../lib/kessel.mjs";
import { extensionFiles, writeExtension } from "../lib/extension.mjs";

async function open(k, url) {
  const id = await k.createTab(url);
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`document.readyState === "complete"`);
  return { id, page };
}

const tab = async (k, id) => (await k.tabs()).find((t) => t.id === id);

// Crashes the page's process (the DevTools protocol's Page.crash). The
// session goes with it, so nothing is waited for.
function crash(page) {
  page.session.send("Page.crash", {}, { timeout: 3000 }).catch(() => {});
}

// `promise` fails, with a message matching `pattern`.
async function rejects(promise, pattern, message) {
  try {
    await promise;
  } catch (e) {
    if (!pattern.test(String(e.message || e))) throw new Error(`assertion failed: ${message}: ${e.message || e}`);
    return;
  }
  throw new Error(`assertion failed: ${message}: it didn't fail`);
}

const killPid = (pid) => {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
};

export const tests = [
  {
    name: "a crashed page: the tab you're on says so and Reload brings it back; one in the background sleeps until you come back",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const other = await startServer("127.0.0.3");
      try {
        const a = await open(k, `${site.origin}/page/Behind`);
        const b = await open(k, `${other.origin}/page/Front`);

        // The tab you're on.
        crash(b.page);
        try {
          await waitFor(async () => (await tab(k, b.id))?.url.startsWith("kessel://warning") && (await tab(k, b.id)).url.includes("kind=crashed"), { message: "the crashed page" });
        } catch (e) {
          throw new Error(`${e.message}; the tab: ${JSON.stringify(await tab(k, b.id))}; crashes: ${JSON.stringify(await k.invoke("crash_reports"))}; targets: ${JSON.stringify((await k.targets()).map((t) => t.url))}`);
        }
        const warning = await k.page((t) => t.url.includes("warning.html") && t.url.includes("kind=crashed"));
        await warning.waitFor(`document.getElementById('title').textContent.length > 0`);
        assert.equal(await warning.evaluate(`document.getElementById('title').textContent`), "This page crashed", "says what happened");
        assert.equal(await warning.evaluate(`document.getElementById('back').textContent`), "Reload", "offers Reload");
        const toolbar = await k.toolbar();
        assert.equal(await toolbar.evaluate(`document.getElementById('url-input').value`), `${other.origin}/page/Front`, "the address bar keeps the page's address");
        await warning.evaluate(`document.getElementById('back').click()`);
        await waitFor(async () => (await tab(k, b.id))?.url === `${other.origin}/page/Front`, { message: "reloaded" });
        await k.page((t) => t.url === `${other.origin}/page/Front`);

        // One in the background: asleep, and back when you click it.
        crash(a.page);
        await waitFor(async () => (await tab(k, a.id))?.discarded, { message: "the background tab asleep" });
        await toolbar.evaluate(`window.__kesselTest.activateTab(${a.id})`);
        const again = await k.page((t) => t.url === `${site.origin}/page/Behind`);
        await again.waitFor(`document.readyState === "complete"`);
        assert(!(await k.tabs()).find((t) => t.url === `${site.origin}/page/Behind`).discarded, "awake again");

        const reports = await k.invoke("crash_reports");
        assert(reports.some((r) => r.kind === "page" && r.url === `${other.origin}/page/Front`), "the crash is in the log");
      } finally {
        await other.close();
      }
    },
  },
  {
    name: "a page that stops responding: a chip offers to close it, and closing it ends its process",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { id, page } = await open(k, `${site.origin}/page/Busy`);
      // Stuck in a loop. (The engine's "not responding" is stood in for:
      // nothing a test can send makes WebView2 notice one.)
      await page.evaluate(`setTimeout(() => { for (;;) {} }, 100), 1`);
      await sleep(400);
      await k.invoke("test_page_unresponsive", { id });
      await waitFor(async () => (await tab(k, id))?.hung, { message: "the toolbar knows it isn't responding" });
      const toolbar = await k.toolbar();
      assert(!(await toolbar.evaluate(`document.getElementById('hang-btn').hidden`)), "the chip shows");
      assert.equal(await k.invoke("page_responding", { id }), false, "it doesn't answer");
      await k.invoke("end_tab_process", { id });
      await waitFor(async () => (await tab(k, id))?.url.includes("kind=crashed"), { message: "closed: the crashed page", timeout: 15000 });
      const warning = await k.page((t) => t.url.includes("warning.html") && t.url.includes("kind=crashed"));
      await warning.waitFor(`document.getElementById('title').textContent.length > 0`);
      assert.equal(await warning.evaluate(`document.getElementById('title').textContent`), "This page was closed", "says you closed it");
      assert(!(await tab(k, id)).hung, "no chip any more");
    },
  },
  {
    name: "the task manager: the engine, its helpers and each tab's process, with memory; end a page's process, put a tab to sleep and wake it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const other = await startServer("127.0.0.3");
      try {
        const a = await open(k, `${site.origin}/page/Listed`);
        const b = await open(k, `${other.origin}/page/Ended`);
        await k.invoke("open_singleton_tab", { route: "kessel://tasks" });
        const tasks = await k.page((t) => t.url.includes("tasks.html"));
        const list = await waitFor(async () => {
          const l = await tasks.evaluate(`window.__TAURI__.core.invoke('task_manager')`);
          return l.processes.some((p) => p.tabs.some((t) => t.id === a.id)) && l.processes.some((p) => p.tabs.some((t) => t.id === b.id)) && l;
        }, { message: "both tabs listed" });
        const kinds = new Set(list.processes.map((p) => p.kind));
        for (const kind of ["kessel", "browser", "gpu", "utility", "renderer"]) assert(kinds.has(kind), `a ${kind} process is listed`);
        assert(list.processes.some((p) => p.kind === "utility" && p.title === "Network"), "the network helper, by name");
        assert(list.processes.some((p) => p.kind === "renderer" && p.title.startsWith("Kessel: ") && p.title.includes("Toolbar")), "the toolbar's process");
        const listed = list.processes.find((p) => p.tabs.some((t) => t.id === a.id));
        assert.equal(listed.title, "Listed", "a page's process is named after its tab");
        assert(listed.memory > 1024 * 1024, "with its memory");
        assert(!list.processes.find((p) => p.kind === "browser").killable, "the engine itself can't be ended");
        // The page shows it.
        await tasks.waitFor(`[...document.querySelectorAll('#rows tr')].some((tr) => tr.textContent.includes('Listed') && tr.querySelector('[data-end]'))`, { message: "the page lists it" });

        // End B's process: it's a crash as far as the tab knows.
        const ended = list.processes.find((p) => p.tabs.some((t) => t.id === b.id));
        await tasks.evaluate(`window.__TAURI__.core.invoke('end_process', { pid: ${ended.pid} })`);
        await waitFor(async () => (await tab(k, b.id))?.discarded, { message: "B (in the background) asleep after its process ended" });
        await rejects(tasks.evaluate(`window.__TAURI__.core.invoke('end_process', { pid: ${list.processes.find((p) => p.kind === "browser").pid} })`), /can't be ended/, "the engine refuses");
        await rejects(tasks.evaluate(`window.__TAURI__.core.invoke('end_process', { pid: ${process.pid} })`), /isn't running/, "nothing that isn't Kessel's");

        // Sleep and wake A from the task manager.
        const win = (await k.windows())[0];
        await tasks.evaluate(`window.__TAURI__.core.invoke('task_action', { window: ${JSON.stringify(win)}, id: ${a.id}, action: 'sleep' })`);
        await waitFor(async () => (await tab(k, a.id))?.discarded, { message: "A asleep" });
        await tasks.waitFor(`!!document.querySelector('[data-asleep="${a.id}"]')`, { message: "listed as asleep" });
        await tasks.evaluate(`document.querySelector('[data-wake="${a.id}"]').click()`);
        await waitFor(async () => (await k.tabs()).some((t) => t.url === `${site.origin}/page/Listed` && t.active && !t.discarded), { message: "A awake and shown" });
      } finally {
        await other.close();
      }
    },
  },
  {
    name: "kessel://diagnostics: Windows, the processor, memory, storage, crash reports and web features",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await open(k, `${site.origin}/page/Doomed`);
      crash(page);
      // (The page's process takes its time to go when the PC is busy.)
      await waitFor(async () => (await k.invoke("crash_reports")).length > 0, { message: "a crash to show", timeout: 25000 });
      await k.invoke("open_singleton_tab", { route: "kessel://diagnostics/crashes" });
      const diag = await k.page((t) => t.url.includes("diagnostics.html"));
      await diag.waitFor(`!!document.getElementById('features')`, { message: "rendered" });
      const text = await diag.evaluate(`document.body.innerText`);
      assert(/Windows 1[01]/.test(text), "the Windows version");
      const sys = await diag.evaluate(`window.__TAURI__.core.invoke('system_info')`);
      assert(sys.cpu.length > 3, "the processor's name");
      assert(sys.memory.total > 1024 ** 3, "the memory");
      assert(sys.storage.length >= 2 && sys.storage.every((s) => s.bytes >= 0), "how much room the data takes");
      assert(text.includes("A page's process stopped"), "the crash, in words");
      assert(text.includes("/page/Doomed"), "on which page");
      assert(/WebGPU/.test(text) && /WebUSB/.test(text), "web features");
      // Clear the log.
      await diag.evaluate(`document.getElementById('clear-crashes-btn').click()`);
      await waitFor(async () => (await k.invoke("crash_reports")).length === 0, { message: "cleared" });
    },
  },
  {
    name: "safe mode (--safe-mode): no graphics card nor your engine switches, a chip that says so",
    async run({ launch, assert, waitFor }) {
      const k = await launch({ args: ["--safe-mode"], settings: { shields_https_upgrade: false, features: { engine_flags: "--lang=hu" } } });
      const toolbar = await k.toolbar();
      await waitFor(async () => (await toolbar.evaluate(`window.__kesselTest.notices()`)).some((n) => n.id === "safe-mode"), { message: "the safe mode notice" });
      assert(!(await toolbar.evaluate(`document.getElementById('notice-btn').hidden`)), "the chip shows");
      assert.equal(await toolbar.evaluate(`document.querySelector('#notice-btn span').textContent`), "Safe mode", "and says so");
      const g = await k.invoke("graphics_info");
      assert(g.engine_args.includes("--disable-gpu"), "no graphics card");
      assert(!g.engine_args.includes("--lang=hu"), "none of your own switches");
      assert.equal(g.restart_needed, false, "nothing to restart for");
      assert.equal(g.safe_mode, "you started it in safe mode", "why");
    },
  },
  {
    name: "safe mode leaves your extensions installed but doesn't run them",
    async run({ launch, site, assert, waitFor }) {
      const dir = writeExtension(mkdtempSync(path.join(tmpdir(), "kessel-ext-")), extensionFiles({ marker: "on" }));
      const marked = async (k) => {
        const url = `${site.origin}/page/Ext?${Date.now()}`;
        const { page } = await open(k, url);
        await sleep(500);
        return page.evaluate(`document.documentElement.dataset.kesselExt || ""`);
      };
      const first = await launch({ keepProfile: true });
      await first.invoke("load_unpacked_extension", { path: dir });
      await waitFor(async () => (await marked(first)) === "on", { message: "the extension runs", timeout: 20000 });
      await first.close({ keepProfile: true });

      const k = await launch({ profileDir: first.profileDir, args: ["--safe-mode"] });
      assert.equal(await marked(k), "", "not in safe mode");
      await sleep(1500);
      assert.equal(await marked(k), "", "not even a moment later");
      const list = await k.invoke("list_extensions");
      assert(list.length === 1 && list[0].enabled && !list[0].error, "still installed, on, and nothing wrong with it");
    },
  },
  {
    name: "the graphics process keeps crashing: Kessel offers to stop using the graphics card",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      let last = null;
      for (let i = 0; i < 3; i++) {
        const gpu = await waitFor(async () => (await k.invoke("task_manager")).processes.find((p) => p.kind === "gpu" && p.pid !== last), { message: `a graphics process (${i + 1})`, timeout: 20000 });
        last = gpu.pid;
        killPid(gpu.pid);
        // (Crashes a moment apart: one report each.)
        await sleep(3500);
      }
      const toolbar = await k.toolbar();
      const notice = await waitFor(async () => (await toolbar.evaluate(`window.__kesselTest.notices()`)).find((n) => n.id === "gpu"), { message: "the offer" });
      assert(notice.detail >= 3, "after three");
      assert.equal(await toolbar.evaluate(`document.querySelector('#notice-btn span').textContent`), "Graphics problem", "the chip");
      assert((await k.invoke("crash_reports")).filter((r) => r.kind === "gpu").length >= 3, "each one noted");
    },
  },
  {
    name: "two starts in a row that never finished: safe mode by itself",
    async run({ launch, assert, waitFor }) {
      const dir = mkdtempSync(path.join(tmpdir(), "kessel-e2e-"));
      mkdirSync(path.join(dir, "Data"), { recursive: true });
      writeFileSync(path.join(dir, "Data", "settings.json"), JSON.stringify({ shields_https_upgrade: false }));
      // The run before this one died while starting, and so had the one before.
      writeFileSync(path.join(dir, "Data", "running.json"), JSON.stringify({ state: "starting", startup_crashes: 1 }));
      const k = await launch({ profileDir: dir });
      const toolbar = await k.toolbar();
      const notices = await waitFor(async () => {
        const n = await toolbar.evaluate(`window.__kesselTest.notices()`);
        return n.length && n;
      }, { message: "a notice" });
      const safe = notices.find((n) => n.id === "safe-mode");
      assert(safe && /twice/.test(safe.detail), "safe mode, because it didn't get going twice");
      assert((await k.invoke("graphics_info")).engine_args.includes("--disable-gpu"), "really in safe mode");
      // Up now: the next start is a normal one.
      await waitFor(() => JSON.parse(readFileSync(path.join(dir, "Data", "running.json"), "utf8")).state === "running", { message: "marked as running" });
    },
  },
  {
    name: "closed unexpectedly: the next start offers the tabs back (when it doesn't bring them back by itself)",
    async run({ launch, site, assert, waitFor }) {
      const first = await launch({ keepProfile: true });
      await open(first, `${site.origin}/page/Remembered`);
      await waitFor(() => (first.readProfileFile("Data/session.json") || "").includes("/page/Remembered"), { message: "the session saved" });
      await first.close({ keepProfile: true }); // killed: not a proper close

      const k = await launch({ profileDir: first.profileDir });
      const toolbar = await k.toolbar();
      const restore = await waitFor(async () => (await toolbar.evaluate(`window.__kesselTest.notices()`)).find((n) => n.id === "restore"), { message: "the offer" });
      assert(restore.detail >= 1, "with how many tabs");
      assert(!(await k.tabs()).some((t) => t.url.endsWith("/page/Remembered")), "not brought back by itself");
      assert((await k.invoke("crash_reports")).some((r) => r.kind === "kessel" && /unexpectedly/.test(r.reason)), "noted in the crash log");
      await k.invoke("restore_previous_session");
      await waitFor(async () => {
        for (const w of await k.windows()) if ((await k.tabs(w)).some((t) => t.url.endsWith("/page/Remembered"))) return true;
        return false;
      }, { message: "the tab back" });
      assert(!(await toolbar.evaluate(`window.__kesselTest.notices()`)).some((n) => n.id === "restore"), "the offer goes");
    },
  },
  {
    name: "a damaged settings file: Kessel uses its backup and keeps the damaged one aside",
    async run({ launch, assert }) {
      const dir = mkdtempSync(path.join(tmpdir(), "kessel-e2e-"));
      mkdirSync(path.join(dir, "Data"), { recursive: true });
      writeFileSync(path.join(dir, "Data", "settings.json"), `{"shields_https_upgrade": false, "default_zoom": 1.`);
      writeFileSync(path.join(dir, "Data", "settings.json.bak"), JSON.stringify({ shields_https_upgrade: false, default_zoom: 1.25 }));
      const k = await launch({ profileDir: dir });
      assert.equal((await k.invoke("get_settings")).default_zoom, 1.25, "the backup's settings");
      assert(existsSync(path.join(dir, "Data", "settings.json.corrupt")), "the damaged file kept aside");
      assert(readFileSync(path.join(dir, "Data", "settings.json.corrupt"), "utf8").endsWith("1."), "as it was");
      const reports = await k.invoke("crash_reports");
      assert(reports.some((r) => r.kind === "file" && r.what === "settings.json" && /backup/.test(r.reason)), "noted in the crash log");
      // Saving writes a whole new file, keeping the last one as the backup.
      await k.invoke("update_settings", { settings: { ...(await k.invoke("get_settings")), default_zoom: 1.5 } });
      assert.equal(JSON.parse(readFileSync(path.join(dir, "Data", "settings.json"), "utf8")).default_zoom, 1.5, "saved");
      assert.equal(JSON.parse(readFileSync(path.join(dir, "Data", "settings.json.bak"), "utf8")).default_zoom, 1.25, "the previous one is the backup");
    },
  },
  {
    name: "the engine itself goes: Kessel starts again with your tabs",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ keepProfile: true });
      let restarted = null;
      try {
        await open(k, `${site.origin}/page/Survivor`);
        await waitFor(() => (k.readProfileFile("Data/session.json") || "").includes("/page/Survivor"), { message: "the session saved" });
        const before = await k.invoke("system_info");
        const engine = (await k.invoke("task_manager")).processes.find((p) => p.kind === "browser");
        killPid(engine.pid);
        // A new Kessel on the same profile (and test port).
        restarted = await waitFor(async () => {
          const info = await k.invoke("system_info").catch(() => null);
          return info && info.pid !== before.pid && info;
        }, { timeout: 40000, message: "Kessel again" });
        await waitFor(async () => (await k.tabs()).some((t) => t.url.endsWith("/page/Survivor")), { message: "with the tab", timeout: 20000 });
        assert((await k.invoke("crash_reports")).some((r) => r.kind === "engine"), "noted in the crash log");
      } finally {
        if (restarted) killPid(restarted.pid);
        await sleep(500);
        await k.close({ keepProfile: false });
      }
    },
  },
];
