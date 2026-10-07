// Settings -> Security -> Lock Kessel (browser_lock.rs): a PIN or password
// that has to be entered to see your tabs again, Windows Hello as another
// way in, and when it locks by itself.

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";
import { toast, escapeHtml } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;

const IDLE = [[0, "Never"], [1, "1 minute"], [5, "5 minutes"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"]];

const lockOptions = () => currentSettings()?.features?.lock || {};
const saveLock = (patch) => saveSettings({ features: { ...(currentSettings()?.features || {}), lock: { ...lockOptions(), ...patch } } });

function selectHtml(id, options, width = 180) {
  return `<select class="field" id="${id}" style="width:${width}px">${options.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select>`;
}

export function lockCard(panel, { el, settingRow, switchHtml }) {
  const card = el(`<div class="setting-card" id="lock-card">
    <div class="k-card-title"><span class="k-label">Lock Kessel</span></div>
    <p style="margin:2px 18px 8px;font-size:12px;line-height:1.5;color:var(--text-faint)">Locked, every window shows a lock screen instead of your tabs until you enter your PIN or password. Your pages keep running behind it (downloads go on); nothing in them can be seen or typed into.</p>
    ${settingRow({ title: "Unlock with", desc: "…", controlHtml: `<span id="lock-actions" style="display:flex;gap:6px"></span>` })}
    <div id="lock-form" hidden style="padding:4px 18px 14px;display:flex;flex-direction:column;gap:8px">
      <input class="field" id="lock-current" type="password" placeholder="Your current PIN or password" autocomplete="off" />
      <input class="field" id="lock-new" type="password" autocomplete="off" />
      <input class="field" id="lock-repeat" type="password" autocomplete="off" />
      <div style="display:flex;gap:8px;align-items:center"><button class="btn sm primary" id="lock-save">Save</button><button class="btn sm ghost" id="lock-cancel">Cancel</button><span id="lock-error" style="font-size:12px;color:var(--danger)"></span></div>
    </div>
    <div id="lock-more">
      ${settingRow({ title: "Lock now", desc: "Also: the menu, or Lock Kessel in the command palette (F2)", controlHtml: `<button class="btn sm" id="lock-now">${icon("lock", 13)}<span>Lock</span></button>` })}
      <div id="lock-hello-row">${settingRow({ title: "Also unlock with Windows Hello", desc: "Your face, fingerprint or Windows PIN", controlHtml: switchHtml("lock-hello", !!lockOptions().hello) })}</div>
      ${settingRow({ title: "Lock when Kessel starts", controlHtml: switchHtml("lock-start", !!lockOptions().on_start) })}
      ${settingRow({ title: "Lock when the PC is left alone for", desc: "No key pressed and no mouse moved, anywhere", controlHtml: selectHtml("lock-idle", IDLE.map(([v, l]) => [String(v), l]), 150) })}
      ${settingRow({ title: "What it locks", controlHtml: selectHtml("lock-scope", [["all", "Every window"], ["private", "Private windows only"]], 170) })}
    </div>
  </div>`);
  panel.appendChild(card);
  const $ = (id) => card.querySelector(`#${id}`);
  let status = null;
  let editing = null; // "pin" | "password" | "none"

  async function render() {
    status = await invoke("lock_status").catch(() => ({ configured: false }));
    const desc = card.querySelector("#lock-actions").closest(".setting-row").querySelector(".desc");
    desc.textContent = status.configured ? (status.kind === "pin" ? "A PIN is set" : "A password is set") : "Nothing yet: Kessel doesn't lock";
    const actions = $("lock-actions");
    actions.innerHTML = "";
    const button = (label, kind) => {
      const b = el(`<button class="btn sm"></button>`);
      b.textContent = label;
      b.dataset.kind = kind;
      b.addEventListener("click", () => edit(kind));
      actions.appendChild(b);
    };
    button(status.configured && status.kind === "pin" ? "Change PIN" : "Set a PIN", "pin");
    button(status.configured && status.kind === "password" ? "Change password" : "Set a password", "password");
    if (status.configured) button("Turn off", "none");
    $("lock-more").hidden = !status.configured;
    $("lock-idle").value = String(status.idle_minutes || 0);
    $("lock-scope").value = status.private_only ? "private" : "all";
  }

  function edit(kind) {
    editing = kind;
    $("lock-form").hidden = false;
    $("lock-error").textContent = "";
    for (const id of ["lock-current", "lock-new", "lock-repeat"]) $(id).value = "";
    $("lock-current").hidden = !status.configured;
    const pin = kind === "pin";
    $("lock-new").hidden = $("lock-repeat").hidden = kind === "none";
    $("lock-new").placeholder = pin ? "New PIN (4 to 12 digits)" : "New password (at least 6 characters)";
    $("lock-repeat").placeholder = pin ? "The new PIN again" : "The new password again";
    $("lock-new").inputMode = $("lock-repeat").inputMode = pin ? "numeric" : "text";
    $("lock-save").textContent = kind === "none" ? "Turn the lock off" : "Save";
    ($("lock-current").hidden ? $("lock-new") : $("lock-current")).focus();
  }

  $("lock-cancel").addEventListener("click", () => ($("lock-form").hidden = true));
  $("lock-save").addEventListener("click", async () => {
    if (editing !== "none" && $("lock-new").value !== $("lock-repeat").value) {
      $("lock-error").textContent = "The two don't match";
      return;
    }
    try {
      await invoke("set_browser_lock", { kind: editing, secret: editing === "none" ? null : $("lock-new").value, current: $("lock-current").value || null });
      $("lock-form").hidden = true;
      toast(editing === "none" ? "The lock is off" : editing === "pin" ? "PIN saved" : "Password saved");
      await render();
    } catch (err) {
      $("lock-error").textContent = String(err);
    }
  });
  $("lock-now").addEventListener("click", () => invoke("lock_browser").catch((err) => toast(String(err))));
  for (const [id, key] of [["lock-hello", "hello"], ["lock-start", "on_start"]]) {
    const sw = $(id);
    sw.addEventListener("click", async () => {
      const on = !sw.classList.contains("on");
      await saveLock({ [key]: on });
      sw.classList.toggle("on", on);
      sw.setAttribute("aria-checked", String(on));
    });
  }
  $("lock-idle").addEventListener("change", () => saveLock({ idle_minutes: Number($("lock-idle").value) }));
  $("lock-scope").addEventListener("change", () => saveLock({ scope: $("lock-scope").value }));
  // Windows Hello only where it's set up.
  invoke("hello_available").then((ok) => ($("lock-hello-row").hidden = !ok), () => ($("lock-hello-row").hidden = true));
  render();
  return card;
}
