// Settings -> Appearance -> Toolbar buttons (main.js applyToolbarSettings):
// which of the toolbar's buttons show, and in what order -- beside the
// address bar, and in it. Back and the menu always stay; Home has its own
// switch above.

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";

const GROUPS = [
  ["nav", "Beside the address bar", [["back-btn", "Back", "back"], ["forward-btn", "Forward", "forward"], ["reload-btn", "Reload", "reload"], ["home-btn", "Home", "home"]]],
  ["address", "In the address bar", [["engine-btn", "Search engine", "search"], ["shields-btn", "Shields", "shield"], ["share-btn", "Share", "share"], ["ext-btn", "Extensions", "puzzle"], ["star-btn", "Bookmark", "star"], ["account-btn", "Accounts", "user"]]],
];
// (Back always shows; Home has its own switch.)
const FIXED = ["back-btn", "home-btn"];

const toolbar = () => currentSettings()?.features?.toolbar || {};

function save(patch) {
  const features = { ...(currentSettings()?.features || {}) };
  features.toolbar = { ...toolbar(), ...patch };
  return saveSettings({ features });
}

function orderOf(group, ids) {
  const saved = (toolbar().order?.[group] || []).filter((id) => ids.includes(id));
  return [...saved, ...ids.filter((id) => !saved.includes(id))];
}

export function toolbarCard({ el, switchHtml }) {
  const card = el(`<div class="setting-card" id="toolbar-card">
    <div class="k-card-title"><span class="k-label">Toolbar buttons</span></div>
    <div id="toolbar-groups"></div>
  </div>`);
  const holder = card.querySelector("#toolbar-groups");

  const render = () => {
    holder.innerHTML = "";
    const hidden = new Set(toolbar().hidden || []);
    for (const [group, title, buttons] of GROUPS) {
      const ids = buttons.map(([id]) => id);
      const order = orderOf(group, ids);
      holder.appendChild(el(`<div style="padding:10px 18px 4px;font-size:11.5px;color:var(--text-faint)">${title}</div>`));
      order.forEach((id, i) => {
        const [, label, iconName] = buttons.find(([b]) => b === id);
        const row = el(`<div class="list-row" style="gap:10px">
          <span style="display:flex;color:var(--text-faint)">${icon(iconName, 15)}</span>
          <span class="lr-title"></span><span style="flex:1"></span>
          <button class="btn ghost icon-only sm" data-up title="Move left">${icon("chevronLeft", 13)}</button>
          <button class="btn ghost icon-only sm" data-down title="Move right">${icon("chevronRight", 13)}</button>
          ${FIXED.includes(id) ? `<span style="width:40px"></span>` : switchHtml(`tb-${id}`, !hidden.has(id))}
        </div>`);
        row.dataset.button = id;
        row.querySelector(".lr-title").textContent = label;
        const move = async (by) => {
          const next = [...order];
          next.splice(i, 1);
          next.splice(i + by, 0, id);
          await save({ order: { ...(toolbar().order || {}), [group]: next } });
          render();
        };
        const up = row.querySelector("[data-up]");
        const down = row.querySelector("[data-down]");
        up.disabled = i === 0;
        down.disabled = i === order.length - 1;
        up.addEventListener("click", () => move(-1));
        down.addEventListener("click", () => move(1));
        const sw = row.querySelector(`#tb-${id}`);
        sw?.addEventListener("click", async () => {
          const on = !sw.classList.contains("on");
          const now = new Set(toolbar().hidden || []);
          if (on) now.delete(id);
          else now.add(id);
          await save({ hidden: [...now] });
          render();
        });
        holder.appendChild(row);
      });
    }
  };
  render();
  return card;
}
