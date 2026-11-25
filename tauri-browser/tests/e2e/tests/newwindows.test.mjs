// Links and window.open() that ask for a new window: a tab, a real popup
// window for sign-ins, and the blank window Gmail (and Docs, Calendar...)
// opens for a link and then sends on itself.

async function openPage(k, url) {
  const id = await k.createTab(url);
  const page = await k.page(url);
  await page.waitFor(`document.readyState === 'complete'`);
  return { id, page };
}

// A button on the page that runs `code` when it's really clicked.
async function button(page, id, code) {
  await page.evaluate(`(() => {
    const b = document.createElement('button');
    b.id = ${JSON.stringify(id)};
    b.textContent = ${JSON.stringify(id)};
    b.style.cssText = 'position:fixed;left:10px;top:10px;width:160px;height:40px;z-index:9';
    b.onclick = () => { ${code} };
    document.body.appendChild(b);
  })()`);
  await page.clickSelector(`#${id}`);
}

const tabAt = (k, path) => async () => (await k.tabs()).find((t) => t.url.endsWith(path));

export const tests = [
  {
    name: "a target=_blank link opens as a tab",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await openPage(k, `${site.origin}/page/Links`);
      const before = (await k.tabs()).length;
      await page.clickSelector("#link-blank");
      await waitFor(tabAt(k, "/page/blank-target"), { message: "the link's tab" });
      assert.equal((await k.tabs()).length, before + 1, "one new tab");
    },
  },
  {
    name: "Gmail's way of opening a link -- a blank window it writes a redirect into -- opens as a tab",
    async run({ launch, site, assert, waitFor, sleep }) {
      const k = await launch();
      const { page } = await openPage(k, `${site.origin}/page/Mail`);
      const before = (await k.tabs()).length;
      // What Closure's goog.window.open does with { noreferrer: true }.
      await button(page, "gmail-link", `
        const w = window.open('', '_blank');
        w.opener = null;
        w.document.write('<meta http-equiv="refresh" content="0; url=${site.origin}/page/DriveFile">');
        w.document.close();
      `);
      await waitFor(tabAt(k, "/page/DriveFile"), { message: "the link's tab" });
      await sleep(500);
      assert.equal((await k.tabs()).length, before + 1, "one new tab");
    },
  },
  {
    name: "a blank window the page sends somewhere after looking it up opens as a tab",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await openPage(k, `${site.origin}/page/Calendar`);
      await button(page, "later-link", `
        const w = window.open('');
        setTimeout(() => { w.location.href = '${site.origin}/page/Looked-up'; }, 300);
      `);
      await waitFor(tabAt(k, "/page/Looked-up"), { message: "the tab" });
    },
  },
  {
    name: "a sign-in popup that asks for a size is a window of its own that can talk back",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { page } = await openPage(k, `${site.origin}/page/App`);
      const before = (await k.tabs()).length;
      await button(page, "sign-in", `window.signIn = window.open('${site.origin}/page/SignIn', 'signin', 'width=480,height=600');`);
      const popup = await k.page(`${site.origin}/page/SignIn`);
      await popup.waitFor(`document.readyState === 'complete'`);
      assert(await popup.evaluate(`!!window.opener`), "the popup knows its opener");
      assert.equal((await k.tabs()).length, before, "not a tab");
      await page.evaluate(`window.addEventListener('message', (e) => { window.heard = e.data; })`);
      await popup.evaluate(`window.opener.postMessage('signed-in', '*')`);
      await page.waitFor(`window.heard === 'signed-in'`, { message: "the opener heard back" });
      await popup.evaluate(`window.close()`);
      await waitFor(async () => !(await k.targets()).some((t) => t.url.includes("/page/SignIn")), { message: "the popup closed" });
    },
  },
];
