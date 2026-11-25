// PDFs in Kessel's own viewer (pdf.rs, PDF.js in src/pdfjs): a PDF link opens
// there with thumbnails, the drawing, highlighting, text, image and
// signature tools and presentation mode; a drawing is saved in the PDF; one
// whose address doesn't end in .pdf opens there too; Save writes the file; one
// behind a sign-in opens with the tab's cookies; one on this computer too;
// and Settings can leave PDFs to the engine's viewer.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makePdf } from "../lib/server.mjs";

// Opens `url` in the first tab; resolves with the viewer once its page shows `text`.
async function openPdf(k, waitFor, url, text) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const name = url.split("/").pop();
  const viewer = await k.page((t) => t.url.includes("/pdfjs/web/viewer.html") && t.url.includes(name), { timeout: 20000 }).catch(async (e) => {
    throw new Error(`${e.message}; targets ${(await k.targets()).map((t) => t.url).join(" | ")}`);
  });
  await waitFor(() => viewer.evaluate(`!!window.PDFViewerApplication?.pdfDocument && [...document.querySelectorAll('.textLayer')].some((l) => l.textContent.includes(${JSON.stringify(text)}))`).catch(() => false), {
    message: `the PDF saying "${text}"`,
    timeout: 20000,
  }).catch(async (e) => {
    throw new Error(`${e.message}; ${await viewer.evaluate(`document.getElementById('kesselPdfError')?.textContent || location.href`).catch(() => "")}`);
  });
  return { tab, viewer };
}

export const tests = [
  {
    name: "a PDF opens in Kessel's viewer: thumbnails, the drawing, highlighting, text, image and signature tools, presentation mode",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { viewer } = await openPdf(k, waitFor, `${site.origin}/doc/Report.pdf`, "Hello Report");
      assert.equal(await viewer.evaluate(`PDFViewerApplication.pagesCount`), 1);
      const visible = (id) => viewer.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return !!el && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none'; })()`);
      for (const id of ["editorHighlightButton", "editorInkButton", "editorFreeTextButton", "editorStampButton", "editorSignatureButton", "viewsManagerToggleButton"]) {
        assert(await visible(id), `${id} is there`);
      }
      // (Presentation mode is in the viewer's ">>" menu.)
      assert(await viewer.evaluate(`(() => { const b = document.getElementById('presentationMode'); return !!b && !b.hidden && !!PDFViewerApplication.pdfPresentationMode && document.fullscreenEnabled; })()`), "presentation mode");
      // Thumbnails.
      await viewer.evaluate(`document.getElementById('viewsManagerToggleButton').click()`);
      await waitFor(() => viewer.evaluate(`document.querySelectorAll('.thumbnail').length >= 1`), { message: "a page thumbnail" });
      // Its tab says what it is.
      await waitFor(async () => (await k.tabs())[0].title === "Report.pdf", { message: "the tab's title" });
    },
  },
  {
    name: "a drawing on a PDF is saved in it",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const { viewer } = await openPdf(k, waitFor, `${site.origin}/doc/Sketch.pdf`, "Hello Sketch");
      await viewer.evaluate(`document.getElementById('editorInkButton').click()`);
      await waitFor(() => viewer.evaluate(`PDFViewerApplication.pdfViewer.annotationEditorMode === 15`), { message: "the pen" });
      const [x, y, w, h] = await viewer.evaluate(`(() => { const r = document.querySelector('.page').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
      const send = (type, px, py) => viewer.session.send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
      await send("mousePressed", x + w * 0.2, y + h * 0.3);
      for (let i = 1; i <= 10; i++) await send("mouseMoved", x + w * (0.2 + i * 0.05), y + h * (0.3 + i * 0.03));
      await send("mouseReleased", x + w * 0.7, y + h * 0.6);
      // (Leaving the pen commits the line.)
      await viewer.evaluate(`document.getElementById('editorInkButton').click()`);
      await waitFor(() => viewer.evaluate(`PDFViewerApplication.pdfDocument.annotationStorage.size > 0`), { message: "the drawing kept" });
      const saved = await viewer.evaluate(`PDFViewerApplication.pdfDocument.saveDocument().then((b) => new TextDecoder('latin1').decode(b))`);
      assert(saved.includes("/Ink"), "the saved PDF has the drawing (an Ink annotation)");
    },
  },
  {
    name: "Save writes the PDF into your downloads folder; Save on a local PDF writes back into it",
    async run({ launch, site, assert, waitFor }) {
      const dir = mkdtempSync(path.join(tmpdir(), "kessel-pdf-save-"));
      try {
        const k = await launch({ settings: { features: { download_dir: dir } } });
        const { viewer } = await openPdf(k, waitFor, `${site.origin}/doc/Saved.pdf`, "Hello Saved");
        // The toolbar's Save button (what you add goes in too: the drawing test).
        await viewer.evaluate(`document.getElementById('downloadButton').click()`);
        const saved = path.join(dir, "Saved.pdf");
        await waitFor(() => existsSync(saved), { message: `Saved.pdf in the downloads folder (has ${readdirSync(dir).join(", ")})`, timeout: 15000 });
        assert(readFileSync(saved, "latin1").startsWith("%PDF-"), "it's a PDF");
        await waitFor(() => viewer.evaluate(`document.getElementById('kesselPdfNote')?.textContent.includes('Saved')`), { message: "the viewer says it's saved" });
        assert(await viewer.evaluate(`!!document.getElementById('kesselSaveAs')`), "Save as is in the menu");

        const local = path.join(dir, "Mine.pdf");
        writeFileSync(local, makePdf("Hello Mine"));
        const before = statSync(local).mtimeMs;
        await new Promise((r) => setTimeout(r, 50));
        const { viewer: mine } = await openPdf(k, waitFor, pathToFileURL(local).href, "Hello Mine");
        await mine.evaluate(`document.getElementById('downloadButton').click()`);
        await waitFor(() => statSync(local).mtimeMs !== before, { message: "Mine.pdf saved back into itself", timeout: 15000 });
        assert(!existsSync(path.join(dir, "Mine (1).pdf")), "not a copy");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "a PDF behind a sign-in opens with the tab's cookies; one on this computer opens too",
    async run({ launch, site, waitFor }) {
      const k = await launch();
      const [tab] = await k.tabs();
      await k.invoke("navigate", { id: tab.id, url: `${site.origin}/page/SignIn` });
      const page = await k.page((t) => t.url === `${site.origin}/page/SignIn`);
      await page.waitFor(`location.href === ${JSON.stringify(`${site.origin}/page/SignIn`)} && document.readyState === "complete"`);
      await page.evaluate(`document.cookie = "pdfauth=1; path=/"`);
      await openPdf(k, waitFor, `${site.origin}/doc-private/Secret.pdf`, "Hello Secret");

      const dir = mkdtempSync(path.join(tmpdir(), "kessel-pdf-"));
      try {
        const file = path.join(dir, "Local.pdf");
        writeFileSync(file, makePdf("Hello Local"));
        await openPdf(k, waitFor, pathToFileURL(file).href, "Hello Local").catch(async (e) => {
          throw new Error(`${e.message}; targets ${(await k.targets()).map((t) => t.url).join(" | ")}; tabs ${JSON.stringify((await k.tabs()).map((t) => t.url))}`);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "a PDF whose address doesn't end in .pdf opens in Kessel's viewer too",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      // (The server says what it is: Content-Type: application/pdf.)
      const { viewer } = await openPdf(k, waitFor, `${site.origin}/doc/Paper`, "Hello Paper");
      assert(await viewer.evaluate(`new URLSearchParams(location.search).get("src").endsWith("/doc/Paper")`), "the viewer has its address");
    },
  },
  {
    name: "Settings can leave PDFs to the engine's own viewer",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { features: { pdf_viewer: "engine" } } });
      const [tab] = await k.tabs();
      const url = `${site.origin}/doc/Plain.pdf`;
      await k.invoke("navigate", { id: tab.id, url });
      await waitFor(async () => (await k.targets()).some((t) => t.url === url), { message: "the PDF itself" });
      await new Promise((r) => setTimeout(r, 800));
      assert(!(await k.targets()).some((t) => t.url.includes("/pdfjs/")), "not Kessel's viewer");
    },
  },
];
