// Kessel for phones' UI in a desktop Chromium, at a phone's size, with a
// pretend browser behind it (mock-native.js): screenshots of every screen,
// and a check that none of them throws. For working on the UI without a
// phone -- the real app is built by .github/workflows/android.yml.
//
//   npm i playwright            (once: here, or anywhere NODE_PATH points)
//   node kessel-mobile/tests/preview/preview.mjs [out-dir] [--chromium /path/to/chrome]

import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// require(), not import: it finds playwright wherever NODE_PATH says too.
const { chromium } = createRequire(import.meta.url)("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.join(here, "..", "..", "app", "src", "main", "assets", "ui");
const shared = path.join(here, "..", "..", "..", "tauri-browser", "src", "shared");
const args = process.argv.slice(2);
const chromeAt = args.includes("--chromium") ? args[args.indexOf("--chromium") + 1] : process.env.KESSEL_CHROMIUM;
const out = path.resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--chromium") || "kessel-mobile-preview");
mkdirSync(out, { recursive: true });

// The UI's files, and the desktop's shared ones under shared/ (as the app build copies them).
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const file = url.pathname.startsWith("/shared/") ? path.join(shared, url.pathname.slice(8)) : path.join(ui, url.pathname === "/" ? "index.html" : url.pathname);
  try {
    const body = readFileSync(file);
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(chromeAt ? { executablePath: chromeAt } : {});
const errors = [];

async function phone(scheme) {
  const context = await browser.newContext({ viewport: { width: 412, height: 870 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${scheme}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`${scheme}: ${m.text()}`));
  // Missing files (the page's own favicon.ico aside: the real UI has none to ask for).
  page.on("response", (r) => r.status() >= 400 && !r.url().endsWith("/favicon.ico") && errors.push(`${scheme}: ${r.status()} ${r.url()}`));
  await page.addInitScript({ path: path.join(here, "mock-native.js") });
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => window.__mock && window.__mock.ready);
  return page;
}

const shot = async (page, name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log(`${name}.png`);
};
const event = (page, name, payload) => page.evaluate(([n, p]) => window.__kesselEvent(n, p), [name, payload]);

for (const scheme of ["dark", "light"]) {
  const page = await phone(scheme);
  await shot(page, `${scheme}-01-new-tab`);

  await page.evaluate(() => window.__mock.goActive("https://www.youtube.com/watch?v=1", "Cats - YouTube"));
  await shot(page, `${scheme}-02-page`);

  await page.tap("#address");
  await page.fill("#address-input", "yout");
  await page.dispatchEvent("#address-input", "input");
  await shot(page, `${scheme}-03-typing`);
  await page.fill("#address-input", "100 usd to huf");
  await page.dispatchEvent("#address-input", "input");
  await shot(page, `${scheme}-04-answer`);
  await page.evaluate(() => window.__kesselBack());

  await page.tap("#menu-btn");
  await shot(page, `${scheme}-05-menu`);
  await page.evaluate(() => window.__kesselBack());

  await page.tap("#site-btn");
  await shot(page, `${scheme}-06-site`);
  await page.evaluate(() => window.__kesselBack());

  await page.evaluate(() => window.__mock.addTabs());
  await page.tap("#tabs-btn");
  await shot(page, `${scheme}-07-tabs`);
  await page.tap('[data-seg="1"]');
  await shot(page, `${scheme}-08-private-tabs`);
  await page.tap("#switcher-done");

  await event(page, "context", { kind: "image-link", url: "https://news.example/story/1", text: "Read the story", image: "", private: false, privateSupported: true });
  await shot(page, `${scheme}-09-long-press`);
  await page.evaluate(() => window.__kesselBack());

  await event(page, "permission", { id: 7, host: "meet.example", kinds: ["camera", "microphone"], private: false });
  await shot(page, `${scheme}-10-permission`);
  await page.evaluate(() => window.__kesselBack());

  for (const name of ["history", "bookmarks", "downloads", "settings"]) {
    await page.tap("#menu-btn");
    await page.tap(`[data-a="${name}"]`);
    await shot(page, `${scheme}-11-${name}`);
    await page.evaluate(() => window.__kesselBack());
  }

  await page.tap("#menu-btn");
  await page.tap('[data-a="find"]');
  await page.fill("#find-input", "cat");
  await event(page, "find", { active: 2, count: 14 });
  await shot(page, `${scheme}-12-find`);
  await page.evaluate(() => window.__kesselBack());

  await page.evaluate(() => window.__mock.newPrivate());
  await shot(page, `${scheme}-13-private-new-tab`);

  const modes = await page.evaluate(() => window.__mock.modes);
  if (!modes.includes("bar:bottom") || !modes.includes("full:bottom")) errors.push(`${scheme}: the UI never asked for both bar and full modes: ${modes}`);
  await page.context().close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\nNo errors. Screenshots in ${out}`);
