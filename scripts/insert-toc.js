const path = require("path");
const fs = require("fs");
const { ROOT, NOTES_DIR } = require("../lib/notes");
const { removeExistingTOC, insertTableOfContents, walkMarkdownFiles } = require("../lib/note-format");

for (const filePath of walkMarkdownFiles(NOTES_DIR)) {
  const original = fs.readFileSync(filePath, "utf8");
  const updated = insertTableOfContents(removeExistingTOC(original));
  if (updated !== original) {
    fs.writeFileSync(filePath, updated, "utf8");
    console.log(`TOC updated: ${path.relative(ROOT, filePath)}`);
  }
}
