// Accounts, as the pages show them (see src-tauri/src/accounts.rs). An
// account is { id, name, color }; Main -- WebView2's normal sign-ins -- is
// null everywhere.
import { icon } from "./icons.js";
import { escapeHtml } from "./api.js";
export { escapeHtml };

export const MAIN_NAME = "Main";

export function accountName(account) {
  return account ? account.name : MAIN_NAME;
}

// A round avatar: Main's is a person glyph, other accounts show their
// initial on their colour.
export function avatarHtml(account, size = 22) {
  if (!account) {
    return `<span class="acct-avatar main" style="--size:${size}px">${icon("user", Math.round(size * 0.68))}</span>`;
  }
  const letter = escapeHtml([...account.name.trim()][0]?.toUpperCase() || "?");
  return `<span class="acct-avatar" style="--size:${size}px;--acct:${escapeHtml(account.color)}">${letter}</span>`;
}
