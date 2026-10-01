import { icon } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { toast, debounce, confirmDialog, escapeHtml } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;

let items = [];
let pendingPassword = null; // held only in memory between "wrong/needs 2FA" retries
let lastActivity = Date.now();
let editingId = null;
// Password health (passwords.rs): id -> { strength, why, reused }; and,
// once you've asked, id -> times seen in breaches.
let health = new Map();
let breaches = null;
let healthFilter = "all";

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function markActivity() {
  lastActivity = Date.now();
}

// --- Lock / setup screen ---------------------------------------------------

function renderSetupForm() {
  document.getElementById("lock-title").textContent = "Create your vault";
  document.getElementById("lock-sub").textContent = "Choose a master password. It's never stored -- only you know it.";
  const form = document.getElementById("lock-form");
  form.innerHTML = `
    <input class="field" type="password" id="setup-pw" placeholder="Master password" autofocus />
    <div class="strength-bar"><div id="strength-fill"></div></div>
    <input class="field" type="password" id="setup-pw2" placeholder="Confirm master password" />
    <button class="btn primary block" id="setup-btn">Create vault</button>
  `;
  const pw = document.getElementById("setup-pw");
  const fill = document.getElementById("strength-fill");
  pw.addEventListener("input", () => {
    const s = strengthOf(pw.value);
    fill.style.width = `${s.pct}%`;
    fill.style.background = s.color;
  });
  document.getElementById("setup-btn").addEventListener("click", async () => {
    const p1 = pw.value;
    const p2 = document.getElementById("setup-pw2").value;
    setLockError("");
    if (p1.length < 8) return setLockError("Use at least 8 characters.");
    if (p1 !== p2) return setLockError("Passwords don't match.");
    try {
      await invoke("vault_setup", { masterPassword: p1 });
      toast("Vault created");
      await enterDashboard();
    } catch (e) {
      setLockError(String(e));
    }
  });
  wireEnterKey(form, () => document.getElementById("setup-btn").click());
}

function strengthOf(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  const pct = Math.min(100, (score / 5) * 100);
  const color = score <= 1 ? "var(--danger)" : score <= 3 ? "var(--warning)" : "var(--success)";
  return { pct, color };
}

function renderUnlockForm(needsTotp = false) {
  document.getElementById("lock-title").textContent = needsTotp ? "Two-factor code" : "Unlock your vault";
  document.getElementById("lock-sub").textContent = needsTotp
    ? "Enter the 6-digit code from your authenticator app."
    : "Enter your master password to continue.";
  const form = document.getElementById("lock-form");
  if (needsTotp) {
    form.innerHTML = `
      <input class="field" id="unlock-totp" placeholder="000000" inputmode="numeric" maxlength="6" autofocus style="text-align:center;letter-spacing:4px;font-size:16px" />
      <button class="btn primary block" id="unlock-btn">Verify</button>
      <button class="btn ghost block" id="unlock-back-btn" style="margin-top:8px">Back</button>
    `;
    document.getElementById("unlock-back-btn").addEventListener("click", () => {
      pendingPassword = null;
      renderUnlockForm(false);
    });
    document.getElementById("unlock-btn").addEventListener("click", () => attemptUnlock(pendingPassword, document.getElementById("unlock-totp").value));
  } else {
    form.innerHTML = `
      <input class="field" type="password" id="unlock-pw" placeholder="Master password" autofocus />
      <button class="btn primary block" id="unlock-btn">Unlock</button>
    `;
    document.getElementById("unlock-btn").addEventListener("click", () => attemptUnlock(document.getElementById("unlock-pw").value, null));
  }
  wireEnterKey(form, () => document.getElementById("unlock-btn").click());
}

function wireEnterKey(container, fn) {
  container.querySelectorAll("input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") fn();
    });
  });
}

function setLockError(msg) {
  document.getElementById("lock-error").textContent = msg;
}

async function attemptUnlock(password, totpCode) {
  setLockError("");
  try {
    await invoke("vault_unlock", { masterPassword: password, totpCode: totpCode || null });
    pendingPassword = null;
    toast("Vault unlocked");
    await enterDashboard();
  } catch (e) {
    const msg = String(e);
    if (msg.includes("2FA code required")) {
      pendingPassword = password;
      renderUnlockForm(true);
    } else {
      setLockError(msg.replace(/^Error:\s*/, ""));
    }
  }
}

// --- Dashboard --------------------------------------------------------

async function enterDashboard() {
  document.getElementById("lock-screen").style.display = "none";
  document.getElementById("vault-shell").style.display = "flex";
  markActivity();
  await refreshItems();
}

async function showLockScreen(message) {
  document.getElementById("vault-shell").style.display = "none";
  document.getElementById("lock-screen").style.display = "flex";
  if (message) toast(message);
  const status = await invoke("vault_status");
  if (status.initialized) renderUnlockForm(false);
  else renderSetupForm();
}

async function refreshItems() {
  try {
    items = await invoke("vault_list_items");
    health = new Map(((await invoke("vault_health").catch(() => [])) || []).map((h) => [h.id, h]));
    renderHealth();
    renderList(items);
  } catch (e) {
    if (String(e).includes("locked")) await showLockScreen("Vault locked");
  }
}

function itemMatches(item, query) {
  const q = query.toLowerCase();
  return item.site.toLowerCase().includes(q) || item.username.toLowerCase().includes(q);
}

function renderList(list) {
  const container = document.getElementById("vault-list");
  const query = document.getElementById("vault-search").value.trim();
  const byHealth = list.filter((i) => {
    const h = health.get(i.id);
    if (healthFilter === "weak") return h && h.strength <= 1;
    if (healthFilter === "reused") return h && h.reused > 0;
    if (healthFilter === "breached") return breaches && breaches[i.id] > 0;
    return true;
  });
  const filtered = query ? byHealth.filter((i) => itemMatches(i, query)) : byHealth;
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty">${query ? "No matches." : "No saved passwords yet -- tap + to add one."}</div>`;
    return;
  }
  container.innerHTML = "";
  for (const item of filtered) {
    const row = el(`<div class="item-row" data-id="${escapeHtml(item.id)}">
      <span class="item-avatar">${escapeHtml((item.site[0] || "?").toUpperCase())}</span>
      <span class="item-info">
        <div class="item-site"></div>
        <div class="item-user"></div>
      </span>
      <span class="item-pass mono">••••••••</span>
      <span class="item-actions">
        <button class="btn ghost icon-only sm reveal-btn" title="Show/hide">${icon("eye", 14)}</button>
        <button class="btn ghost icon-only sm copy-btn" title="Copy password">${icon("copy", 14)}</button>
      </span>
    </div>`);
    row.querySelector(".item-site").textContent = item.site;
    row.querySelector(".item-user").textContent = item.username || "(no username)";
    const h = health.get(item.id);
    const flags = [];
    if (breaches && breaches[item.id] > 0) flags.push(["", `in ${breaches[item.id].toLocaleString()} data breaches -- change it`]);
    if (h && h.reused > 0) flags.push(["", `also used on ${h.reused} other site${h.reused === 1 ? "" : "s"}`]);
    if (h && h.strength <= 1) flags.push(["warn", `weak: ${h.why[0] || "easy to guess"}`]);
    if (flags.length) {
      const box = document.createElement("div");
      box.className = "item-flags";
      for (const [kind, text] of flags) {
        const f = document.createElement("span");
        f.className = `flag ${kind}`;
        f.textContent = text;
        box.appendChild(f);
      }
      row.querySelector(".item-info").appendChild(box);
    }
    const passEl = row.querySelector(".item-pass");
    let revealed = false;
    row.querySelector(".reveal-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      revealed = !revealed;
      passEl.textContent = revealed ? item.password : "••••••••";
    });
    row.querySelector(".copy-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(item.password);
        toast("Password copied");
      } catch {
        toast("Couldn't copy -- clipboard unavailable");
      }
    });
    row.addEventListener("click", () => openItemModal(item));
    container.appendChild(row);
  }
}

// --- Password health ---------------------------------------------------------------
// Weak and reused passwords are worked out on this computer; breaches only
// when you ask (just the first 5 characters of each password's hash are sent).

function renderHealth() {
  const box = document.getElementById("vault-health");
  if (!items.length) {
    box.innerHTML = "";
    return;
  }
  const all = [...health.values()];
  const weak = all.filter((h) => h.strength <= 1).length;
  const reused = all.filter((h) => h.reused > 0).length;
  const breached = breaches ? Object.values(breaches).filter((n) => n > 0).length : null;
  const chips = [
    ["all", `All ${items.length}`],
    ["weak", `Weak ${weak}`, weak],
    ["reused", `Reused ${reused}`, reused],
    ...(breached !== null ? [["breached", `In breaches ${breached}`, breached]] : []),
  ];
  box.innerHTML = "";
  for (const [id, label, bad] of chips) {
    const b = document.createElement("button");
    b.className = `chip${healthFilter === id ? " on" : ""}${bad ? " bad" : ""}`;
    b.textContent = label;
    b.addEventListener("click", () => {
      healthFilter = id;
      renderHealth();
      renderList(items);
    });
    box.appendChild(b);
  }
  box.insertAdjacentHTML("beforeend", `<span class="spacer"></span>`);
  const check = document.createElement("button");
  check.className = "btn sm";
  check.textContent = breaches ? "Check breaches again" : "Check for breaches…";
  check.addEventListener("click", checkBreaches);
  box.appendChild(check);
}

async function checkBreaches() {
  if (!breaches && !(await confirmDialog("Check your passwords against known data breaches? Kessel sends only the first 5 characters of each password's SHA-1 hash to Have I Been Pwned -- never the password, and never enough to tell which one it is.", "Check"))) return;
  toast("Checking…");
  try {
    breaches = await invoke("vault_breach_check");
    const bad = Object.values(breaches).filter((n) => n > 0).length;
    toast(bad ? `${bad} password${bad === 1 ? " was" : "s were"} found in data breaches` : "None of your passwords was found in a data breach");
    if (bad) healthFilter = "breached";
    renderHealth();
    renderList(items);
  } catch (e) {
    toast(String(e));
  }
}

// --- Add / edit item modal ----------------------------------------------

function openItemModal(item) {
  editingId = item ? item.id : null;
  document.getElementById("item-modal-title").textContent = item ? "Edit password" : "Add password";
  document.getElementById("item-delete-btn").style.display = item ? "inline-flex" : "none";
  const body = document.getElementById("item-modal-body");
  body.innerHTML = `
    <label class="label">Site</label>
    <input class="field" id="im-site" placeholder="example.com" style="margin-bottom:12px" />
    <label class="label">Username</label>
    <input class="field" id="im-user" placeholder="you@example.com" style="margin-bottom:12px" />
    <label class="label">Password</label>
    <div class="pw-field-wrap" style="margin-bottom:12px">
      <input class="field" id="im-pass" type="password" />
      <span class="pw-field-actions">
        <button class="btn ghost icon-only sm" id="im-pass-eye" type="button">${icon("eye", 14)}</button>
        <button class="btn ghost icon-only sm" id="im-pass-gen" type="button" title="Generate">${icon("bolt", 14)}</button>
      </span>
    </div>
    <label class="label">Notes</label>
    <textarea class="field" id="im-notes" rows="2" style="resize:vertical"></textarea>
  `;
  document.getElementById("im-site").value = item?.site || "";
  document.getElementById("im-user").value = item?.username || "";
  document.getElementById("im-pass").value = item?.password || "";
  document.getElementById("im-notes").value = item?.notes || "";

  const passInput = document.getElementById("im-pass");
  document.getElementById("im-pass-eye").addEventListener("click", () => {
    passInput.type = passInput.type === "password" ? "text" : "password";
  });
  document.getElementById("im-pass-gen").addEventListener("click", async () => {
    passInput.type = "text";
    passInput.value = await invoke("vault_generate_password", { length: 20, useUpper: true, useNumbers: true, useSymbols: true });
  });

  document.getElementById("item-modal-backdrop").classList.add("open");
}

function closeItemModal() {
  document.getElementById("item-modal-backdrop").classList.remove("open");
  editingId = null;
}

async function saveItem() {
  const site = document.getElementById("im-site").value.trim();
  const username = document.getElementById("im-user").value.trim();
  const password = document.getElementById("im-pass").value;
  const notes = document.getElementById("im-notes").value.trim();
  if (!site || !password) {
    toast("Site and password are required");
    return;
  }
  try {
    if (editingId) {
      await invoke("vault_update_item", { id: editingId, site, username, password, notes });
      toast("Saved");
    } else {
      await invoke("vault_add_item", { site, username, password, notes });
      toast("Password added");
    }
    closeItemModal();
    await refreshItems();
  } catch (e) {
    if (String(e).includes("locked")) await showLockScreen("Vault locked");
    else toast(String(e));
  }
}

async function deleteItem() {
  if (!editingId) return;
  if (!(await confirmDialog("Delete this saved password?", "Delete"))) return;
  await invoke("vault_delete_item", { id: editingId });
  closeItemModal();
  await refreshItems();
  toast("Deleted");
}

// --- Vault settings modal (2FA + change master password) ------------------

async function openVaultSettings() {
  const status = await invoke("vault_status");
  const body = document.getElementById("vault-settings-body");
  body.innerHTML = `
    <div class="setting-card" style="margin-bottom:14px">
      <div class="setting-row">
        <div class="info"><div class="title">Two-factor authentication</div><div class="desc">${status.twofa_enabled ? "Enabled -- a code is required on unlock." : "Off -- add a second step on unlock."}</div></div>
        <div class="control"><button class="btn sm ${status.twofa_enabled ? "danger" : "primary"}" id="twofa-toggle-btn">${status.twofa_enabled ? "Disable" : "Enable"}</button></div>
      </div>
    </div>
    <div id="twofa-setup-area"></div>
    <div class="setting-card" style="margin-bottom:14px">
      <div class="setting-row">
        <div class="info"><div class="title">Offer to save passwords</div><div class="desc">After you sign in on a site, Kessel asks whether to save the password (never in private windows)</div></div>
        <div class="control"><button class="switch ${currentSettings()?.features?.password_offer !== false ? "on" : ""}" id="offer-toggle" role="switch"></button></div>
      </div>
      <div id="never-list" style="padding:0 18px 12px"></div>
    </div>
    <div class="setting-card" style="margin-bottom:14px">
      <div class="setting-row"><div class="info"><div class="title">Export passwords</div><div class="desc">Every saved password in a CSV file (the columns Chrome, Edge and Firefox import). Anyone with the file can read them.</div></div></div>
      <div style="padding:0 18px 16px;display:flex;gap:8px">
        <input class="field" id="export-master" type="password" placeholder="Master password" />
        <button class="btn" id="export-btn">Export…</button>
      </div>
    </div>
    <div class="setting-card">
      <div class="setting-row"><div class="info"><div class="title">Change master password</div></div></div>
      <div style="padding:0 18px 16px">
        <input class="field" id="cmp-current" type="password" placeholder="Current password" style="margin-bottom:8px" />
        <input class="field" id="cmp-new" type="password" placeholder="New password" style="margin-bottom:8px" />
        <button class="btn block" id="cmp-btn">Update password</button>
      </div>
    </div>
  `;
  const features = () => currentSettings()?.features || {};
  const offer = document.getElementById("offer-toggle");
  offer.addEventListener("click", async () => {
    const on = !offer.classList.contains("on");
    await saveSettings({ features: { ...features(), password_offer: on } });
    offer.classList.toggle("on", on);
  });
  const renderNever = () => {
    const list = features().password_never || [];
    const box = document.getElementById("never-list");
    box.innerHTML = list.length ? `<div class="desc" style="margin-bottom:6px">Never saved for:</div>` : "";
    for (const site of list) {
      const row = el(`<div style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 0"><span style="flex:1"></span><button class="btn ghost sm">Remove</button></div>`);
      row.querySelector("span").textContent = site;
      row.querySelector("button").addEventListener("click", async () => {
        await saveSettings({ features: { ...features(), password_never: (features().password_never || []).filter((s) => s !== site) } });
        renderNever();
      });
      box.appendChild(row);
    }
  };
  renderNever();
  document.getElementById("export-btn").addEventListener("click", async () => {
    const master = document.getElementById("export-master").value;
    if (!master) return document.getElementById("export-master").focus();
    try {
      const path = await invoke("vault_export_csv", { masterPassword: master });
      document.getElementById("export-master").value = "";
      if (path) toast(`Saved to ${path} -- keep it somewhere safe, or delete it when you're done`);
    } catch (e) {
      toast(String(e));
    }
  });
  document.getElementById("twofa-toggle-btn").addEventListener("click", () => {
    if (status.twofa_enabled) beginDisable2fa();
    else beginEnable2fa();
  });
  document.getElementById("cmp-btn").addEventListener("click", async () => {
    const current = document.getElementById("cmp-current").value;
    const next = document.getElementById("cmp-new").value;
    if (next.length < 8) return toast("New password must be at least 8 characters");
    try {
      await invoke("vault_change_master_password", { currentPassword: current, newPassword: next });
      toast("Master password updated");
      document.getElementById("vault-settings-backdrop").classList.remove("open");
    } catch (e) {
      toast(String(e));
    }
  });
  document.getElementById("vault-settings-backdrop").classList.add("open");
}

async function beginEnable2fa() {
  const setup = await invoke("vault_begin_2fa");
  const area = document.getElementById("twofa-setup-area");
  area.innerHTML = `
    <div class="setting-card" style="margin-bottom:14px">
      <div style="padding:16px 18px">
        <div class="desc" style="margin-bottom:8px">Add this secret to your authenticator app (Google Authenticator, 1Password, Authy, ...):</div>
        <div class="qr-secret">${setup.secret_base32}</div>
        <input class="field" id="twofa-confirm-code" placeholder="Enter the 6-digit code to confirm" style="margin-bottom:8px" />
        <button class="btn primary block" id="twofa-confirm-btn">Confirm &amp; enable</button>
      </div>
    </div>`;
  document.getElementById("twofa-confirm-btn").addEventListener("click", async () => {
    const code = document.getElementById("twofa-confirm-code").value.trim();
    try {
      await invoke("vault_confirm_2fa", { code });
      toast("Two-factor authentication enabled");
      openVaultSettings();
    } catch (e) {
      toast(String(e));
    }
  });
}

function beginDisable2fa() {
  const area = document.getElementById("twofa-setup-area");
  area.innerHTML = `
    <div class="setting-card" style="margin-bottom:14px">
      <div style="padding:16px 18px">
        <div class="desc" style="margin-bottom:8px">Enter your current 6-digit code to disable two-factor authentication.</div>
        <input class="field" id="twofa-disable-code" placeholder="000000" style="margin-bottom:8px" />
        <button class="btn danger block" id="twofa-disable-btn">Disable 2FA</button>
      </div>
    </div>`;
  document.getElementById("twofa-disable-btn").addEventListener("click", async () => {
    const code = document.getElementById("twofa-disable-code").value.trim();
    try {
      await invoke("vault_disable_2fa", { code });
      toast("Two-factor authentication disabled");
      openVaultSettings();
    } catch (e) {
      toast(String(e));
    }
  });
}

// --- Idle-based client-side auto-lock ------------------------------------

function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

function wireIdleAutoLock() {
  const onActivity = throttle(markActivity, 1000);
  ["mousemove", "keydown", "click", "scroll"].forEach((evt) =>
    document.addEventListener(evt, onActivity, { passive: true })
  );
  setInterval(async () => {
    if (document.getElementById("vault-shell").style.display === "none") return;
    const minutes = currentSettings()?.vault_lock_minutes ?? 15;
    if (minutes <= 0) return;
    const idleMs = Date.now() - lastActivity;
    if (idleMs > minutes * 60 * 1000) {
      await invoke("vault_lock");
      await showLockScreen("Vault locked after inactivity");
    }
  }, 15000);
}

// --- Wire up -------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  document.getElementById("lock-icon-wrap").innerHTML = icon("lock", 24);
  document.getElementById("vault-settings-btn").innerHTML = icon("settings", 16);
  document.getElementById("vault-lock-btn").innerHTML = icon("unlock", 16);
  document.getElementById("vault-fab").innerHTML = icon("plus", 22);

  const status = await invoke("vault_status");
  if (status.unlocked) await enterDashboard();
  else if (status.initialized) renderUnlockForm(false);
  else renderSetupForm();

  document.getElementById("vault-search").addEventListener("input", debounce(() => renderList(items), 120));
  document.getElementById("vault-fab").addEventListener("click", () => openItemModal(null));
  document.getElementById("item-cancel-btn").addEventListener("click", closeItemModal);
  document.getElementById("item-save-btn").addEventListener("click", saveItem);
  document.getElementById("item-delete-btn").addEventListener("click", deleteItem);
  document.getElementById("item-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "item-modal-backdrop") closeItemModal();
  });

  document.getElementById("vault-lock-btn").addEventListener("click", async () => {
    await invoke("vault_lock");
    await showLockScreen("Vault locked");
  });
  document.getElementById("vault-settings-btn").addEventListener("click", openVaultSettings);
  document.getElementById("vault-settings-close").addEventListener("click", () =>
    document.getElementById("vault-settings-backdrop").classList.remove("open")
  );
  document.getElementById("vault-settings-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "vault-settings-backdrop") document.getElementById("vault-settings-backdrop").classList.remove("open");
  });

  wireIdleAutoLock();
});
