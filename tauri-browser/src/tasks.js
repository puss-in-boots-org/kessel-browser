// kessel://tasks: the task manager (see tasks.html, tasks.rs). Every couple
// of seconds it asks for the processes again; rows are kept by process id
// and updated in place, so a button stays put under the mouse.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { toast, escapeHtml, confirmDialog } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const KINDS = { kessel: "Kessel", browser: "Engine", gpu: "Graphics", utility: "Helper", renderer: "Pages", sandbox: "Helper", plugin: "Plug-in" };

let sort = { key: null, down: true };
let last = { processes: [], asleep: [] };

function bytes(n) {
  if (n == null) return "–";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const percent = (cpu) => (cpu == null ? "–" : `${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}%`);

function tabLine(tab) {
  const tags = [tab.active ? "showing" : "", tab.private ? "private" : ""].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join("");
  return `<div class="tab">${icon("tabs", 11)}<a data-window="${escapeHtml(tab.window)}" data-tab="${tab.id}" title="Go to this tab">${escapeHtml(tab.title || tab.url)}</a>${tags}<button class="btn sm ghost" data-sleep-window="${escapeHtml(tab.window)}" data-sleep="${tab.id}" title="Put this tab to sleep"${tab.active ? " hidden" : ""}>Sleep</button></div>`;
}

function nameHtml(p) {
  const account = p.account ? ` · ${escapeHtml(p.account)}` : "";
  const tabs = p.tabs.length ? `<div class="tabs">${p.tabs.map(tabLine).join("")}</div>` : "";
  return `<div class="title">${escapeHtml(p.title)}</div><small>${escapeHtml(p.detail)}${account}</small>${tabs}`;
}

function sorted(list) {
  if (!sort.key) return list;
  const value = (p) => (sort.key === "title" ? p.title.toLowerCase() : p[sort.key] ?? -1);
  return [...list].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    const order = x < y ? -1 : x > y ? 1 : 0;
    return sort.down ? -order : order;
  });
}

function render() {
  const body = $("rows");
  const rows = new Map([...body.querySelectorAll("tr")].map((tr) => [tr.dataset.pid, tr]));
  const seen = new Set();
  for (const p of sorted(last.processes)) {
    const pid = String(p.pid);
    seen.add(pid);
    let tr = rows.get(pid);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.pid = pid;
      tr.innerHTML = `<td class="name"></td><td><span class="kind"></span></td><td class="num memory"></td><td class="num cpu"></td><td class="num">${pid}</td><td class="actions"></td>`;
      if (p.killable) tr.querySelector(".actions").innerHTML = `<button class="btn sm" data-end="${pid}">End process</button>`;
    }
    const name = nameHtml(p);
    if (tr.dataset.name !== name) {
      tr.querySelector(".name").innerHTML = name;
      tr.dataset.name = name;
    }
    tr.dataset.kind = p.kind;
    tr.querySelector(".kind").textContent = KINDS[p.kind] || p.kind;
    tr.querySelector(".memory").textContent = bytes(p.memory);
    tr.querySelector(".cpu").textContent = percent(p.cpu);
    body.appendChild(tr); // (in order)
  }
  for (const [pid, tr] of rows) if (!seen.has(pid)) tr.remove();

  const memory = last.processes.reduce((sum, p) => sum + (p.memory || 0), 0);
  const cpu = last.processes.reduce((sum, p) => sum + (p.cpu || 0), 0);
  const tabs = last.processes.reduce((sum, p) => sum + p.tabs.length, 0);
  $("totals").innerHTML = `<span>Memory <b>${bytes(memory)}</b></span><span>CPU <b>${percent(cpu)}</b></span><span>Processes <b>${last.processes.length}</b></span><span>Tabs awake <b>${tabs}</b></span><span>Asleep <b>${last.asleep.length}</b></span>`;

  const asleep = $("asleep");
  const html = last.asleep.length
    ? `<table>${last.asleep
        .map((t) => `<tr data-asleep="${t.id}"><td class="name"><div class="title">${escapeHtml(t.title || t.url)}</div><small>${escapeHtml(t.url)}</small></td><td class="actions"><button class="btn sm" data-wake-window="${escapeHtml(t.window)}" data-wake="${t.id}">Wake</button> <button class="btn sm ghost" data-close-window="${escapeHtml(t.window)}" data-close="${t.id}">Close</button></td></tr>`)
        .join("")}</table>`
    : `<div class="empty">No tab is asleep.</div>`;
  if (asleep.dataset.html !== html) {
    asleep.innerHTML = html;
    asleep.dataset.html = html;
  }
}

async function refresh() {
  try {
    last = await invoke("task_manager");
    render();
  } catch (err) {
    $("totals").textContent = `Couldn't list the processes: ${err}`;
  }
}

async function endProcess(pid) {
  const p = last.processes.find((x) => String(x.pid) === pid);
  if (!p) return;
  const pages = p.tabs.length;
  const what = pages ? `The ${pages === 1 ? "page" : `${pages} pages`} in it will close (you can reload ${pages === 1 ? "it" : "them"}).` : "The engine starts another if it needs one.";
  if (!(await confirmDialog(`End “${p.title}”? ${what}`, "End process"))) return;
  try {
    await invoke("end_process", { pid: Number(pid) });
    toast("Ended");
  } catch (err) {
    toast(String(err));
  }
  setTimeout(refresh, 400);
}

const act = (window, id, action) => invoke("task_action", { window, id: Number(id), action }).catch((err) => toast(String(err)));

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  $("logo").outerHTML = icon("activity", 20);
  $("engine-btn").innerHTML = `${icon("gpu", 13)} The engine's own`;
  $("engine-btn").title = "WebView2's task manager, in a window of its own";
  $("engine-btn").addEventListener("click", () => invoke("run_command", { id: "engine-task-manager" }).catch((err) => toast(String(err))));
  $("diagnostics-btn").innerHTML = `${icon("help", 13)} Diagnostics`;
  $("diagnostics-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://diagnostics" }).catch(() => {}));
  for (const th of document.querySelectorAll("th.sortable")) {
    th.addEventListener("click", () => {
      sort = { key: th.dataset.sort, down: sort.key === th.dataset.sort ? !sort.down : th.dataset.sort !== "title" };
      render();
    });
  }
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-end],[data-tab],[data-sleep],[data-wake],[data-close]");
    if (!el) return;
    if (el.dataset.end) return endProcess(el.dataset.end);
    if (el.dataset.tab) return act(el.dataset.window, el.dataset.tab, "show");
    if (el.dataset.sleep) return act(el.dataset.sleepWindow, el.dataset.sleep, "sleep").then(() => setTimeout(refresh, 500));
    if (el.dataset.wake) return act(el.dataset.wakeWindow, el.dataset.wake, "show").then(() => setTimeout(refresh, 800));
    if (el.dataset.close) return act(el.dataset.closeWindow, el.dataset.close, "close").then(() => setTimeout(refresh, 500));
  });
  await refresh();
  setInterval(() => !document.hidden && refresh(), 2000);
});
