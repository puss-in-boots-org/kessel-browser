// Kessel's PDF viewer: Mozilla's PDF.js (this folder), opened at
// kessel://pdf?src=<the PDF's address> (pdf.rs). Kessel hands it the file --
// a web PDF fetched with the tab's own cookies, a file from this computer --
// and turns on its tools: thumbnails, highlighting, drawing, text, images,
// signatures, comments, presentation mode. Its own Save button keeps what
// you added in the PDF.
document.addEventListener("webviewerloaded", () => {
  const options = window.PDFViewerApplicationOptions;
  options.set("defaultUrl", "");
  for (const [name, value] of [
    ["enableSignatureEditor", true],
    ["enableComment", true],
    ["enableHighlightFloatingButton", true],
    ["enableUpdatedAddImage", true],
  ]) {
    try {
      options.set(name, value);
    } catch {}
  }
});

window.addEventListener("load", async () => {
  const app = window.PDFViewerApplication;
  await app.initializedPromise;
  const src = new URLSearchParams(location.search).get("src");
  if (!src) return;
  const name = decodeURIComponent(src.split(/[?#]/)[0].split(/[\\/]/).pop() || "document.pdf");
  document.title = name;
  try {
    const bytes = await window.__TAURI__.core.invoke("pdf_bytes", { src });
    await app.open({ data: new Uint8Array(bytes), url: src, originalUrl: src, filename: name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf` });
  } catch (err) {
    const box = document.createElement("div");
    box.id = "kesselPdfError";
    box.style.cssText = "position:fixed;inset:auto 0 40% 0;text-align:center;font:14px system-ui;color:#c33";
    box.textContent = `Kessel couldn't open this PDF: ${err}`;
    document.body.append(box);
  }
});
