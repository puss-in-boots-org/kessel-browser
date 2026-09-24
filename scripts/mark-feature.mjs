// Updates rows of FEATURES.md: node scripts/mark-feature.mjs <row> <status> [note] [<row> <status> [note]]...
//
// <row> is a feature number ("2.09") or, for the shortcut table, the
// shortcut as written in its first column ("Ctrl + F5"). <status> is one of
// the legend's marks, or a word: done, had, engine, partial, todo, skip.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "FEATURES.md");
const WORDS = { done: "✅", had: "🟢", engine: "🌐", partial: "🟡", todo: "⏳", skip: "⏭️" };
const STATUSES = new Set(Object.values(WORDS));

const args = process.argv.slice(2);
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
const lines = readFileSync(file, "utf8").split(/\r?\n/);
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
writeFileSync(file, lines.join(eol));
