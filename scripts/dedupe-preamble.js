const fs = require("fs");
const path = require("path");
const { ROOT, NOTES_DIR } = require("../lib/notes");
const { removeDuplicatePreamble, walkMarkdownFiles } = require("../lib/note-format");

for (const filePath of walkMarkdownFiles(NOTES_DIR)) {
  const original = fs.readFileSync(filePath, "utf8");
  const fixed = removeDuplicatePreamble(original);
  if (fixed !== original) {
    fs.writeFileSync(filePath, fixed.endsWith("\n") ? fixed : fixed + "\n", "utf8");
    console.log("deduped:", path.relative(ROOT, filePath));
  }
}
