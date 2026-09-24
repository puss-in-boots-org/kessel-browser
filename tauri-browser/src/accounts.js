// The account menu (accounts.html), opened from the avatar at the right end
// of the address bar. Clicking an account opens a new tab signed in as it;
// the window button opens a pop-out window instead. Accounts themselves
// live in Rust (src-tauri/src/accounts.rs).
import { icon } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";
import { avatarHtml, accountName } from "./shared/accounts.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let data = { accounts: [], current: null };
// At most one inline form open: { kind: "add" } | { kind: "edit", id } |
// { kind: "delete", id }.
let form = null;
let formError = "";

const close = () => invoke("close_accounts_popup").catch(() => {});

async function refresh() {
  data = (await invoke("get_accounts").catch(() => null)) || { accounts: [], current: null };
  render();
}

function openAs(account, window) {
  invoke("open_account_tab", { account: account?.id ?? null, window }).catch((err) => {
    formError = String(err);
    render();
  });
}

function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function iconButton(name, title, onClick) {
  const b = h("button", "icon-btn");
  b.innerHTML = icon(name, 15);
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function accountRow(account) {
  const row = h("div", "acct");
  if (account) row.style.setProperty("--acct", account.color);
  row.title = `New tab signed in as ${accountName(account)}`;
  row.insertAdjacentHTML("afterbegin", avatarHtml(account, 30));

  const text = h("div", "text");
  text.append(h("div", "name", accountName(account)));
  text.append(h("div", "hint", account ? "Its own sign-ins" : "Your usual sign-ins"));
  row.append(text);

  if ((account?.id ?? null) === (data.current ?? null)) row.append(h("span", "here", "This tab"));
  row.append(iconButton("popOut", `New window signed in as ${accountName(account)}`, () => openAs(account, true)));
  if (account) {
    row.append(
      iconButton("edit", "Rename or delete", () => {
        form = { kind: "edit", id: account.id };
        formError = "";
        render();
      })
    );
  }
  row.addEventListener("click", () => openAs(account, false));
  return row;
}

// Name field + buttons, for adding and renaming.
function nameForm({ value, placeholder, submitLabel, onSubmit, extra }) {
  const box = h("div", "form");
  const input = h("input");
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = 40;
  box.append(input);
  if (formError) box.append(h("div", "err", formError));
  const buttons = h("div", "row");
  if (extra) buttons.append(extra);
  const cancel = h("button", "", "Cancel");
  const ok = h("button", "primary", submitLabel);
  buttons.append(cancel, ok);
  box.append(buttons);

  const submit = async () => {
    try {
      await onSubmit(input.value);
    } catch (err) {
      formError = String(err);
      render();
    }
  };
  cancel.addEventListener("click", () => {
    form = null;
    formError = "";
    render();
  });
  ok.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return box;
}

function editForm(account) {
  const del = h("button", "link", "Delete…");
  del.addEventListener("click", () => {
    form = { kind: "delete", id: account.id };
    formError = "";
    render();
  });
  return nameForm({
    value: account.name,
    placeholder: "Account name",
    submitLabel: "Save",
    extra: del,
    onSubmit: async (name) => {
      await invoke("rename_account", { id: account.id, name });
      form = null;
      formError = "";
      await refresh();
    },
  });
}

function deleteForm(account) {
  const box = h("div", "form");
  box.append(
    h(
      "div",
      "msg",
      `Delete “${account.name}”? Its tabs close, and everything sites stored for it (sign-ins, cookies, cache) is erased.`
    )
  );
  if (formError) box.append(h("div", "err", formError));
  const buttons = h("div", "row");
  const cancel = h("button", "", "Cancel");
  const del = h("button", "danger", "Delete");
  cancel.addEventListener("click", () => {
    form = { kind: "edit", id: account.id };
    render();
  });
  del.addEventListener("click", async () => {
    try {
      await invoke("delete_account", { id: account.id });
      form = null;
      await refresh();
    } catch (err) {
      formError = String(err);
      render();
    }
  });
  buttons.append(cancel, del);
  box.append(buttons);
  return box;
}

function render() {
  const list = document.getElementById("list");
  list.replaceChildren();
  for (const account of [null, ...data.accounts]) {
    const target = form && account && form.id === account.id ? form.kind : null;
    if (target === "edit") list.append(editForm(account));
    else if (target === "delete") list.append(deleteForm(account));
    else list.append(accountRow(account));
  }

  const footer = document.getElementById("footer");
  footer.replaceChildren();
  if (form?.kind === "add") {
    footer.append(
      nameForm({
        value: "",
        placeholder: "Name, e.g. Test or Work",
        submitLabel: "Add",
        onSubmit: async (name) => {
          const account = await invoke("create_account", { name });
          form = null;
          formError = "";
          // Straight into it: a fresh tab, not signed in to anything yet.
          openAs(account, false);
        },
      })
    );
  } else {
    const add = h("div", "add");
    add.insertAdjacentHTML("afterbegin", `<span class="plus">${icon("plus", 14)}</span>`);
    add.append(h("span", "", "Add account"));
    add.addEventListener("click", () => {
      form = { kind: "add" };
      formError = "";
      render();
    });
    footer.append(add);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  watchCustomWallpaper(currentSettings);
  await refresh();
  await listen("accounts-changed", refresh);

  // A popover: clicking anywhere else (which moves focus out of this
  // webview) or pressing Escape closes it -- Escape first backs out of an
  // open form.
  window.addEventListener("blur", close);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (form) {
      form = null;
      formError = "";
      render();
    } else {
      close();
    }
  });
});
