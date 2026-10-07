// The lock page (lock.html), over every window while Kessel is locked:
// your PIN or password -- or Windows Hello, if you turned it on -- and the
// lock goes (browser_lock.rs closes this page itself).

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

function fail(message) {
  $("error").textContent = String(message);
  const form = $("form");
  form.classList.remove("shake");
  void form.offsetWidth;
  form.classList.add("shake");
  $("secret").value = "";
  $("secret").focus();
}

// Wired at once (a module runs once the page is parsed): Enter pressed
// early never submits the form the old way.
const input = $("secret");
$("symbol").innerHTML = icon("lock", 30);
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!input.value) return;
  $("unlock").disabled = true;
  try {
    await invoke("unlock_browser", { secret: input.value });
    $("error").textContent = "";
  } catch (err) {
    fail(err);
  } finally {
    $("unlock").disabled = false;
  }
});
input.focus();
window.addEventListener("focus", () => input.focus());

(async () => {
  await initTheme().catch(() => {});
  const status = await invoke("lock_status").catch(() => ({}));
  const pin = status.kind === "pin";
  input.placeholder = pin ? "PIN" : "Password";
  if (pin) input.inputMode = "numeric";
  $("what").textContent = pin ? "Enter your PIN to carry on." : "Enter your password to carry on.";
  if (status.wait > 0) $("error").textContent = `Too many wrong tries: wait ${status.wait} seconds`;
  if (status.hello && (await invoke("hello_available").catch(() => false))) {
    const hello = $("hello");
    hello.hidden = false;
    hello.innerHTML = `${icon("user", 14)}<span>Use Windows Hello</span>`;
    hello.addEventListener("click", () => invoke("unlock_with_hello").catch(fail));
  }
  document.body.dataset.ready = "1";
})();
