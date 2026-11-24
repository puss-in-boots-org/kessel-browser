// Kessel's PDF viewer: Mozilla's PDF.js (this folder), opened at
// kessel://pdf?src=<the PDF's address> (pdf.rs). Kessel hands it the file --
// a web PDF fetched with the tab's own cookies, a file from this computer --
// and turns on its tools: thumbnails, highlighting, drawing, text, images,
// signatures, comments, presentation mode.
//
// Saving: PDF.js would save through a blob: link the engine downloads, which
// didn't work in Kessel. Instead the viewer hands the bytes -- with what you
// added, if anything -- to Kessel (pdf_save), which writes the file itself:
// Save (Ctrl+S) puts a PDF from this computer back in its own file and one
// from the web in your downloads folder; Save as (Ctrl+Shift+S, in the >>
// menu) asks where. Leaving a PDF you changed but didn't save asks first.
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

const kesselSrc = new URLSearchParams(location.search).get("src");
const invoke = (...args) => window.__TAURI__.core.invoke(...args);

// A short note at the bottom of the viewer, with a button if `action`.
function kesselNote(text, { error = false, action = null, actionLabel = "" } = {}) {
  document.getElementById("kesselPdfNote")?.remove();
  const note = document.createElement("div");
  note.id = "kesselPdfNote";
  note.setAttribute("role", "status");
  note.className = error ? "error" : "";
  const label = document.createElement("span");
  label.textContent = text;
  note.append(label);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = actionLabel;
    button.addEventListener("click", () => {
      action();
      note.remove();
    });
    note.append(button);
  }
  document.body.append(note);
  setTimeout(() => note.remove(), error ? 8000 : 5000);
}

// The next save asks where (Save as).
let kesselAskNext = false;

async function kesselWrite(data, filename, { attachment = false } = {}) {
  const app = window.PDFViewerApplication;
  const ask = kesselAskNext;
  kesselAskNext = false;
  try {
    // PDF.js couldn't hand over its copy: Kessel's own, as it was opened.
    if (!data && !attachment && kesselSrc) data = await invoke("pdf_bytes", { src: kesselSrc });
    if (!data) throw new Error("there's nothing to save");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const how = encodeURIComponent(JSON.stringify({ src: kesselSrc || "", name: filename || "", ask, attachment }));
    const path = await invoke("pdf_save", bytes, { headers: { "x-kessel-save": how } });
    if (!path) return false; // you cancelled "Save as"
    // What you added is saved now: leaving doesn't ask any more.
    if (!attachment) app?.pdfDocument?.annotationStorage.resetModified();
    const name = path.split(/[\\/]/).pop();
    kesselNote(`Saved ${name}`, { action: () => invoke("show_download", { path }).catch(() => {}), actionLabel: "Show in folder" });
    return true;
  } catch (err) {
    kesselNote(`Couldn't save the ${attachment ? "attachment" : "PDF"}: ${err?.message || err}`, { error: true });
    return false;
  }
}

function kesselSaveAs() {
  const app = window.PDFViewerApplication;
  if (!app?.pdfDocument) return;
  app.secondaryToolbar?.close();
  kesselAskNext = true;
  // PDF.js works out what to save (the file, or the file with your
  // changes, or the pages you reorganized) and hands it to kesselWrite.
  app.downloadOrSave().finally(() => (kesselAskNext = false));
}

function kesselSaveAsButton() {
  const save = document.getElementById("secondaryDownload");
  const container = document.getElementById("secondaryToolbarButtonContainer");
  if (!container || document.getElementById("kesselSaveAs")) return;
  const button = document.createElement("button");
  button.id = "kesselSaveAs";
  button.type = "button";
  button.className = "toolbarButton labeled";
  button.tabIndex = 0;
  button.title = "Save a copy somewhere you choose (Ctrl+Shift+S)";
  const label = document.createElement("span");
  label.textContent = "Save as…";
  button.append(label);
  button.addEventListener("click", kesselSaveAs);
  // Right below the menu's Save, which only shows when the toolbar is narrow.
  const anchor = save?.closest(".visibleMediumView") || container.firstElementChild;
  anchor ? anchor.after(button) : container.prepend(button);
}

window.addEventListener("load", async () => {
  const app = window.PDFViewerApplication;
  await app.initializedPromise;

  // Saving goes through Kessel (see the top). PDF.js's other parts hold
  // this same download manager, so the attachments sidebar saves this way too.
  const manager = app.downloadManager;
  if (manager) {
    manager.download = (data, _url, filename) => kesselWrite(data, filename);
    manager.downloadData = (data, filename) => kesselWrite(data, filename, { attachment: true });
  }
  kesselSaveAsButton();
  window.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === "KeyS") {
        event.preventDefault();
        event.stopPropagation();
        kesselSaveAs();
      }
    },
    true,
  );
  // Leaving with changes you haven't saved: the engine asks if you're sure.
  window.addEventListener("beforeunload", (event) => {
    if (app._annotationStorageModified) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  if (!kesselSrc) return;
  const name = decodeURIComponent(kesselSrc.split(/[?#]/)[0].split(/[\\/]/).pop() || "document.pdf");
  document.title = name;
  try {
    const bytes = await invoke("pdf_bytes", { src: kesselSrc });
    await app.open({ data: new Uint8Array(bytes), url: kesselSrc, originalUrl: kesselSrc, filename: name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf` });
  } catch (err) {
    const box = document.createElement("div");
    box.id = "kesselPdfError";
    box.style.cssText = "position:fixed;inset:auto 0 40% 0;text-align:center;font:14px system-ui;color:#c33";
    box.textContent = `Kessel couldn't open this PDF: ${err}`;
    document.body.append(box);
  }
});
