const fs = require("fs");
const path = require("path");
const { ROOT, NOTES_DIR, walkMarkdownFiles } = require("../lib/notes");
const { headingSlug, parseTocLinkLine } = require("../lib/toc-utils");

function collectHeadingIds(md) {
  const used = new Set();
  const ids = new Set();

  for (const rawLine of md.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const m = line.match(/^(#{1,2})\s+(.+)$/);
    if (!m) continue;
    const text = m[2].trim();
    if (/^table of contents$/i.test(text)) continue;

    const base = headingSlug(text);
    let slug = base;
    let n = 1;
    while (used.has(slug)) {
      slug = `${base}-${n++}`;
    }
    used.add(slug);
    ids.add(slug);
  }

  return ids;
}

function extractTocLinks(md) {
  const links = [];
  let inToc = false;
  for (const rawLine of md.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^##\s+Table of Contents\s*$/i.test(line)) {
      inToc = true;
      continue;
    }
    if (inToc && /^---\s*$/.test(line.trim())) {
      inToc = false;
      continue;
    }
    if (!inToc) continue;
    const parsed = parseTocLinkLine(line);
    if (parsed) links.push(parsed);
  }
  return links;
}

let brokenTotal = 0;
let filesWithIssues = 0;

for (const filePath of walkMarkdownFiles(NOTES_DIR)) {
  const md = fs.readFileSync(filePath, "utf8");
  const headingIds = collectHeadingIds(md);
  const tocLinks = extractTocLinks(md);
  if (!tocLinks.length) continue;

  const broken = [];
  for (const link of tocLinks) {
    if (!headingIds.has(link.anchor)) {
      broken.push(link);
    }
  }

  if (broken.length) {
    filesWithIssues++;
    console.log("\n" + path.relative(ROOT, filePath));
    for (const link of broken) {
      brokenTotal++;
      console.log(`  BROKEN: [${link.label}] → #${link.anchor}`);
    }
  }
}

if (!filesWithIssues) {
  console.log("All TOC links resolve to a heading slug in their file.");
} else {
  console.log(`\n${brokenTotal} broken link(s) in ${filesWithIssues} file(s).`);
  process.exitCode = 1;
}
