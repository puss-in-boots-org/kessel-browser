// The download manager (downloads.rs, downloads.html): live progress,
// pausing and resuming, cancelling, your own download folder and the file's
// own name, searching and sorting the list.

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BIG_SIZE } from "../lib/server.mjs";

export const tests = [
  {
    name: "a download shows its progress, pauses and resumes, into your own folder under its own name",
    async run({ launch, site, assert, waitFor, sleep }) {
      const folder = mkdtempSync(path.join(tmpdir(), "kessel-downloads-"));
      try {
        const k = await launch({ settings: { features: { download_dir: folder } } });
        const [tab] = await k.tabs();
        await k.createTab("kessel://downloads");
        const list = await k.page((t) => t.url.includes("downloads.html"));
        const text = () => list.evaluate(`document.getElementById('list').innerText`);
        const ours = async () => (await k.invoke("get_downloads")).filter((d) => d.url.endsWith("/big/report.bin"));

        await k.invoke("navigate", { id: tab.id, url: `${site.origin}/big/report.bin` });
        const d = await waitFor(async () => (await ours())[0], { message: "the download started" });
        await list.waitFor(`/of 3(\\.0)? MB/.test(document.getElementById('list').innerText)`, { message: "'… of 3 MB' in the list" });

        await k.invoke("download_control", { id: d.id, action: "pause" });
        await list.waitFor(`/Paused/.test(document.getElementById('list').innerText)`, { message: "paused" });
        const paused = await text();
        await sleep(1500);
        assert.equal(await text(), paused, "nothing more comes while it's paused (and it isn't written off as failed)");

        await k.invoke("download_control", { id: d.id, action: "resume" });
        const done = await waitFor(async () => (await ours()).find((x) => x.id === d.id && x.finished), { message: "finished", timeout: 30000 });
        assert(done.success, "successfully");
        assert.equal(path.dirname(done.path), folder, "in your own download folder");
        assert.equal(path.basename(done.path), "report.bin", "under the name the site gave it");
        assert.equal(statSync(done.path).size, BIG_SIZE, "all of it");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  },
  {
    name: "a cancelled download says so and offers to try again; the list searches and sorts",
    async run({ launch, site, assert, waitFor, sleep }) {
      const folder = mkdtempSync(path.join(tmpdir(), "kessel-downloads-"));
      try {
        const k = await launch({ settings: { features: { download_dir: folder } } });
        const [tab] = await k.tabs();
        await k.createTab("kessel://downloads");
        const list = await k.page((t) => t.url.includes("downloads.html"));
        await k.invoke("navigate", { id: tab.id, url: `${site.origin}/big/cancelled.bin` });
        const d = await waitFor(async () => (await k.invoke("get_downloads")).find((x) => x.url.endsWith("/big/cancelled.bin")), { message: "the download started" });
        await sleep(600);
        await k.invoke("download_control", { id: d.id, action: "cancel" });
        await list.waitFor(`/Cancelled/.test(document.getElementById('list').innerText)`, { message: "Cancelled" });
        await list.waitFor(`[...document.querySelectorAll('#list button')].some((b) => /Try again/.test(b.title || b.textContent))`, { message: "Try again" });
        assert.equal(readdirSync(folder).filter((f) => f.startsWith("cancelled")).length, 0, "no file left behind");

        await list.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'nothing-like-it'; q.dispatchEvent(new Event('input')); })()`);
        await list.waitFor(`!/cancelled\\.bin/.test(document.getElementById('list').innerText)`, { message: "searched away" });
        await list.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'cancelled'; q.dispatchEvent(new Event('input')); const s = document.getElementById('sort'); s.value = 'name'; s.dispatchEvent(new Event('change')); })()`);
        await list.waitFor(`/cancelled\\.bin/.test(document.getElementById('list').innerText)`, { message: "found again, sorted by name" });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  },
];
