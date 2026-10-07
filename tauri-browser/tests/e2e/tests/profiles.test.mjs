// Profiles (profiles.rs, Settings -> Profiles): listed, made, opened -- a
// new window for this one, a Kessel of its own for another -- one already
// open elsewhere isn't opened twice, and a desktop shortcut opens straight
// into one.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const tests = [
  {
    name: "profiles: made, listed, opened; one open in another Kessel isn't opened twice; a desktop shortcut for one",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const labels = async (kessel) => (await kessel.invoke("list_profiles")).map((p) => `${p.label}${p.current ? " (this)" : ""}${p.running ? " (open)" : ""}`);
      assert.deepEqual(await labels(k), ["Default (this)"], "the default profile");

      // This one: a new window.
      assert((await k.invoke("open_profile", { name: null })).window, "a window");
      await waitFor(async () => (await k.windows()).length === 2, { message: "a second window" });

      // A new one: made, and opened in a Kessel of its own.
      const made = await k.invoke("create_profile", { name: "Work" });
      const workDir = path.join(k.profileDir, "profiles", "Work");
      assert.deepEqual(made.args, ["--profile-dir", workDir], "kessel.exe --profile-dir <it>");
      assert.deepEqual(await labels(k), ["Default (this)", "Work"], "listed");
      const rejected = await k.invoke("create_profile", { name: "work" }).then(() => null, (e) => String(e));
      assert(/already/.test(rejected), `the same name twice: ${rejected}`);

      // Work opened for real, in a Kessel of its own.
      const work = await launch({ profileDir: workDir });
      try {
        assert.deepEqual(await labels(work), ["Default (open)", "Work (this)"], "from there, Work is this one -- and Default is open in the first Kessel");
        const badge = await (await work.toolbar()).evaluate(`(() => { const b = document.getElementById('profile-badge'); return b.hidden ? null : b.textContent; })()`);
        assert.equal(badge, "Work", "its windows say which profile");
        assert.equal(await (await k.toolbar()).evaluate(`document.getElementById('profile-badge').hidden`), true, "the default one's don't");
        // Settings of its own: search engine, downloads folder...
        const mine = await k.invoke("get_settings");
        await k.invoke("update_settings", { settings: { ...mine, search_engine: "bing", features: { ...mine.features, download_dir: "C:\\Kessel-test-downloads" } } });
        const theirs = await work.invoke("get_settings");
        assert(theirs.search_engine !== "bing" && !theirs.features?.download_dir, "Work keeps its own search engine and downloads folder");
        await waitFor(async () => (await labels(k)).includes("Work (open)"), { message: "seen as open elsewhere" });
        const twice = await k.invoke("open_profile", { name: "Work" }).then(() => null, (e) => String(e));
        assert(/open already/.test(twice), `not opened twice: ${twice}`);
      } finally {
        await work.close({ keepProfile: true });
      }
      await waitFor(async () => (await labels(k)).includes("Work"), { message: "closed again" });
      assert.deepEqual((await k.invoke("open_profile", { name: "Work" })).args, ["--profile-dir", workDir], "and it opens again");

      // A desktop shortcut (here, in a folder of the test's).
      const folder = mkdtempSync(path.join(tmpdir(), "kessel-shortcut-"));
      try {
        const where = await k.invoke("profile_shortcut", { name: "Work", dir: folder });
        assert.equal(path.basename(where), "Kessel – Work.lnk", "named after it");
        assert(existsSync(where), "made");
        const lnk = readFileSync(where);
        assert(lnk.includes(Buffer.from(`--profile-dir ${workDir}`, "utf16le")), "opening kessel.exe with that profile");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }

      // Ctrl+Shift+M: Settings -> Profiles.
      assert(await k.press("Ctrl+Shift+M"), "Kessel's key");
      const settings = await k.page((t) => t.url.includes("settings.html"));
      await settings.waitFor(`document.querySelectorAll('#profile-list [data-profile]').length === 2`, { message: "the profiles in Settings" });
      assert.equal(await settings.evaluate(`document.querySelector('[data-profile="Default"] .lr-sub').textContent`), "This one", "this one marked");
    },
  },
];
