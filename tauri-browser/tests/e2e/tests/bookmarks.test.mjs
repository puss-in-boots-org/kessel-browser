// Bookmarks (bookmarks.rs, bookmarks.html/js, bookmark.html/js): the star
// and its popup, folders inside folders on the bar and in the manager,
// moving, sorting, editing, tags and notes, search, previews, HTML import
// and export, duplicates, link checks and backups.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const run = (k, id) => k.invoke("run_command", { id });

async function open(k, url) {
  const { id } = await k.activeTab();
  await k.invoke("navigate", { id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return { id, page };
}

const tree = (k) => k.invoke("bookmark_tree");
const folder = (k, title, parent = "") => k.invoke("save_bookmark_folder", { folder: { id: "", title, parent, added: 0 } });
const bookmark = (k, url, title, extra = {}) => k.invoke("save_bookmark", { bookmark: { id: "", url, title, folder: "", tags: [], description: "", added: 0, ...extra } });

// The manager, open and showing its folders.
async function manager(k) {
  await run(k, "bookmark-manager");
  const m = await k.page((t) => t.url.includes("bookmarks.html"));
  await m.waitFor(`document.readyState === "complete" && document.querySelectorAll('#tree .nav-item').length > 0`, { message: "the manager's folders" });
  return m;
}

// The titles of the manager's rows, in order.
const titles = `[...document.querySelectorAll('#list .row .title')].map((e) => e.textContent)`;

// Clicks an item of one of the manager's own menus, by its label.
const pickMenu = (m, label) =>
  m.evaluate(`(() => { const b = [...document.querySelectorAll('.menu button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('no menu item ' + ${JSON.stringify(label)}); b.click(); })()`);

const search = (m, q) => m.evaluate(`(() => { const q = document.getElementById('q'); q.value = ${JSON.stringify(q)}; q.dispatchEvent(new Event('input')); })()`);

export const tests = [
  {
    name: "the star bookmarks the page with a picture of it, and its popup files it in a new folder with tags and a note",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const url = `${site.origin}/article/Starred`;
      await open(k, url);
      await run(k, "bookmark");
      const pop = await k.page((t) => t.url.includes("bookmark.html"));
      await pop.waitFor(`document.getElementById('title').value.length > 0`, { message: "the popup, filled in" });
      assert.equal(await pop.evaluate(`document.getElementById('heading').textContent`), "Bookmarked", "a new bookmark");

      // "New folder…", named in the popup.
      await pop.evaluate(`(() => { const s = document.getElementById('folder'); s.value = s.options[s.options.length - 1].value; s.dispatchEvent(new Event('change')); })()`);
      await pop.evaluate(`(() => { const i = document.getElementById('new-folder'); i.value = 'Reading'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await pop.waitFor(`document.getElementById('folder').selectedOptions[0]?.textContent.trim() === 'Reading'`, { message: "the new folder, picked" });
      await pop.evaluate(`(() => { document.getElementById('title').value = 'Glass'; document.getElementById('tags').value = 'Science, #light, science'; document.getElementById('note').value = 'Read it later'; document.getElementById('done').click(); })()`);

      const saved = await waitFor(async () => (await tree(k)).bookmarks.find((b) => b.url === url && b.title === "Glass"), { message: "the popup's changes saved" });
      const reading = (await tree(k)).folders.find((f) => f.title === "Reading");
      assert(reading, "the folder was made");
      assert.equal(saved.folder, reading.id, "in the folder");
      assert.deepEqual(saved.tags, ["science", "light"], "tags: trimmed, no #, once each");
      assert.equal(saved.description, "Read it later", "the note");
      await waitFor(async () => (await k.invoke("bookmark_preview", { id: saved.id }))?.startsWith("data:image/jpeg"), { message: "a picture of the page", timeout: 15000 });

      // On the bar: the folder, not the bookmark (it's in the folder).
      const toolbar = await k.toolbar();
      await toolbar.waitFor(`[...document.querySelectorAll('#bookmarks-bar .bm-folder')].some((c) => c.textContent === 'Reading')`, { message: "the folder on the bar" });
      assert.equal(await toolbar.evaluate(`document.getElementById('star-btn').classList.contains('starred')`), true, "the star is filled");

      // The star again: the same popup, to edit -- or remove. (Not right
      // away: a popup opened again within 400 ms of closing is taken for
      // the click on its button that closed it -- see toggle_popup.)
      await sleep(500);
      await run(k, "bookmark");
      await waitFor(async () => {
        const again = await k.page((t) => t.url.includes("bookmark.html"), { timeout: 2000 });
        return again.evaluate(`document.getElementById('heading').textContent === 'Edit bookmark' && document.getElementById('note').value === 'Read it later' && (document.getElementById('remove').click(), true)`);
      }, { message: "the popup for the bookmark it has, and Remove" });
      await waitFor(async () => !(await tree(k)).bookmarks.some((b) => b.url === url), { message: "removed" });
      await toolbar.waitFor(`!document.getElementById('star-btn').classList.contains('starred')`, { message: "the star is empty again" });
    },
  },
  {
    name: "the bookmarks bar: a folder opens as a dropdown, a folder in it opens in its place",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const work = await folder(k, "Work");
      const docs = await folder(k, "Docs", work);
      await bookmark(k, `${site.origin}/article/Plan`, "The plan", { folder: work });
      await bookmark(k, `${site.origin}/article/Spec`, "The spec", { folder: docs });
      await bookmark(k, `${site.origin}/article/Loose`, "On the bar");

      const toolbar = await k.toolbar();
      await toolbar.waitFor(`document.querySelectorAll('#bookmarks-bar .bm-chip').length >= 2`, { message: "the bar" });
      const chips = await toolbar.evaluate(`[...document.querySelectorAll('#bookmarks-bar .bm-chip .bm-title')].map((c) => c.textContent)`);
      assert.deepEqual(chips, ["Work", "On the bar"], "folders first, then the bookmarks on the bar itself");

      // The menu (context.html) that shows `want`.
      const menuWith = (want) =>
        waitFor(
          async () => {
            for (const t of await k.targets()) {
              if (!t.url.includes("context.html")) continue;
              const menu = await k.attach(t);
              if (await menu.evaluate(`document.body.innerText.includes(${JSON.stringify(want)})`)) return menu;
            }
            return null;
          },
          { message: `the menu with ${want}` }
        );
      await toolbar.evaluate(`document.querySelector('#bookmarks-bar .bm-folder').click()`);
      const menu = await menuWith("The plan");
      assert(/Docs/.test(await menu.evaluate(`document.body.innerText`)), "the folder inside it");
      await menu.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.includes('Docs')).click()`);
      const inner = await menuWith("The spec");
      assert(/Back/.test(await inner.evaluate(`document.body.innerText`)), "and a way back up");
    },
  },
  {
    name: "the manager: folders in folders, moving by dragging, sorting, editing, #tag search, deleting several",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const work = await folder(k, "Work");
      await folder(k, "Docs", work);
      const zed = await bookmark(k, `${site.origin}/article/Zed`, "Zed", { tags: ["later"] });
      await bookmark(k, `${site.origin}/article/Alpha`, "Alpha");
      await bookmark(k, `${site.origin}/article/Mid`, "Mid", { tags: ["later"] });

      const m = await manager(k);
      await m.waitFor(`document.querySelectorAll('#list .row').length === 4`, { message: "a folder and three bookmarks" });
      assert.deepEqual(await m.evaluate(titles), ["Work", "Zed", "Alpha", "Mid"], "the folder first, then the bookmarks as saved");

      // Sort by name.
      await m.evaluate(`document.getElementById('sort-btn').click()`);
      await pickMenu(m, "By name");
      await m.waitFor(`${titles}.join() === 'Work,Alpha,Mid,Zed'`, { message: "sorted by name" });

      // Drag Zed onto the Work folder in the tree.
      await m.evaluate(`(() => {
        const row = document.querySelector('#list .row[data-key="b:${zed}"]');
        const target = document.querySelector('#tree .nav-item[data-folder="${work}"]');
        const dt = new DataTransfer();
        row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
        target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
        target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        row.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      })()`);
      await waitFor(async () => (await tree(k)).bookmarks.find((b) => b.id === zed)?.folder === work, { message: "moved into Work" });

      // Into the folder: its folder, then what was moved there; the tree
      // shows the folder inside once it's opened.
      await m.evaluate(`document.querySelector('#tree .nav-item[data-folder="${work}"]').click()`);
      await m.waitFor(`${titles}.join() === 'Docs,Zed'`, { message: "Work's contents" });
      assert(/Work/.test(await m.evaluate(`document.getElementById('crumbs').innerText`)), "the breadcrumbs");
      await m.evaluate(`document.querySelector('#tree .nav-item[data-folder="${work}"] .twist').click()`);
      await m.waitFor(`[...document.querySelectorAll('#tree .nav-item .label')].some((e) => e.textContent === 'Docs')`, { message: "Docs in the tree" });

      // Edit Zed: name, tags, note, folder.
      await m.evaluate(`document.querySelector('#list .row[data-key="b:${zed}"] [data-act=edit]').click()`);
      await m.waitFor(`!!document.querySelector('.modal [name=title]')`);
      await m.evaluate(`(() => {
        const set = (n, v) => { document.querySelector('.modal [name=' + n + ']').value = v; };
        set('title', 'Zed, edited'); set('tags', 'later, work'); set('description', 'The big one'); set('folder', '');
        document.querySelector('.modal [data-act=ok]').click();
      })()`);
      const edited = await waitFor(async () => (await tree(k)).bookmarks.find((b) => b.id === zed && b.title === "Zed, edited"), { message: "edited" });
      assert.equal(edited.folder, "", "back on the bar");
      assert.deepEqual(edited.tags, ["later", "work"], "the tags");
      assert.equal(edited.description, "The big one", "the note");

      // #tag search, across folders; words find notes too.
      await search(m, "#later");
      await m.waitFor(`${titles}.sort().join() === 'Mid,Zed, edited'`, { message: "the two tagged 'later'" });
      await search(m, "big one");
      await m.waitFor(`${titles}.join() === 'Zed, edited'`, { message: "found by its note" });

      // Select two (Ctrl+click) and delete them.
      await search(m, "#later");
      await m.waitFor(`document.querySelectorAll('#list .row').length === 2`);
      await m.evaluate(`document.querySelectorAll('#list .row').forEach((r) => r.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true })))`);
      await m.waitFor(`!document.getElementById('selection').hidden && document.getElementById('selection-text').textContent === '2 selected'`, { message: "two selected" });
      await m.evaluate(`document.getElementById('delete-selected').click()`);
      await m.waitFor(`!!document.getElementById('confirm-dialog-ok')`);
      await m.evaluate(`document.getElementById('confirm-dialog-ok').click()`);
      await waitFor(async () => (await tree(k)).bookmarks.map((b) => b.title).join() === "Alpha", { message: "only Alpha left" });

      // Deleting a folder takes what's in it.
      await bookmark(k, `${site.origin}/article/Inside`, "Inside", { folder: work });
      await k.invoke("delete_bookmark_folder", { id: work });
      const after = await tree(k);
      assert.deepEqual([after.folders.length, after.bookmarks.map((b) => b.title).join()], [0, "Alpha"], "Work, Docs and Inside are gone");
    },
  },
  {
    name: "HTML export and import, duplicates, links that stopped working, and backups",
    async run({ launch, site, assert, waitFor }) {
      const dir = mkdtempSync(path.join(tmpdir(), "kessel-bookmarks-"));
      try {
        // A profile with a bookmarks file from before folders: no ids.
        const profileDir = mkdtempSync(path.join(tmpdir(), "kessel-e2e-"));
        mkdirSync(path.join(profileDir, "Data"));
        writeFileSync(path.join(profileDir, "Data", "settings.json"), JSON.stringify({ shields_https_upgrade: false }));
        writeFileSync(path.join(profileDir, "Data", "bookmarks.json"), JSON.stringify([{ url: `${site.origin}/article/Old`, title: "From before" }]));
        const k = await launch({ profileDir });
        const [old] = (await tree(k)).bookmarks;
        assert(old?.title === "From before" && /^[0-9a-f]{16}$/.test(old.id) && old.folder === "", "an old bookmark gets an id, on the bar");
        const news = await folder(k, "News & views");
        const a = await bookmark(k, `${site.origin}/article/A`, "A <one>", { folder: news, tags: ["x"], description: "About A" });
        await bookmark(k, `${site.origin}/missing`, "Gone");
        const dup = await bookmark(k, `${site.origin}/article/A/?utm_source=mail#top`, "A again");

        // Export: the file every browser reads.
        const file = path.join(dir, "export.html");
        assert.equal(await k.invoke("export_bookmarks", { path: file }), file, "saved where asked");
        const html = readFileSync(file, "utf8");
        assert(html.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>"), "the Netscape format");
        assert(html.includes(">News &amp; views</H3>"), "the folder, escaped");
        assert(html.includes(`HREF="${site.origin}/article/A"`) && html.includes(`TAGS="x">A &lt;one&gt;</A>`) && html.includes("<DD>About A"), "a bookmark with its tags and note, escaped");

        // Another browser's file: into a folder of its own ("Bookmarks bar"
        // is that folder itself), skipping what's already here.
        const other = path.join(dir, "chrome.html");
        writeFileSync(
          other,
          `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="${site.origin}/article/A" ADD_DATE="1700000000">A &lt;one&gt;</A>
        <DT><H3>Recipes</H3>
        <DL><p>
            <DT><A HREF="https://example.com/soup" ADD_DATE="1700000001">Soup &amp; bread</A>
        </DL><p>
    </DL><p>
</DL><p>
`
        );
        const imported = await k.invoke("import_bookmarks", { path: other });
        assert.deepEqual([imported.added, imported.skipped], [1, 1], "one new, one already here");
        const t = await tree(k);
        const top = t.folders.find((f) => f.id === imported.folder);
        assert(/^Imported \d{4}-\d\d-\d\d$/.test(top?.title), `a folder of its own (${top?.title})`);
        const soup = t.bookmarks.find((b) => b.url === "https://example.com/soup");
        assert.equal(soup?.title, "Soup & bread", "unescaped");
        const recipes = t.folders.find((f) => f.id === soup.folder);
        assert.equal(recipes?.title, "Recipes", "in its folder");
        assert.equal(recipes.parent, imported.folder, "right inside the import's folder");
        await k.invoke("delete_bookmark_folder", { id: imported.folder });

        // Duplicates: the same page, whatever the address says.
        assert.deepEqual(await k.invoke("find_duplicate_bookmarks"), [[a, dup]], "A and A-with-tracking are one page");
        const m = await manager(k);
        await m.evaluate(`document.querySelector('[data-view=duplicates]').click()`);
        await m.waitFor(`document.querySelectorAll('#list .group .row').length === 2`, { message: "the duplicates shown" });
        await m.evaluate(`document.querySelector('#list .group > .btn').click()`);
        await waitFor(async () => !(await tree(k)).bookmarks.some((b) => b.id === dup), { message: "the second one deleted" });
        await m.waitFor(`/No page is bookmarked twice/.test(document.getElementById('list').innerText)`, { message: "no duplicates left" });

        // Links: the missing page is gone, the article is fine.
        const now = await tree(k);
        const checks = await k.invoke("check_bookmark_links", { ids: null });
        const stateOf = (url) => checks.find((c) => c.id === now.bookmarks.find((b) => b.url === url)?.id);
        assert.deepEqual([stateOf(`${site.origin}/missing`)?.state, stateOf(`${site.origin}/missing`)?.status], ["gone", 404], "the 404");
        assert.equal(stateOf(`${site.origin}/article/A`)?.state, "ok", "the article");
        await m.evaluate(`document.querySelector('[data-view=links]').click()`);
        await m.waitFor(`!!document.getElementById('check-links')`);
        await m.evaluate(`document.getElementById('check-links').click()`);
        await m.waitFor(`[...document.querySelectorAll('#list .row')].some((r) => r.innerText.includes('Gone (404)'))`, { message: "the broken link listed", timeout: 20000 });
        assert.equal(await m.evaluate(`document.querySelectorAll('#list .row').length`), 1, "and only that one");

        // Backups: today's (made before today's first change that had
        // something to keep), and putting one back.
        const backups = await k.invoke("bookmark_backups");
        const today = backups.find((b) => /^bookmarks-\d{4}-\d\d-\d\d\.json$/.test(b.name));
        assert(today && today.bookmarks === 1 && today.folders === 0, `today's backup: as it was before the first change (${backups.map((b) => `${b.name}: ${b.bookmarks}`)})`);
        await k.invoke("delete_bookmarks", { ids: (await tree(k)).bookmarks.map((b) => b.id) });
        assert.equal((await tree(k)).bookmarks.length, 0, "all deleted");
        assert.equal(await k.invoke("restore_bookmark_backup", { name: today.name }), today.bookmarks, "the backup's bookmarks are back");
        assert.equal((await tree(k)).bookmarks.length, today.bookmarks, "in the tree");
        assert((await k.invoke("bookmark_backups")).some((b) => b.name.includes("before-restore")), "what was there before the restore is kept too");
        let refused = null;
        await k.invoke("restore_bookmark_backup", { name: "../settings.json" }).catch((e) => (refused = String(e)));
        assert(refused, "only its own backups");

        await m.evaluate(`document.querySelector('[data-view=backups]').click()`);
        await m.waitFor(`[...document.querySelectorAll('#list .row button')].some((b) => b.textContent === 'Restore')`, { message: "the backups listed" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];
