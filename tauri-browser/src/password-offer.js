// The offer to save (or update) the login you just used (password-offer.html,
// from passwords.rs). Locked passwords: the master password unlocks them
// here. No password manager yet: a way to set one up.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { closeOwnPopup } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const info = window.__KESSEL_POPUP__ || {};
const $ = (id) => document.getElementById(id);

async function answer(kind) {
  $("error").textContent = "";
  if (kind === "save" && info.locked) {
    const master = $("master").value;
    if (!master) return $("master").focus();
    try {
      await invoke("vault_unlock", { masterPassword: master, totpCode: null });
    } catch (err) {
      $("error").textContent = /2FA/i.test(String(err)) ? "Your passwords have two-step sign-in: unlock them on the Passwords page first." : "That isn't your master password.";
      return;
    }
  }
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try {
    await invoke("password_offer_answer", { n: info.n, answer: kind, username: $("user").value });
  } catch (err) {
    $("error").textContent = String(err);
    for (const b of document.querySelectorAll("button")) b.disabled = false;
    return;
  }
  closeOwnPopup();
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  $("glyph").innerHTML = icon("key", 16);
  $("title").textContent = `${info.update ? "Update the saved password" : "Save your password"} for ${info.site || "this site"}?`;
  $("user").value = info.username || "";
  $("save").textContent = info.update ? "Update" : "Save";
  if (!info.initialized) {
    $("note").hidden = false;
    $("note").textContent = "Kessel keeps passwords in a vault locked with a master password. Set it up first, then sign in again.";
    $("save").textContent = "Set up";
    $("save").onclick = async () => {
      await invoke("open_singleton_tab", { route: "kessel://passwords" }).catch(() => {});
      await invoke("password_offer_answer", { n: info.n, answer: "later" }).catch(() => {});
      closeOwnPopup();
    };
  } else {
    $("unlock-row").hidden = !info.locked;
    $("save").addEventListener("click", () => answer("save"));
  }
  $("later").addEventListener("click", () => answer("later"));
  $("never").addEventListener("click", () => answer("never"));
  (info.locked && info.initialized ? $("master") : $("save")).focus();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") answer("later");
    if (e.key === "Enter" && document.activeElement?.tagName === "INPUT") $("save").click();
  });
});
