// Dragging tabs with the mouse (main.js startDrag): along the strip to
// reorder, to the page's edge for split view (split.rs), out of the strip
// into a window of its own (tabdrag.rs).

// Presses at (x, y) in the toolbar, moves in steps to (tx, ty), lets go.
async function dragInToolbar(toolbar, [x, y], [tx, ty], { steps = 12, hold = 0 } = {}) {
  const send = (type, px, py) => toolbar.session.send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  await send("mousePressed", x, y);
  for (let i = 1; i <= steps; i++) {
    await send("mouseMoved", x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
    await new Promise((r) => setTimeout(r, 16));
  }
  if (hold) await new Promise((r) => setTimeout(r, hold));
  await send("mouseReleased", tx, ty);
}

const tabCenter = (toolbar, i) =>
  toolbar.evaluate(`(() => { const r = document.querySelectorAll('#tabs > .tab')[${i}].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);

async function threeTabs(k, site, waitFor) {
  const toolbar = await k.toolbar();
  const [first] = await k.tabs();
  await k.invoke("navigate", { id: first.id, url: `${site.origin}/page/A` });
  await k.createTab(`${site.origin}/page/B`);
  await k.createTab(`${site.origin}/page/C`);
  await waitFor(async () => (await k.tabs()).map((t) => t.title).join() === "A,B,C", { message: "tabs A, B, C" });
  return toolbar;
}

export const tests = [
  {
    name: "dragging a tab along the strip moves it there",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const toolbar = await threeTabs(k, site, waitFor);
      const from = await tabCenter(toolbar, 0);
      const to = await tabCenter(toolbar, 2);
      await dragInToolbar(toolbar, from, [to[0] + 20, to[1]]);
      await waitFor(async () => (await k.tabs()).map((t) => t.title).join() === "B,C,A", { message: "A moved to the end" });
      assert.equal((await k.activeTab()).title, "A", "the dragged tab is the one you're on");
    },
  },
  {
    name: "a tab held at the page's right edge opens beside the one you're on",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const toolbar = await threeTabs(k, site, waitFor);
      await toolbar.evaluate(`window.__kesselTest.activateTab(${(await k.tabs())[1].id})`);
      const from = await tabCenter(toolbar, 2);
      const size = await toolbar.evaluate(`[innerWidth, innerHeight]`);
      await dragInToolbar(toolbar, from, [size[0] - 30, size[1] / 2], { steps: 16, hold: 150 });
      await waitFor(() => toolbar.evaluate(`!document.getElementById('split-divider').hidden`), { message: "split view's divider" });
      assert.equal((await k.tabs()).map((t) => t.title).join(), "A,B,C", "the pair sits side by side in the strip");
      await toolbar.evaluate(`window.__TAURI__.core.invoke('unsplit')`);
      await waitFor(() => toolbar.evaluate(`document.getElementById('split-divider').hidden`), { message: "split view ended" });
    },
  },
  {
    name: "a tab dragged out of the strip moves into a new window",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const toolbar = await threeTabs(k, site, waitFor);
      const from = await tabCenter(toolbar, 1);
      await dragInToolbar(toolbar, from, [from[0] + 40, from[1] + 220], { steps: 14 });
      await waitFor(async () => (await k.windows()).length === 2, { message: "a second window" });
      await waitFor(async () => (await k.tabs()).map((t) => t.title).join() === "A,C", { message: "B left the first window" });
      const other = (await k.windows()).find((w) => w !== "win-1");
      await waitFor(async () => (await k.tabs(other).catch(() => [])).map((t) => t.title).join() === "B", { message: "B in the new window" });
    },
  },
];
