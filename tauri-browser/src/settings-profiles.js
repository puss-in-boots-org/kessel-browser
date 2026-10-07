// Settings -> Profiles (profiles.rs): every profile -- its own history,
// bookmarks, passwords, settings, cookies, extensions, search engines and
// downloads folder -- opened in a Kessel of its own, made new, or given a
// desktop shortcut that opens straight into it.

import { icon } from "./shared/icons.js";
import { toast, formatRelativeTime } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;

export async function profilesPanel({ el, settingRow }) {
  const panel = el(`<div class="panel" id="panel-profiles">
    <h2>Profiles</h2>
    <p class="sub">Each profile is a Kessel of its own: its own history, bookmarks, passwords, settings, cookies, extensions, search engines and downloads folder. Work and home, or one for each person at this computer. Ctrl+Shift+M brings you here.</p>
    <div class="setting-card"><div class="list-panel" id="profile-list" style="max-height:none"></div></div>
    <div class="setting-card">
      ${settingRow({ title: "New profile", desc: "It opens in a Kessel of its own, starting fresh", controlHtml: `<input class="field" id="profile-name" placeholder="Name, like Work" maxlength="40" spellcheck="false" style="width:180px" /><button class="btn sm primary" id="profile-create">${icon("userPlus", 13)}<span>Create</span></button>` })}
    </div>
  </div>`);
  const list = panel.querySelector("#profile-list");

  const render = async () => {
    const profiles = await invoke("list_profiles").catch((err) => (toast(String(err)), []));
    list.innerHTML = "";
    for (const p of profiles) {
      const row = el(`<div class="list-row" style="gap:10px">
        <span style="display:flex;color:var(--text-faint)">${icon("user", 16)}</span>
        <span class="lr-title"></span>
        <span class="lr-sub"></span>
        <span style="flex:1"></span>
        <button class="btn sm ghost" data-shortcut title="A shortcut on your desktop that opens this profile">${icon("link", 13)}<span>Desktop shortcut</span></button>
        <button class="btn sm" data-open></button>
      </div>`);
      row.dataset.profile = p.label;
      row.querySelector(".lr-title").textContent = p.label;
      row.querySelector(".lr-sub").textContent = p.current ? "This one" : p.running ? "Open in another Kessel" : p.last_used ? `Used ${formatRelativeTime(p.last_used)}` : "Not used yet";
      const open = row.querySelector("[data-open]");
      open.textContent = p.current ? "New window" : "Open";
      open.disabled = p.running;
      open.addEventListener("click", async () => {
        try {
          const r = await invoke("open_profile", { name: p.name });
          if (r.launched) toast(`Opening “${p.label}”…`);
        } catch (err) {
          toast(String(err));
        }
      });
      row.querySelector("[data-shortcut]").addEventListener("click", async () => {
        try {
          const where = await invoke("profile_shortcut", { name: p.name, dir: null });
          toast(`On your desktop: ${where.split("\\").pop()}`);
        } catch (err) {
          toast(String(err));
        }
      });
      list.appendChild(row);
    }
  };

  const create = async () => {
    const input = panel.querySelector("#profile-name");
    const name = input.value.trim();
    if (!name) return input.focus();
    try {
      const r = await invoke("create_profile", { name });
      input.value = "";
      if (r.launched !== false) toast(`Made “${name}” -- it opens in a Kessel of its own`);
      render();
    } catch (err) {
      toast(String(err));
    }
  };
  panel.querySelector("#profile-create").addEventListener("click", create);
  panel.querySelector("#profile-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") create();
  });
  // Another Kessel opened or closed one meanwhile.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && render());
  await render();
  return panel;
}
