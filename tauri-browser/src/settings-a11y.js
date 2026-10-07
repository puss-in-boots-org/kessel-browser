// Settings -> Accessibility (a11y.rs, page-tools.js): text size and fonts in
// pages, a smallest font size, less motion, a clear keyboard outline,
// caret browsing, colours -- and what Kessel takes from Windows by itself.

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";
import { toast, escapeHtml, debounce } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;

const SIZES = [["13", "Smaller"], ["0", "Normal"], ["18", "Large"], ["20", "Larger"], ["24", "Largest"], ["28", "Huge"]];
const MIN_SIZES = [["0", "No smallest size"], ["10", "10 px"], ["12", "12 px"], ["14", "14 px"], ["16", "16 px"], ["18", "18 px"]];
const FILTERS = [["", "None"], ["contrast", "More contrast"], ["grayscale", "Grayscale"], ["invert", "Invert colours"], ["dark", "Dark (invert the page)"], ["sepia", "Sepia"], ["dim", "Dimmer"]];
const FONTS = ["Segoe UI", "Arial", "Verdana", "Tahoma", "Calibri", "Georgia", "Times New Roman", "Cambria", "Atkinson Hyperlegible", "OpenDyslexic", "Comic Sans MS", "Consolas", "Courier New", "Cascadia Mono"];

const a11y = () => currentSettings()?.features?.a11y || {};
const features = () => currentSettings()?.features || {};
const saveA11y = (patch) => saveSettings({ features: { ...features(), a11y: { ...a11y(), ...patch } } });

function selectHtml(id, options, width = 180) {
  return `<select class="field" id="${id}" style="width:${width}px">${options.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select>`;
}

export async function a11yPanel(settings, { el, settingRow, switchHtml }) {
  const a = a11y();
  const fonts = a.fonts || {};
  const fontInput = (key, placeholder) => `<input class="field" id="font-${key}" list="font-list" style="width:200px" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(fonts[key] || "")}" />`;
  const panel = el(`<div class="panel" id="panel-accessibility">
    <h2>Accessibility</h2>
    <p class="sub">How pages look and move, for you. Kessel also follows Windows by itself: its contrast themes, "Animation effects", and screen readers (Narrator, NVDA, JAWS) work in pages and in Kessel's own windows.</p>
    <datalist id="font-list">${FONTS.map((f) => `<option value="${escapeHtml(f)}">`).join("")}</datalist>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Text in pages</span></div>
      ${settingRow({ title: "Text size", desc: "Only the text grows -- the rest of the page stays as it is (for zooming everything: Ctrl+Plus)", controlHtml: selectHtml("a11y-size", SIZES, 150) })}
      ${settingRow({ title: "Smallest font size", desc: "Text a page makes smaller than this is shown at this size", controlHtml: selectHtml("a11y-min", MIN_SIZES, 150) })}
      ${settingRow({ title: "Standard font", desc: "For pages that don't choose their own", controlHtml: fontInput("standard", "Times New Roman") })}
      ${settingRow({ title: "Sans-serif font", controlHtml: fontInput("sans", "Arial") })}
      ${settingRow({ title: "Serif font", controlHtml: fontInput("serif", "Times New Roman") })}
      ${settingRow({ title: "Fixed-width font", controlHtml: fontInput("fixed", "Consolas") })}
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Movement and focus</span></div>
      ${settingRow({ title: "Less motion", desc: "Pages hear you'd rather not have it, and their animations and transitions stop", controlHtml: switchHtml("a11y-motion", !!a.reduce_motion) })}
      ${settingRow({ title: "Always show where the keyboard is", desc: "A bold outline around whatever has the focus, on every page -- even ones that hide it", controlHtml: switchHtml("a11y-focus", !!a.focus_rings) })}
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Keyboard</span></div>
      ${settingRow({ title: "Caret browsing", desc: "F7: move a text cursor through pages with the arrow keys, and select with Shift -- after a restart", controlHtml: `<button class="btn sm restart-btn" id="a11y-restart" style="display:none">${icon("refresh", 13)}<span>Restart now</span></button>${switchHtml("a11y-caret", !!a.caret_browsing)}` })}
      ${settingRow({ title: "Moving around", desc: "F6: the address bar; Shift+F6: the page; Alt+F or F10: the menu; F2: every command; Ctrl+Tab: the next tab. All shortcuts: Settings -> Keyboard & Mouse", controlHtml: "" })}
    </div>

    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Colours</span></div>
      ${settingRow({ title: "Colour filter for every site", desc: "More contrast, grayscale, inverted... Each site can have its own: Settings -> Page tools", controlHtml: selectHtml("a11y-filter", FILTERS, 200) })}
    </div>
  </div>`);

  const $ = (id) => panel.querySelector(`#${id}`);
  $("a11y-size").value = String(a.text_size || 0);
  $("a11y-min").value = String(a.min_font || 0);
  $("a11y-filter").value = features().page_filter || "";
  $("a11y-size").addEventListener("change", () => saveA11y({ text_size: Number($("a11y-size").value) }));
  $("a11y-min").addEventListener("change", () => saveA11y({ min_font: Number($("a11y-min").value) }));
  $("a11y-filter").addEventListener("change", () => saveSettings({ features: { ...features(), page_filter: $("a11y-filter").value || undefined } }));
  for (const key of ["standard", "sans", "serif", "fixed"]) {
    const input = $(`font-${key}`);
    const save = debounce(() => saveA11y({ fonts: { ...(a11y().fonts || {}), [key]: input.value.trim() } }), 400);
    input.addEventListener("input", save);
    input.addEventListener("change", save);
  }
  const switches = [["a11y-motion", "reduce_motion"], ["a11y-focus", "focus_rings"], ["a11y-caret", "caret_browsing"]];
  for (const [id, key] of switches) {
    const sw = $(id);
    sw.addEventListener("click", async () => {
      const on = !sw.classList.contains("on");
      await saveA11y({ [key]: on });
      sw.classList.toggle("on", on);
      sw.setAttribute("aria-checked", String(on));
      if (key === "caret_browsing") $("a11y-restart").style.display = on === (await invoke("caret_browsing_running").catch(() => on)) ? "none" : "";
    });
  }
  $("a11y-restart").addEventListener("click", () => invoke("restart_kessel").catch((err) => toast(String(err))));
  return panel;
}
