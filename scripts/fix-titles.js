const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { ROOT, NOTES_DIR } = require("../lib/notes");
const { walkMarkdownFiles, removeExistingTOC, insertTableOfContents } = require("../lib/note-format");

function gitOriginal(relPath) {
  try {
    return execSync(`git show HEAD:${relPath.replace(/\\/g, "/")}`, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function preambleFromOriginal(original) {
  const match = original.match(/^[\s\S]*?\n---\n\n/);
  return match ? match[0] : null;
}

function tocBlockFromCurrent(current) {
  const match = current.match(/^## Table of Contents\n[\s\S]*?\n---\n\n/);
  return match ? match[0] : null;
}

for (const filePath of walkMarkdownFiles(NOTES_DIR)) {
  const relPath = path.relative(ROOT, filePath).replace(/\\/g, "/");
  const current = fs.readFileSync(filePath, "utf8");
  const original = gitOriginal(relPath);
  if (!original) continue;

  const toc = tocBlockFromCurrent(current);
  const preamble = preambleFromOriginal(original);
  if (!toc || !preamble) continue;

  if (current.startsWith("#")) {
    if (!current.includes("## Table of Contents")) {
      const fixed = insertTableOfContents(removeExistingTOC(current));
      if (fixed !== current) {
        fs.writeFileSync(filePath, fixed, "utf8");
        console.log(`TOC added: ${relPath}`);
      }
    }
    continue;
  }

  const afterToc = current.slice(toc.length);
  const fixed = `${preamble}${toc}${afterToc}`;
  fs.writeFileSync(filePath, fixed, "utf8");
  console.log(`Title restored: ${relPath}`);
}
