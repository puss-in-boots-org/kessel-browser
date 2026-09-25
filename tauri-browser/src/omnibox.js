// The address bar's suggestions. As you type: what you typed (to go to, or
// to search for), an instant answer (calculator, conversions, currency,
// definitions, the time...), Kessel's own commands, your open tabs,
// bookmarks and history, and your search engine's suggestions -- in a popup
// under the address bar (suggest.html). An address you've been to
// completes in place ("yout" -> "youtube.com", the added part selected).
//
// Keys: Up/Down move through the list, Enter opens (Alt+Enter in a new tab,
// Shift+Enter in a new window), Tab accepts the completion, Shift+Delete
// removes a history entry, Escape closes the list.

import { ENGINES, resolveInput, looksLikeUrl, keyLabel } from "./shared/api.js";
import { instantAnswer, parseCurrencyQuery, convertCurrency, parseDefineQuery, matchCommands } from "./shared/answers.js";

const { invoke } = window.__TAURI__.core;
const { emitTo } = window.__TAURI__.event;

const MAX_ITEMS = 10;
const ROW = 34;
const ANSWER_ROW = 52;
const PADDING = 12;

// An address as people read it: no scheme, no trailing slash on a bare
// site, %20 and friends decoded.
function shortUrl(url) {
  let text = url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/^([^/?#]+)\/$/, "$1");
  try {
    text = decodeURI(text);
  } catch {}
  return text;
}

function wordsOf(text) {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAll(words, ...fields) {
  const hay = fields.join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function setupOmnibox({ input, anchor, win, listen, getSettings, getBookmarks, getCommands, go, runCommand, copyText, toast, activeTabId }) {
  const popup = `suggest-popup-${win.number}`;
  let buckets = null;
  let items = [];
  let selected = 0;
  let typed = "";
  let open = false;
  let generation = 0;
  let hideTimer = null;
  let deleting = false;
  let allTabs = [];

  const settings = () => getSettings() || {};
  const engineKey = () => settings().search_engine || "google";
  const engine = () => ENGINES[engineKey()] || ENGINES.google;

  // --- The list ------------------------------------------------------------------

  function assemble() {
    const b = buckets;
    // A page shows up once (an open tab beats its bookmark beats its visit);
    // answers and commands aren't pages, whatever they link to.
    const seen = new Set();
    const keep = (item) => {
      if (item.kind === "answer" || item.kind === "command" || !item.url) return true;
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    };
    const list = [b.first, ...b.answers, ...b.commands, ...b.tabs, ...b.bookmarks, ...b.history, ...b.suggestions].filter(Boolean).filter(keep);
    items = list.slice(0, MAX_ITEMS);
    if (selected >= items.length) selected = 0;
  }

  function geometry() {
    const r = anchor.getBoundingClientRect();
    const rows = items.reduce((h, item) => h + (item.kind === "answer" ? ANSWER_ROW : ROW), 0);
    const room = window.innerHeight - r.bottom - 16;
    return { x: Math.round(r.left), y: Math.round(r.bottom + 6), width: Math.round(r.width), height: Math.max(ROW + PADDING, Math.min(rows + PADDING, room)) };
  }

  async function render() {
    assemble();
    if (!items.length || document.activeElement !== input || !typed.trim()) {
      hide();
      return;
    }
    const g = geometry();
    open = true;
    await invoke("suggest_popup", { show: true, ...g }).catch(() => {});
    send();
  }

  function send() {
    emitTo(popup, "suggest-items", { items, selected, typed }).catch(() => {});
  }

  function hide() {
    clearTimeout(hideTimer);
    if (!open) return;
    open = false;
    invoke("suggest_popup", { show: false, x: 0, y: 0, width: 0, height: 0 }).catch(() => {});
  }

  // --- Building it --------------------------------------------------------------------

  function firstItem(text) {
    const t = text.trim();
    const url = resolveInput(t, engineKey());
    const address = !t.startsWith("?") && (looksLikeUrl(t) || /^(kessel|file|view-source):/i.test(t));
    return address
      ? { kind: "go", title: shortUrl(t), detail: "Go to site", url, fill: t }
      : { kind: "search", title: t.replace(/^\?\s*/, ""), detail: `${engine().name} Search`, url, fill: t };
  }

  // Your other open tabs (in any window of the same kind -- private or not)
  // matching every word.
  function tabMatches(words) {
    return allTabs
      .filter((tab) => tab.id !== activeTabId() && !!tab.private === !!win.private && /^(https?|file):/.test(tab.url) && matchesAll(words, tab.title, tab.url))
      .slice(0, 2)
      .map((tab) => ({ kind: "tab", title: tab.title || shortUrl(tab.url), detail: shortUrl(tab.url), detailIsUrl: true, url: tab.url, tabId: tab.id }));
  }

  function answerItem(answer) {
    return { kind: "answer", answerKind: answer.kind, title: answer.title, detail: answer.detail, copy: answer.copy, swatch: answer.swatch || null };
  }

  function update(text) {
    typed = text;
    const g = ++generation;
    const t = text.trim();
    if (!t) {
      hide();
      return;
    }
    const words = wordsOf(t.replace(/^\?\s*/, ""));
    const s = settings();
    const answer = s.address_answers === false ? null : instantAnswer(t);
    buckets = {
      first: firstItem(t),
      answers: answer ? [answerItem(answer)] : [],
      commands: matchCommands(t, getCommands()).map((c) => ({ kind: "command", title: c.label, detail: "Kessel", command: c.id, keys: c.keys[0] ? keyLabel(c.keys[0]) : "" })),
      tabs: tabMatches(words),
      bookmarks: getBookmarks()
        .filter((b) => matchesAll(words, b.title, b.url))
        .slice(0, 2)
        .map((b) => ({ kind: "bookmark", title: b.title || shortUrl(b.url), detail: shortUrl(b.url), detailIsUrl: true, url: b.url, fill: b.url })),
      history: [],
      suggestions: [],
    };
    selected = 0;
    render();

    // In-place completion, then the slower sources.
    complete(g, text);
    invoke("all_tabs")
      .then((list) => {
        allTabs = list;
        if (g !== generation) return;
        buckets.tabs = tabMatches(words);
        render();
      })
      .catch(() => {});
    invoke("history_suggest", { text: t, limit: 8 })
      .then((list) => {
        if (g !== generation) return;
        buckets.history = list.slice(0, 6).map((h) => ({ kind: "history", title: h.title || shortUrl(h.url), detail: shortUrl(h.url), detailIsUrl: true, url: h.url, fill: h.url, removable: true }));
        render();
      })
      .catch(() => {});
    if (!win.private && s.search_suggestions !== false && !t.startsWith("kessel:") && t.length < 120) {
      const query = t.replace(/^\?\s*/, "");
      invoke("search_suggest", { engine: engineKey(), text: query })
        .then((list) => {
          if (g !== generation) return;
          // Google also "suggests" calculator results ("= 8"): the answer
          // row has those already.
          buckets.suggestions = list
            .filter((q) => !/^=/.test(q.trim()))
            .slice(0, 4)
            .map((q) => ({ kind: "suggestion", title: q, url: engine().url(q), fill: q }));
          render();
        })
        .catch(() => {});
    }
    if (s.address_answers !== false && !answer) {
      const money = parseCurrencyQuery(t);
      if (money) {
        invoke("currency_rates")
          .then((rates) => {
            const converted = rates && convertCurrency(money, rates);
            if (g !== generation || !converted) return;
            buckets.answers = [{ kind: "answer", answerKind: "currency", title: converted.value.toLocaleString("en-US", { maximumFractionDigits: 2 }) + ` ${money.to}`, detail: `${converted.text} · ECB rate of ${rates.date}`, copy: converted.value.toFixed(2) }];
            render();
          })
          .catch(() => {});
      }
      const word = parseDefineQuery(t);
      if (word) {
        invoke("define_word", { word })
          .then((d) => {
            if (g !== generation || !d) return;
            buckets.answers = [{ kind: "answer", answerKind: "definition", title: `${d.word}${d.phonetic ? `  ${d.phonetic}` : ""}${d.part ? `  ·  ${d.part}` : ""}`, detail: `${d.definition} — Wiktionary`, url: engine().url(`define ${d.word}`) }];
            render();
          })
          .catch(() => {});
      }
    }
  }

  async function complete(g, text) {
    if (deleting || settings().autocomplete_addresses === false) return;
    if (!/^[^\s?]{2,}$/.test(text) || /^[a-z]+:/i.test(text)) return;
    const completion = await invoke("complete_address", { text }).catch(() => null);
    if (g !== generation || !completion) return;
    // Only if nothing changed meanwhile: same text, caret at its end.
    if (document.activeElement !== input || input.value !== text || input.selectionStart !== text.length) return;
    input.value = completion.text;
    input.setSelectionRange(text.length, completion.text.length);
    // Where it goes is the address the site really had (http, a port...).
    buckets.first = { kind: "go", title: shortUrl(completion.url), detail: "Go to site", url: completion.url, fill: completion.text, completed: true };
    render();
  }

  // --- Acting on it ---------------------------------------------------------------------

  async function activate(item, how) {
    hide();
    if (!item) return;
    switch (item.kind) {
      case "tab":
        await invoke("focus_tab", { id: item.tabId }).catch((err) => toast(String(err)));
        input.blur();
        return;
      case "command":
        input.blur();
        await runCommand(item.command);
        return;
      case "answer":
        if (item.copy) {
          await copyText(item.copy);
          toast(`Copied ${item.copy.length > 40 ? "to the clipboard" : item.copy}`);
          return;
        }
        if (item.url) await go(item.url, how);
        return;
      default:
        await go(item.url, how);
    }
  }

  async function remove(index) {
    const item = items[index];
    if (!item?.removable) return;
    await invoke("delete_history", { url: item.url }).catch(() => {});
    buckets.history = buckets.history.filter((h) => h.url !== item.url);
    toast("Removed from history");
    render();
  }

  function moveSelection(step) {
    if (!items.length) return;
    selected = (selected + step + items.length) % items.length;
    const item = items[selected];
    input.value = item.kind === "answer" || item.kind === "command" || item.kind === "tab" ? typed : item.fill ?? item.url ?? typed;
    input.setSelectionRange(input.value.length, input.value.length);
    emitTo(popup, "suggest-select", { selected }).catch(() => {});
  }

  // --- Wiring ------------------------------------------------------------------------------

  input.addEventListener("input", (e) => {
    if (e.isComposing) return;
    deleting = (e.inputType || "").startsWith("delete");
    update(input.value);
  });

  // Capture: before the address bar's own Enter / Escape handling (main.js),
  // which still does what isn't a suggestion's.
  input.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      const inlineCompletion = input.selectionStart < input.selectionEnd && input.selectionEnd === input.value.length && input.selectionStart > 0;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!open) {
          if (input.value.trim()) update(input.value);
          e.preventDefault();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        moveSelection(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        // A suggestion you moved to, or the completed address still as it
        // was completed: open that. Anything else is main.js's (it goes to
        // or searches for what's in the box -- Ctrl+Enter included).
        const first = items[0];
        const completedFirst = selected === 0 && first?.completed && input.value.toLowerCase() === first.fill.toLowerCase() && !e.ctrlKey;
        if (open && (selected > 0 || completedFirst)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          activate(items[selected], e.altKey ? "tab" : e.shiftKey ? "window" : "here");
        } else {
          hide();
        }
      } else if (e.key === "Escape") {
        if (open || inlineCompletion) {
          e.preventDefault();
          e.stopImmediatePropagation();
          input.value = typed;
          input.setSelectionRange(typed.length, typed.length);
          hide();
        }
      } else if (e.key === "Tab" && !e.shiftKey && inlineCompletion) {
        e.preventDefault();
        input.setSelectionRange(input.value.length, input.value.length);
        typed = input.value;
      } else if (e.key === "Delete" && e.shiftKey && open && items[selected]?.removable) {
        e.preventDefault();
        e.stopImmediatePropagation();
        remove(selected);
      }
    },
    true,
  );

  input.addEventListener("blur", () => {
    clearTimeout(hideTimer);
    // A click in the list takes the focus first; let its pick arrive.
    hideTimer = setTimeout(hide, 180);
  });

  listen("suggest-pick", (event) => {
    clearTimeout(hideTimer);
    const { index, how } = event.payload;
    activate(items[index], how);
  });
  listen("suggest-hover", (event) => {
    selected = event.payload.index;
  });
  listen("suggest-remove", (event) => {
    clearTimeout(hideTimer);
    input.focus();
    remove(event.payload.index);
  });
  listen("suggest-ready", () => {
    if (open) send();
  });

  return {
    hide,
    // The toolbar is about to show another tab's address.
    reset() {
      generation++;
      hide();
    },
    isOpen: () => open,
  };
}
