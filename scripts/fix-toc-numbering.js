const fs = require("fs");
const path = require("path");
const { ROOT, NOTES_DIR, walkMarkdownFiles } = require("../lib/notes");
const { fixTocLine } = require("../lib/toc-utils");

function fixTocInMarkdown(md) {
  const tocHeader = /^##\s+Table of Contents\s*$/im;
  if (!tocHeader.test(md)) return { md, changed: false };

  const lines = md.split("\n");
  let inToc = false;
  let changed = false;
  const out = [];

  for (const line of lines) {
    if (/^##\s+Table of Contents\s*$/i.test(line)) {
      inToc = true;
      out.push(line);
      continue;
    }
    if (inToc && /^---\s*$/.test(line.trim())) {
      inToc = false;
      out.push(line);
      continue;
    }
    if (inToc && line.trim()) {
      const fixed = fixTocLine(line);
      if (fixed !== line) {
        changed = true;
        out.push(fixed);
        continue;
      }
    }
    out.push(line);
  }

  return { md: out.join("\n"), changed };
}

let total = 0;
for (const filePath of walkMarkdownFiles(NOTES_DIR)) {
  const original = fs.readFileSync(filePath, "utf8");
  const { md, changed } = fixTocInMarkdown(original);
  if (changed) {
    fs.writeFileSync(filePath, md.endsWith("\n") ? md : md + "\n", "utf8");
    console.log("fixed:", path.relative(ROOT, filePath));
    total++;
  }
}
console.log(`Done. ${total} file(s) updated.`);
