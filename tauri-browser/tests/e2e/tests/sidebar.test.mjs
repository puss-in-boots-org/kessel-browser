// The side panel's own pages (sidebar.html: bookmarks, reading list,
// history, notes, search, workspaces, extensions), the AI assistant, and
// workspaces (main.js: each window shows one workspace's tabs; the others'
// sleep).

const sidebarPage = (k) => k.page((t) => t.url.includes("sidebar.html"), { timeout: 15000 });
const hasSidebar = async (k) => (await k.targets()).some((t) => t.url.includes("sidebar.html"));
const railClick = (toolbar, panel) => toolbar.evaluate(`document.querySelector('#rail-panels [data-panel="${panel}"]').click()`);
const tell = (k, message) => k.invoke("tell_toolbar", { message });

export const tests = [
  {
    name: "the rail opens the side panel's pages, and another button turns the page in place",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const toolbar = await k.toolbar();
      const buttons = await toolbar.evaluate(`[...document.querySelectorAll("#rail-panels .rail-btn")].map((b) => b.dataset.panel)`);
      assert.deepEqual(buttons, ["bookmarks", "reading", "history", "notes", "ai"], "the rail has the side panel's buttons");

      await k.invoke("add_to_reading_list", { url: `${site.origin}/page/Later`, title: "Later" });
      await railClick(toolbar, "reading");
      const page = await sidebarPage(k);
      await page.waitFor(`document.title === "Reading list" && [...document.querySelectorAll(".sb-title")].some((t) => t.textContent === "Later")`, { message: "the reading list shows what's on it" });
      await waitFor(() => toolbar.evaluate(`document.querySelector('#rail-panels [data-panel="reading"]').classList.contains("panel-open")`), { message: "its button is marked" });

      await k.invoke("add_bookmark", { url: `${site.origin}/page/Kept`, title: "Kept" });
      await railClick(toolbar, "bookmarks");
      await page.waitFor(`document.title === "Bookmarks" && [...document.querySelectorAll(".sb-title")].some((t) => t.textContent === "Kept")`, { message: "the same page turned to Bookmarks" });
      assert.equal((await k.targets()).filter((t) => t.url.includes("sidebar.html")).length, 1, "without a second side panel page");
      await waitFor(() => toolbar.evaluate(`document.querySelector('#rail-panels [data-panel="bookmarks"]').classList.contains("panel-open")`), { message: "the Bookmarks button is marked now" });

      // A bookmark clicked in it opens in the tab you're on.
      await page.evaluate(`[...document.querySelectorAll(".sb-item")].find((i) => i.textContent.includes("Kept")).click()`);
      await waitFor(async () => (await k.activeTab()).title === "Kept", { message: "the bookmark opened in the tab" });

      await railClick(toolbar, "bookmarks");
      await waitFor(async () => !(await hasSidebar(k)), { message: "a second click closes the side panel" });
    },
  },
  {
    name: "the reading list and notes keep what you save, across a restart",
    async run({ launch, site, assert }) {
      let k = await launch({ keepProfile: true });
      const profileDir = k.profileDir;
      await k.invoke("add_to_reading_list", { url: `${site.origin}/page/One`, title: "One" });
      await k.invoke("add_to_reading_list", { url: `${site.origin}/page/Two`, title: "Two" });
      await k.invoke("set_reading_read", { url: `${site.origin}/page/One`, read: true });
      const note = await k.invoke("save_note", { note: { id: "", text: "First line\nmore", url: "", title: "", pinned: false } });
      assert(note.id, "a new note gets an id");
      await k.invoke("save_note", { note: { ...note, text: "Changed" } });
      let refused = false;
      await k.invoke("add_to_reading_list", { url: "kessel://settings", title: "No" }).catch(() => (refused = true));
      assert(refused, "only web pages go on the reading list");
      await k.close({ keepProfile: true });

      k = await launch({ profileDir });
      const list = await k.invoke("get_reading_list");
      assert.deepEqual(list.map((i) => [i.title, i.read]), [["Two", false], ["One", true]], "newest first, read kept");
      assert.deepEqual((await k.invoke("get_notes")).map((n) => n.text), ["Changed"], "the note, as changed");
      await k.invoke("delete_note", { id: note.id });
      await k.invoke("remove_from_reading_list", { url: `${site.origin}/page/Two` });
      assert.equal((await k.invoke("get_notes")).length, 0, "deleted");
      assert.equal((await k.invoke("get_reading_list")).length, 1, "removed");
    },
  },
  {
    name: "workspaces keep their own tabs, asleep while you're away, and come back after a restart",
    async run({ launch, site, assert, waitFor }) {
      let k = await launch({ settings: { restore_tabs: true }, keepProfile: true });
      const profileDir = k.profileDir;
      const toolbar = await k.toolbar();
      const [first] = await k.tabs();
      await k.invoke("navigate", { id: first.id, url: `${site.origin}/page/A` });
      await k.createTab(`${site.origin}/page/B`);
      await waitFor(async () => (await k.tabs()).map((t) => t.title).join() === "A,B", { message: "A and B in the first workspace" });

      await tell(k, { type: "workspace-new", name: "Work", icon: "💼", color: "#4a8cff" });
      await waitFor(async () => (await k.tabs()).length === 1 && (await k.tabs())[0].url.startsWith("kessel://"), { message: "a new workspace starts with a new tab" });
      assert.equal(await toolbar.evaluate(`document.querySelectorAll("#rail-workspaces .ws-btn").length`), 2, "the rail shows both workspaces");
      const work = (await k.invoke("get_settings")).workspaces.find((w) => w.name === "Work");
      assert(work, "the workspace is kept in settings");
      const [workTab] = await k.tabs();
      await k.invoke("navigate", { id: workTab.id, url: `${site.origin}/page/C` });
      await waitFor(async () => (await k.tabs())[0].title === "C", { message: "C in Work" });
      assert.equal(await toolbar.evaluate(`document.documentElement.style.getPropertyValue("--accent").trim()`), "#4a8cff", "the workspace's colour tints the window");

      await tell(k, { type: "workspace-switch", id: "" });
      await waitFor(async () => (await k.tabs()).map((t) => t.title).join() === "A,B", { message: "back to A and B" });
      await waitFor(async () => !(await k.invoke("all_tabs")).some((t) => t.url.endsWith("/page/C")), { message: "Work's tab sleeps meanwhile (no page behind it)" });

      // B moves to Work.
      const b = (await k.tabs()).find((t) => t.title === "B");
      await toolbar.evaluate(`window.__kesselTest.activateTab(${b.id})`);
      await tell(k, { type: "workspace-move-tab", id: work.id });
      await waitFor(async () => (await k.tabs()).map((t) => t.title).join() === "A", { message: "B left for Work" });
      await new Promise((r) => setTimeout(r, 700));
      await k.close({ keepProfile: true });

      k = await launch({ profileDir });
      await waitFor(async () => (await k.tabs()).some((t) => t.url.endsWith("/page/A")), { message: "the first workspace came back" });
      assert.equal((await k.tabs()).length, 1, "with just its own tab");
      await tell(k, { type: "workspace-switch", id: work.id });
      await waitFor(async () => (await k.tabs()).map((t) => t.url.replace(/^.*\/page\//, "")).join() === "C,B", { message: "Work came back with C and B" });
    },
  },
  {
    name: "a page's right-click menu asks the AI assistant, and saves a selection as a note",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { ai_provider: "custom", ai_custom_url: `${site.origin}/page/Assistant?q=%s` } });
      const toolbar = await k.toolbar();
      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url: `${site.origin}/page/Article` });
      await waitFor(async () => (await k.tabs())[0].title === "Article", { message: "the article" });
      const article = `${site.origin}/page/Article`;

      await toolbar.evaluate(`window.__TAURI__.event.emit("page-menu", { action: "ai-page", value: ${JSON.stringify(article)}, page: ${JSON.stringify(article)}, title: "", tab: ${tab.id} })`);
      const assistant = await k.page((t) => t.url.startsWith(`${site.origin}/page/Assistant?q=`), { timeout: 15000 });
      assert(decodeURIComponent(assistant.url).includes(`Summarize this page for me: ${article}`), "it's asked about the page");

      await toolbar.evaluate(`window.__TAURI__.event.emit("page-menu", { action: "note-selection", value: "A sentence worth keeping", page: ${JSON.stringify(article)}, title: "", tab: ${tab.id} })`);
      const page = await sidebarPage(k);
      await page.waitFor(`document.querySelector(".note-editor textarea")?.value === "A sentence worth keeping"`, { message: "the note opened in the side panel" });
      const [note] = await k.invoke("get_notes");
      assert.equal(note.url, article, "linked to the page it came from");
      assert.equal(note.title, "Article", "with its title");
    },
  },
];
