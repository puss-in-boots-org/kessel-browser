// Watched pages (watch.rs, kessel://feeds): a page watched for changes is
// checked; when its text changes the toolbar says what's new, the Feeds
// page lists it, and opening it means you've seen it.

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return tab.id;
}

export const tests = [
  {
    name: "a watched page: when its text changes the toolbar says what's new; the Feeds page lists it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const url = `${site.origin}/changing/Prices`;
      await open(k, url);
      await k.invoke("run_command", { id: "watch-page" });
      const first = await waitFor(async () => (await k.invoke("watched_pages")).find((w) => w.url === url && w.checked_at), { message: "watched, and checked once" });
      assert.equal(first.title, "Prices", "under the page's title");
      assert.equal(first.every_minutes, 60, "every hour unless you pick otherwise");

      // Only its script and a comment differ: no change.
      let w = (await k.invoke("check_watched_now", { id: first.id })).find((x) => x.id === first.id);
      assert(!w.changed_at && !w.unseen && !w.error, "the same text is no change");

      await fetch(`${url}?set=${encodeURIComponent("Now only 15 euros")}`);
      w = (await k.invoke("check_watched_now", { id: first.id })).find((x) => x.id === first.id);
      assert(w.changed_at && w.unseen, "changed");
      assert(w.change.includes("Now only 15 euros"), `what's new: ${w.change}`);

      const toolbar = await k.toolbar();
      await toolbar.waitFor(`(() => { const b = document.getElementById('notice-btn'); return !b.hidden && b.dataset.notice === 'watch:${w.id}' && b.textContent.includes('Page changed'); })()`, { message: "the toolbar says so" });

      // kessel://feeds/watched: listed, with what changed.
      await k.invoke("open_singleton_tab", { route: "kessel://feeds/watched" });
      const feeds = await k.page((t) => t.url.includes("feeds.html"));
      await feeds.waitFor(`document.querySelector('[data-watch="${w.id}"] .count')?.textContent === 'new'`, { message: "listed as new" });
      await feeds.waitFor(`(document.querySelector('.watched .change .s')?.textContent || '').includes('Now only 15 euros')`, { message: "with what changed" });

      // Opened from there: seen, and the notice goes.
      await feeds.evaluate(`document.querySelector('.watched .url').click()`);
      await waitFor(async () => (await k.tabs()).filter((t) => t.url === url).length === 2, { message: "opened in a tab" });
      await waitFor(async () => !(await k.invoke("watched_pages")).find((x) => x.id === w.id).unseen, { message: "seen" });
      await toolbar.waitFor(`document.getElementById('notice-btn').hidden`, { message: "the notice gone" });

      // Checked less often, then not at all.
      await feeds.evaluate(`(() => { const s = document.querySelector('.watched select'); s.value = '1440'; s.dispatchEvent(new Event('change')); })()`);
      await waitFor(async () => (await k.invoke("watched_pages"))[0].every_minutes === 1440, { message: "once a day" });
      await feeds.evaluate(`document.querySelector('[data-stop]').click()`);
      await waitFor(async () => (await k.invoke("watched_pages")).length === 0, { message: "no longer watched" });
    },
  },
];
