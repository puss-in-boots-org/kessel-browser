// PDFs in Kessel's own viewer (pdf.rs, PDF.js in src/pdfjs): a PDF link opens
// there with thumbnails, the drawing, highlighting, text, image and
// signature tools and presentation mode; a drawing is saved in the PDF; one
// behind a sign-in opens with the tab's cookies; one on this computer too;
// and Settings can leave PDFs to the engine's viewer.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
