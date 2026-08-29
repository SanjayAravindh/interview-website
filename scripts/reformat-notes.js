const path = require("path");
const { ROOT, NOTES_DIR } = require("../lib/notes");
const { reformatAllNotes } = require("../lib/note-format");

const results = reformatAllNotes(NOTES_DIR);
const changed = results.filter((r) => r.changed);

console.log(`Processed ${results.length} note(s).`);
for (const entry of changed) {
  console.log(`  updated: ${path.relative(ROOT, entry.file)}`);
}
console.log(`Changed ${changed.length} file(s).`);
