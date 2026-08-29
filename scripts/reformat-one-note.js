const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { ROOT } = require("../lib/notes");
const {
  normalizeMarkdown,
  removeExistingTOC,
  insertTableOfContents,
  extractDetailsBlocks,
  extractAllQASections,
  buildQASection,
  removeDuplicatePreamble,
} = require("../lib/note-format");

const relPath = process.argv[2];
if (!relPath) {
  console.error("Usage: node scripts/reformat-one-note.js notes/path/to/file.md");
  process.exit(1);
}

const filePath = path.join(ROOT, relPath);
const posixPath = relPath.replace(/\\/g, "/");
let md = fs.readFileSync(filePath, "utf8");

function gitOriginal() {
  try {
    return execSync(`git show HEAD:${posixPath}`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function restorePreambleIfNeeded(content) {
  if (content.startsWith("#")) return content;
  const original = gitOriginal();
  if (!original) return content;

  const preamble = original.match(/^[\s\S]*?\n---\n\n/);
  const toc = content.match(/^## Table of Contents\n[\s\S]*?\n---\n\n/);
  if (!preamble || !toc) return content;
  return `${preamble[0]}${toc[0]}${content.slice(toc[0].length)}`;
}

md = restorePreambleIfNeeded(normalizeMarkdown(md));

const { body: bodyNoDetails, items: detailItems } = extractDetailsBlocks(md);
const extracted = extractAllQASections(bodyNoDetails);
const allItems = [...extracted.items, ...detailItems];

let body = removeExistingTOC(extracted.body);
body = removeDuplicatePreamble(body);
body = insertTableOfContents(body);

if (allItems.length) {
  body = `${body.trim()}\n${buildQASection(allItems)}`;
}

const output = `${body.trim()}\n`;
fs.writeFileSync(filePath, output, "utf8");

const intro = output.slice(0, 12000);
const checks = {
  file: posixPath,
  hasTitle: output.startsWith("#"),
  hasTopToc: /## Table of Contents/.test(intro) && intro.indexOf("## Table of Contents") < intro.search(/^#{1,2}\s+(?:Part|Concept|JAVA|\d+\.)/m || Infinity),
  qaCount: (output.match(/<details class="qa-item">/g) || []).length,
  lineCount: output.split("\n").length,
  changed: true,
};

console.log(JSON.stringify(checks));
