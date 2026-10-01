// Importing from other browsers (import.rs) -- made-up Edge and Firefox
// profiles (lib/fake-browsers.mjs), so the PC's real browsers are never
// read -- and exporting history and the open tabs.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBrowsers } from "../lib/fake-browsers.mjs";

const MASTER = "correct-horse-battery-9";

async function withBrowsers(site, run) {
  const browsers = makeBrowsers(site);
  try {
    return await run(browsers);
  } finally {
    rmSync(browsers.home, { recursive: true, force: true });
  }
}

const source = async (k, browser) => (await k.invoke("detect_browsers")).find((s) => s.browser === browser);
const all = (overrides) => ({ bookmarks: true, speed_dial: true, cookies: true, passwords: true, history: true, tabs: true, ...overrides });

// The folder named `title` inside folder `parent` ("" = the bar).
const folderIn = (tree, parent, title) => tree.folders.find((f) => f.parent === parent && f.title === title);
const titlesIn = (tree, folder) => tree.bookmarks.filter((b) => b.folder === folder).map((b) => b.title);

export const tests = [
  {
    name: "Edge and Firefox profiles are found, with what each one has",
    async run({ launch, site, assert }) {
      await withBrowsers(site, async ({ env }) => {
        const k = await launch({ env });
        const found = await k.invoke("detect_browsers");
        assert.deepEqual(found.map((s) => s.browser).sort(), ["Edge", "Firefox"], "only the made-up ones (the real browsers aren't looked at)");
        const edge = found.find((s) => s.browser === "Edge");
        assert.deepEqual([edge.engine, edge.bookmarks, edge.tabs, edge.blocked], ["chromium", 3, 2, null], "Edge");
        assert.deepEqual(edge.extensions, [{ id: "aapocclcgogkmnckokdopfmhonfmgoek", name: "Slides Helper", store: "chrome" }], "its store extension, by its own name (not a built-in one)");
        const fox = found.find((s) => s.browser === "Firefox");
        assert.deepEqual([fox.engine, fox.bookmarks, fox.speed_dial, fox.passwords, fox.tabs, fox.app_bound], ["firefox", 3, 1, 2, 2, false], "Firefox");
      });
    },
  },
  {
    name: "Firefox: bookmarks with folders and tags, pinned sites, history, cookies, passwords and open tabs -- and again changes nothing",
    async run({ launch, site, assert }) {
      await withBrowsers(site, async ({ env }) => {
        const k = await launch({ env });
        await k.invoke("vault_setup", { masterPassword: MASTER });
        const fox = await source(k, "Firefox");
        const r = await k.invoke("import_from_browser", { choice: { source: fox.id, ...all() } });
        assert.deepEqual(
          [r.bookmarks_added, r.speed_dial_added, r.cookies_imported, r.cookies_skipped, r.passwords_added, r.history_added, r.tab_groups, r.tabs_imported],
          [3, 1, 2, 2, 2, 1, 2, 2],
          `what came over (${JSON.stringify(r)})`
        );
        assert.deepEqual([r.cookie_error, r.password_error, r.history_error, r.tabs_error], [null, null, null, null], "no errors");

        // Bookmarks: "From Firefox", the toolbar's straight in, the rest in
        // their folders, tags kept.
        const tree = await k.invoke("bookmark_tree");
        const top = folderIn(tree, "", "From Firefox");
        assert(top, "a folder of their own");
        assert.deepEqual(titlesIn(tree, top.id), ["Fox bar"], "the toolbar's");
        assert.deepEqual(titlesIn(tree, folderIn(tree, top.id, "Reading")?.id), ["Fox read"], "a folder on the toolbar");
        assert.deepEqual(titlesIn(tree, folderIn(tree, top.id, "Bookmarks menu")?.id), ["Fox menu"], "the Bookmarks menu");
        assert.deepEqual(tree.bookmarks.find((b) => b.title === "Fox read").tags, ["later"], "Firefox's tag");

        const pinned = await k.invoke("get_pinned");
        assert(pinned.some((p) => p.url === `${site.origin}/page/FoxPinned` && p.title === "Fox pinned"), "the pinned New Tab site");

        const visits = await k.invoke("query_history", { text: "FoxVisited", limit: 10 });
        assert.equal(visits.length, 1, "the visit (not the reload)");

        const items = await k.invoke("vault_list_items");
        assert.deepEqual(
          items.map((i) => [i.site, i.username, i.password]).sort(),
          [["mail.example.com", "fox@example.com", "Fox-Pass-1!"], ["shop.example.com", "shopper", "Shop-Pass-ü2"]],
          "the passwords, decrypted with Firefox's key"
        );

        const groups = await k.invoke("get_saved_groups");
        assert.deepEqual(
          groups.map((g) => [g.name, g.tabs.map((t) => t.url.split("/").pop())]),
          [["Firefox window 1", ["FoxTab1"]], ["Firefox window 2", ["FoxTab2"]]],
          "a saved group per window, each tab on the page it was on"
        );
        const toolbar = await k.toolbar();
        await toolbar.waitFor(`[...document.querySelectorAll('#bookmarks-bar .saved-group')].length === 2`, { message: "the groups on the bookmarks bar" });

        // The cookies: the page sees them.
        const { id } = await k.activeTab();
        const url = `${site.origin}/page/Cookies`;
        await k.invoke("navigate", { id, url });
        const page = await k.page((t) => t.url === url);
        await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
        const jar = await page.evaluate(`document.cookie`);
        assert(jar.includes("fox_session=signed-in") && jar.includes("fox_ms=milliseconds"), `the cookies (${jar})`);
        assert(!jar.includes("fox_container") && !jar.includes("fox_expired"), "not a container's or an expired one");

        // Again: nothing doubled.
        const again = await k.invoke("import_from_browser", { choice: { source: fox.id, ...all({ cookies: false }) } });
        assert.deepEqual(
          [again.bookmarks_added, again.bookmarks_existing, again.speed_dial_added, again.passwords_added, again.passwords_existing, again.history_added, again.history_existing],
          [0, 3, 0, 0, 2, 0, 1],
          "everything already here"
        );
        assert.equal((await k.invoke("get_saved_groups")).length, 2, "the groups replaced, not added again");
        assert.equal((await k.invoke("bookmark_tree")).folders.filter((f) => f.title === "From Firefox").length, 1, "no second folder");
      });
    },
  },
  {
    name: "Edge: folders kept, history without frames or what's too old, open tabs in order, extensions offered in Settings",
    async run({ launch, site, assert }) {
      await withBrowsers(site, async ({ env }) => {
        const k = await launch({ env });
        const edge = await source(k, "Edge");
        const r = await k.invoke("import_from_browser", { choice: { source: edge.id, ...all({ cookies: false, passwords: false, speed_dial: false }) } });
        assert.deepEqual([r.bookmarks_added, r.history_added, r.tab_groups, r.tabs_imported], [3, 1, 1, 2], `what came over (${JSON.stringify(r)})`);

        const tree = await k.invoke("bookmark_tree");
        const top = folderIn(tree, "", "From Edge");
        assert.deepEqual(titlesIn(tree, top.id), ["Edge top"], "the bar's, straight in");
        const work = folderIn(tree, top.id, "Work");
        assert.deepEqual(titlesIn(tree, folderIn(tree, work?.id, "Docs")?.id), ["Edge spec"], "a folder in a folder");
        assert.deepEqual(titlesIn(tree, folderIn(tree, top.id, "Other favorites")?.id), ["Edge other"], "the other bookmarks, under their own name");

        assert.equal((await k.invoke("query_history", { text: "EdgeVisited", limit: 10 })).length, 1, "the visit from yesterday, not the one from a year ago");
        assert.equal((await k.invoke("query_history", { text: "EdgeFrame", limit: 10 })).length, 0, "no frame's");

        const groups = await k.invoke("get_saved_groups");
        assert.deepEqual(groups.map((g) => [g.name, g.tabs.map((t) => t.title)]), [["Edge tabs", ["Edge tab 1", "Edge tab 2"]]], "the window's tabs, in order");

        // Settings -> Import: the card, with the extension to add.
        await k.invoke("open_singleton_tab", { route: "kessel://settings/import" });
        const settings = await k.page((t) => t.url.includes("settings.html"));
        await settings.waitFor(`/Import from Edge/.test(document.body.innerText) && /Slides Helper/.test(document.body.innerText)`, { message: "Edge's card and its extension", timeout: 15000 });
        const text = await settings.evaluate(`document.getElementById('panel-import').innerText`);
        assert(/Open tabs/.test(text) && /History/.test(text) && /2 tabs, as saved tab groups/.test(text), "the new rows");
        assert(/Pinned New Tab sites/.test(text), "Firefox's own words for its pins");
      });
    },
  },
  {
    name: "settings saved to a file come back from it; a file that isn't one is refused",
    async run({ launch, assert }) {
      const dir = mkdtempSync(path.join(tmpdir(), "kessel-settings-"));
      try {
        const k = await launch();
        const set = async (patch) => k.invoke("update_settings", { settings: { ...(await k.invoke("get_settings")), ...patch } });
        await set({ homepage: "https://before.example/", history_days: 30 });
        const file = path.join(dir, "settings.json");
        assert.equal(await k.invoke("export_settings", { path: file }), file, "saved where asked");
        assert.equal(JSON.parse(readFileSync(file, "utf8")).kessel_settings, 1, "marked as Kessel's");

        await set({ homepage: "https://after.example/", history_days: 7 });
        assert.equal(await k.invoke("import_settings", { path: file }), true, "restored");
        const back = await k.invoke("get_settings");
        assert.deepEqual([back.homepage, back.history_days], ["https://before.example/", 30], "as they were saved");

        const other = path.join(dir, "other.json");
        writeFileSync(other, JSON.stringify({ hello: [1, 2, 3] }));
        let refused = null;
        await k.invoke("import_settings", { path: other }).catch((e) => (refused = String(e)));
        assert(refused && /isn't a Kessel settings file/.test(refused), `refused (${refused})`);
        assert.equal((await k.invoke("get_settings")).homepage, "https://before.example/", "nothing changed by it");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "exports: history as a CSV file, the open tabs as a bookmarks file that imports again",
    async run({ launch, site, assert, waitFor }) {
      const dir = mkdtempSync(path.join(tmpdir(), "kessel-exports-"));
      try {
        const k = await launch();
        const { id } = await k.activeTab();
        // (Pages whose titles aren't just the end of their address: history
        // takes a "title" like that for a page without one.)
        const signIn = `${site.origin}/login`;
        await k.invoke("navigate", { id, url: signIn });
        const page = await k.page((t) => t.url === signIn);
        await page.waitFor(`location.href === ${JSON.stringify(signIn)} && document.readyState === "complete"`);
        await k.createTab(`${site.origin}/change-password`);

        const csvFile = path.join(dir, "history.csv");
        // (A visit is recorded as the page starts loading; its title once it has one.)
        await waitFor(async () => (await k.invoke("query_history", { text: "/login", limit: 5 }))[0]?.title === "Sign in", { message: "the visit recorded, with its title" });
        assert.equal(await k.invoke("export_history", { path: csvFile }), csvFile, "saved where asked");
        const csv = readFileSync(csvFile, "utf8").trim().split("\n");
        assert.equal(csv[0], "visited_at,title,url", "the header");
        assert(csv.some((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ,Sign in,/.test(l) && l.endsWith(signIn)), `a visit, with its time (${csv.slice(0, 4).join(" | ")})`);

        const htmlFile = path.join(dir, "tabs.html");
        await waitFor(
          async () => {
            await k.invoke("export_session", { path: htmlFile }).catch(() => null);
            try {
              return readFileSync(htmlFile, "utf8").includes("/change-password");
            } catch {
              return false;
            }
          },
          { message: "both tabs in the file" }
        );
        const html = readFileSync(htmlFile, "utf8");
        assert(html.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>") && /<H3[^>]*>Window 1 \(\d{4}-\d\d-\d\d\)<\/H3>/.test(html), "a bookmarks file with a folder for the window");
        assert(html.includes(`HREF="${signIn}"`) && html.includes(">Sign in</A>"), "the first tab's page, with its title");

        // It imports again (here, or in any browser).
        const imported = await k.invoke("import_bookmarks", { path: htmlFile });
        const tree = await k.invoke("bookmark_tree");
        const windowFolder = tree.folders.find((f) => f.parent === imported.folder && /^Window 1/.test(f.title));
        assert.deepEqual(tree.bookmarks.filter((b) => b.folder === windowFolder?.id).map((b) => b.url.split("/").pop()).sort(), ["change-password", "login"], "the window's tabs");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];
