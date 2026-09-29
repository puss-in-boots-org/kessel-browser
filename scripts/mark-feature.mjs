// Updates rows of FEATURES.md: node scripts/mark-feature.mjs <row> <status> [note] [<row> <status> [note]]...
//
// <row> is a feature number ("2.09") or, for the shortcut table, the
// shortcut as written in its first column ("Ctrl + F5"). <status> is one of
// the legend's marks, or a word: done, had, engine, built, partial, todo,
// skip.
//
// Every run also rewrites the Progress summary at the top of FEATURES.md
// (between its <!-- progress --> markers) from the rows' marks. With no
// arguments -- or just --progress -- it only does that.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "FEATURES.md");
const WORDS = { done: "✅", had: "🟢", engine: "🌐", built: "🧪", partial: "🟡", todo: "⏳", skip: "⏭️" };
const STATUSES = new Set(Object.values(WORDS));

const args = process.argv.slice(2).filter((a) => a !== "--progress");
const edits = [];
for (let i = 0; i < args.length; ) {
  const row = args[i++];
  const status = WORDS[args[i]] || args[i];
  i++;
  if (!STATUSES.has(status)) throw new Error(`unknown status "${args[i - 1]}" for ${row}`);
  // A note is anything that isn't the start of the next edit.
  let note = null;
  if (i < args.length && !(i + 1 < args.length && (WORDS[args[i + 1]] || STATUSES.has(args[i + 1])))) note = args[i++];
  edits.push({ row, status, note });
}

const eol = readFileSync(file, "utf8").includes("\r\n") ? "\r\n" : "\n";
let lines = readFileSync(file, "utf8").split(/\r?\n/);
for (const { row, status, note } of edits) {
  const index = lines.findIndex((l) => l.startsWith(`| ${row} |`));
  if (index < 0) throw new Error(`no row "${row}" in FEATURES.md`);
  // "| row | name | status | note |" splits into
  // ["| row", "name", "status", "note |"] -- or "|" for an empty note.
  const cells = lines[index].split(" | ");
  cells[2] = status;
  if (note !== null) cells[3] = note ? `${note.replace(/\|/g, "\\|")} |` : "|";
  lines[index] = cells.join(" | ");
  console.log(lines[index]);
}

// --- The Progress summary ------------------------------------------------------

// Counts each table's marks: [{ title, anchor, counts }], one per "###"
// section, with the keyboard shortcut table first.
function tally(lines) {
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = /^(##|###) (.+)$/.exec(line);
    if (heading) {
      const title = heading[2].trim();
      current = heading[1] === "###" || /^Keyboard shortcuts/.test(title) ? { title, counts: {} } : null;
      if (current) sections.push(current);
      continue;
    }
    if (!current || !line.startsWith("| ")) continue;
    const status = line.split(" | ")[2];
    if (STATUSES.has(status)) current.counts[status] = (current.counts[status] || 0) + 1;
  }
  return sections.filter((s) => Object.keys(s.counts).length);
}

// Done: built and tested, already there, or the engine's. Built (🧪)
// counts as done too, but is shown apart until its end-to-end run.
function summarize(counts) {
  const n = (mark) => counts[mark] || 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const done = n("✅") + n("🟢") + n("🌐");
  return { total, done, built: n("🧪"), partial: n("🟡"), todo: n("⏳"), skipped: n("⏭️") };
}

function bar(fraction, width = 10) {
  const full = Math.round(fraction * width);
  return "█".repeat(full) + "░".repeat(width - full);
}

// Share of the rows that are done or built; partly done ones count half,
// skipped ones not at all.
function percent(s) {
  const counted = s.total - s.skipped;
  return counted ? (s.done + s.built + s.partial / 2) / counted : 1;
}

function anchor(title) {
  return title.toLowerCase().replace(/[^\w\- ]/g, "").trim().replace(/ /g, "-");
}

function progressBlock(lines) {
  const sections = tally(lines);
  const all = {};
  for (const s of sections) for (const [mark, count] of Object.entries(s.counts)) all[mark] = (all[mark] || 0) + count;
  const overall = summarize(all);
  const pct = (f) => `${Math.round(f * 100)}%`;
  const out = [
    "<!-- progress:start -- written by scripts/mark-feature.mjs; don't edit by hand -->",
    "## Progress",
    "",
    `**${pct(percent(overall))} overall** -- ${overall.done} done (✅ 🟢 🌐), ${overall.built} built and waiting for their Windows test run (🧪), ${overall.partial} partly done (🟡), ${overall.todo} to do (⏳), ${overall.skipped} skipped (⏭️), of ${overall.total}.`,
    "",
    "| Section | Done | 🧪 | 🟡 | ⏳ | ⏭️ | Progress |",
    "|---|---:|---:|---:|---:|---:|---|",
  ];
  for (const section of sections) {
    const s = summarize(section.counts);
    const cell = (v) => (v ? String(v) : "");
    out.push(`| [${section.title}](#${anchor(section.title)}) | ${cell(s.done)} | ${cell(s.built)} | ${cell(s.partial)} | ${cell(s.todo)} | ${cell(s.skipped)} | \`${bar(percent(s))}\` ${pct(percent(s))} |`);
  }
  out.push("", "Progress counts done and 🧪 rows, half of each 🟡 row, and leaves ⏭️ rows out.", "<!-- progress:end -->");
  return out;
}

const start = lines.findIndex((l) => l.startsWith("<!-- progress:start"));
const end = lines.findIndex((l) => l.startsWith("<!-- progress:end"));
if (start >= 0 && end > start) {
  lines = [...lines.slice(0, start), ...progressBlock(lines), ...lines.slice(end + 1)];
} else {
  // First time: just before the shortcut table.
  const at = lines.findIndex((l) => /^## Keyboard shortcuts/.test(l));
  lines = [...lines.slice(0, at), ...progressBlock(lines), "", ...lines.slice(at)];
}
writeFileSync(file, lines.join(eol));
