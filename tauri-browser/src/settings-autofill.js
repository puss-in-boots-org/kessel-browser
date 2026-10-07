// Settings -> Addresses & cards (forms.rs): the addresses and payment cards
// Kessel fills into forms -- added, changed, removed -- and whether it fills
// and offers to save them. Cards are kept encrypted for your Windows
// account; their full number is never shown here, and the security code
// is never kept.

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";
import { toast, escapeHtml, confirmDialog } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;

const ADDRESS_FIELDS = [
  ["name", "Name"],
  ["organization", "Company"],
  ["street", "Street address"],
  ["city", "City"],
  ["region", "State / region"],
  ["postal_code", "Postal code"],
  ["country", "Country"],
  ["phone", "Phone"],
  ["email", "Email"],
];

const features = () => currentSettings()?.features || {};

export async function autofillPanel({ el, settingRow, switchHtml }) {
  const f = features();
  const panel = el(`<div class="panel" id="panel-autofill">
    <h2>Addresses &amp; cards</h2>
    <p class="sub">What forms ask for again and again, filled in with a click on the list under the field -- the page never sees that list. Kept on this computer; cards encrypted for your Windows account, and a card's security code never kept.</p>
    <div class="setting-card">
      ${settingRow({ title: "Fill in addresses and cards", desc: "A list of what you've saved under a form's field", controlHtml: switchHtml("form-autofill", f.form_autofill !== false) })}
      ${settingRow({ title: "Offer to save them", desc: "After you send a form with a new address or card in it -- never from a private window", controlHtml: switchHtml("form-offer", f.form_offer !== false) })}
    </div>
    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Addresses</span></div>
      <div class="list-panel" id="address-list" style="max-height:none"></div>
      <div class="add-row"><button class="btn sm" id="address-add">${icon("plus", 13)}<span>Add an address</span></button></div>
      <div id="address-editor"></div>
    </div>
    <div class="setting-card">
      <div class="k-card-title"><span class="k-label">Payment cards</span></div>
      <div class="list-panel" id="card-list" style="max-height:none"></div>
      <div class="add-row"><button class="btn sm" id="card-add">${icon("plus", 13)}<span>Add a card</span></button></div>
      <div id="card-editor"></div>
    </div>
  </div>`);
  const $ = (id) => panel.querySelector(`#${id}`);

  for (const [id, key] of [["form-autofill", "form_autofill"], ["form-offer", "form_offer"]]) {
    const sw = $(id);
    sw.addEventListener("click", async () => {
      const on = !sw.classList.contains("on");
      const next = { ...features() };
      if (on) delete next[key];
      else next[key] = false;
      await saveSettings({ features: next });
      sw.classList.toggle("on", on);
      sw.setAttribute("aria-checked", String(on));
    });
  }

  let data = { addresses: [], cards: [] };
  const load = async () => {
    data = await invoke("autofill_list").catch((err) => (toast(String(err)), { addresses: [], cards: [] }));
    renderAddresses();
    renderCards();
  };

  // --- Addresses ---
  const renderAddresses = () => {
    const list = $("address-list");
    list.innerHTML = data.addresses.length ? "" : `<div class="empty" style="padding:12px 16px">No addresses yet.</div>`;
    for (const a of data.addresses) {
      const row = el(`<div class="list-row" style="gap:10px">
        <span style="display:flex;color:var(--text-faint)">${icon("user", 15)}</span>
        <span class="lr-title"></span><span class="lr-sub"></span><span style="flex:1"></span>
        <button class="btn ghost icon-only sm" data-edit title="Change">${icon("edit", 13)}</button>
        <button class="btn ghost icon-only sm" data-remove title="Remove">${icon("trash", 13)}</button>
      </div>`);
      row.dataset.address = a.id;
      row.querySelector(".lr-title").textContent = [a.name, a.street].filter(Boolean).join(", ") || a.email || a.organization;
      row.querySelector(".lr-sub").textContent = [a.city, a.phone || a.email].filter(Boolean).join(" · ");
      row.querySelector("[data-edit]").addEventListener("click", () => editAddress(a));
      row.querySelector("[data-remove]").addEventListener("click", async () => {
        await invoke("autofill_delete_address", { id: a.id }).catch((err) => toast(String(err)));
        load();
      });
      list.appendChild(row);
    }
  };
  const editAddress = (a = {}) => {
    const box = $("address-editor");
    box.innerHTML = `<div style="padding:4px 16px 14px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">
      ${ADDRESS_FIELDS.map(([key, label]) => `<label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-dim)">${escapeHtml(label)}<input class="field" data-field="${key}" spellcheck="false" /></label>`).join("")}
      <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end"><button class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary" data-save>Save</button></div>
    </div>`;
    for (const input of box.querySelectorAll("[data-field]")) input.value = a[input.dataset.field] || "";
    box.querySelector("[data-cancel]").addEventListener("click", () => (box.innerHTML = ""));
    box.querySelector("[data-save]").addEventListener("click", async () => {
      const address = { id: a.id || "" };
      for (const input of box.querySelectorAll("[data-field]")) address[input.dataset.field] = input.value;
      try {
        await invoke("autofill_save_address", { address });
        box.innerHTML = "";
        load();
      } catch (err) {
        toast(String(err));
      }
    });
    box.querySelector("[data-field]").focus();
  };
  $("address-add").addEventListener("click", () => editAddress());

  // --- Cards ---
  const renderCards = () => {
    const list = $("card-list");
    list.innerHTML = data.cards.length ? "" : `<div class="empty" style="padding:12px 16px">No cards yet.</div>`;
    for (const c of data.cards) {
      const row = el(`<div class="list-row" style="gap:10px">
        <span style="display:flex;color:var(--text-faint)">${icon("card", 15)}</span>
        <span class="lr-title"></span><span class="lr-sub"></span><span style="flex:1"></span>
        <button class="btn ghost icon-only sm" data-edit title="Change">${icon("edit", 13)}</button>
        <button class="btn ghost icon-only sm" data-remove title="Remove">${icon("trash", 13)}</button>
      </div>`);
      row.dataset.card = c.id;
      row.querySelector(".lr-title").textContent = c.label;
      row.querySelector(".lr-sub").textContent = c.name;
      row.querySelector("[data-edit]").addEventListener("click", () => editCard(c));
      row.querySelector("[data-remove]").addEventListener("click", async () => {
        if (!(await confirmDialog(`Remove ${c.label}?`, "Remove"))) return;
        await invoke("autofill_delete_card", { id: c.id }).catch((err) => toast(String(err)));
        load();
      });
      list.appendChild(row);
    }
  };
  const editCard = (c = null) => {
    const box = $("card-editor");
    const year = new Date().getFullYear();
    const months = Array.from({ length: 12 }, (_, i) => i + 1);
    const years = Array.from({ length: 16 }, (_, i) => year + i);
    if (c && !years.includes(c.exp_year)) years.unshift(c.exp_year);
    box.innerHTML = `<div style="padding:4px 16px 14px;display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px">
      <label style="grid-column:1/-1;display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-dim)">Name on the card<input class="field" data-card="name" spellcheck="false" autocomplete="off" /></label>
      <label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-dim)">Card number<input class="field mono" data-card="number" inputmode="numeric" spellcheck="false" autocomplete="off" /></label>
      <label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-dim)">Month<select class="field" data-card="month">${months.map((m) => `<option value="${m}">${String(m).padStart(2, "0")}</option>`).join("")}</select></label>
      <label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-dim)">Year<select class="field" data-card="year">${years.map((y) => `<option value="${y}">${y}</option>`).join("")}</select></label>
      <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end"><button class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary" data-save>Save</button></div>
    </div>`;
    const field = (k) => box.querySelector(`[data-card="${k}"]`);
    field("name").value = c?.name || "";
    field("number").placeholder = c ? `•••• ${c.last4} (leave it to keep it)` : "1234 5678 9012 3456";
    field("month").value = String(c?.exp_month || new Date().getMonth() + 1);
    field("year").value = String(c?.exp_year || year);
    box.querySelector("[data-cancel]").addEventListener("click", () => (box.innerHTML = ""));
    box.querySelector("[data-save]").addEventListener("click", async () => {
      try {
        await invoke("autofill_save_card", { id: c?.id || null, name: field("name").value, number: field("number").value, expMonth: Number(field("month").value), expYear: Number(field("year").value) });
        box.innerHTML = "";
        load();
      } catch (err) {
        toast(String(err));
      }
    });
    field("name").focus();
  };
  $("card-add").addEventListener("click", () => editCard());

  await load();
  return panel;
}
