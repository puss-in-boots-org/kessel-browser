// Media (FEATURES.md sections 20 and 35): the media controls beside the
// menu (media.rs, media.html) -- what a tab plays, play/pause, speed,
// captions, the page's own Media Session buttons -- and hardware
// acceleration with its diagnostics page (graphics.rs, kessel://gpu).

export const tests = [
  {
    name: "the media controls show and drive what a tab plays",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await k.createTab(`${site.origin}/media/Player`);
      const tab = await waitFor(async () => (await k.tabs()).find((t) => t.title === "Player"), { message: "the media page" });
      const page = await k.page(`${site.origin}/media/Player`);
      const toolbar = await k.toolbar();

      // Muted first, so nothing comes out of the speakers.
      await k.press("Ctrl+M", { tab: tab.id, page: true });
      await waitFor(async () => (await k.tabs()).find((t) => t.id === tab.id).muted, { message: "muted" });
      assert(await toolbar.evaluate(`document.getElementById('media-btn').hidden`), "no media button before anything played");

      assert(await page.evaluate(`startMedia()`, { userGesture: true }), "the page plays");
      await waitFor(async () => toolbar.evaluate(`!document.getElementById('media-btn').hidden`), { message: "the media button appears", timeout: 15000 });

      const state = await k.invoke("page_media", { id: tab.id });
      assert.equal(state.title, "Test Song", "the page's Media Session title");
      assert.equal(state.artist, "Kessel Band", "and artist");
      assert.equal(state.kind, "audio", "an audio player");
      assert.equal(state.paused, false, "playing");
      assert.deepEqual(state.actions, ["nexttrack"], "the page's own Next button");
      assert.equal(state.text.length, 1, "one subtitle track");

      await k.invoke("media_action", { id: tab.id, action: "rate", value: 1.5 });
      await waitFor(async () => (await page.evaluate(`document.getElementById('player').playbackRate`)) === 1.5, { message: "playback speed 1.5×" });

      await k.invoke("media_action", { id: tab.id, action: "text", value: 0 });
      await waitFor(async () => (await page.evaluate(`document.getElementById('player').textTracks[0].mode`)) === "showing", { message: "subtitles on" });

      await k.invoke("media_action", { id: tab.id, action: "nexttrack" });
      await waitFor(async () => (await page.evaluate(`window.nextPressed`)) === 1, { message: "the page's Next pressed" });

      await k.invoke("media_action", { id: tab.id, action: "toggle" });
      await waitFor(async () => page.evaluate(`document.getElementById('player').paused`), { message: "paused from the controls" });
      // Playing again needs a click in the page: the controls count as one.
      await k.invoke("media_action", { id: tab.id, action: "toggle" });
      await waitFor(async () => page.evaluate(`!document.getElementById('player').paused`), { message: "playing again" });

      // The popup itself lists the tab.
      await toolbar.clickSelector("#media-btn");
      const popup = await k.page((t) => t.url.includes("media.html"));
      await popup.waitFor(`document.querySelector('.card .title') && document.querySelector('.card .title').textContent === 'Test Song'`, { message: "a card for the tab" });
    },
  },
  {
    name: "hardware acceleration is on by default and kessel://gpu reports it",
    async run({ launch, assert, waitFor }) {
      const k = await launch();
      const info = await k.invoke("graphics_info");
      assert.equal(info.hardware_acceleration, true, "on by default");
      assert.equal(info.restart_needed, false, "nothing to apply");
      assert(info.engine_args.includes("AudioVideoTracks"), "audio tracks switched on in the engine");

      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url: "kessel://gpu" });
      const page = await k.page((t) => t.url.includes("gpu.html"));
      await page.waitFor(`document.getElementById('loading').hidden`, { message: "the checks finish", timeout: 20000 });
      const text = await page.evaluate(`document.body.innerText`);
      assert(text.includes("Hardware acceleration"), "the acceleration section");
      assert(text.includes("H.264"), "the video formats");

      // Turned off: applies at the next start, and the page says so.
      const settings = await k.invoke("get_settings");
      await k.invoke("update_settings", { settings: { ...settings, hardware_acceleration: false } });
      assert.equal((await k.invoke("graphics_info")).restart_needed, true, "a restart applies it");
      await waitFor(async () => (await k.activeTab()).title === "Graphics & media", { message: "the tab's title" });
    },
  },
  {
    name: "Kessel started without hardware acceleration draws in software",
    async run({ launch, assert }) {
      const k = await launch({ settings: { hardware_acceleration: false } });
      const info = await k.invoke("graphics_info");
      assert.equal(info.hardware_acceleration, false, "off for this run");
      assert(info.engine_args.includes("--disable-gpu"), "the engine was told");
      assert.equal(info.restart_needed, false, "as the settings say");
    },
  },
];
