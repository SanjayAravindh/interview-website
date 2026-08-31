const fs = require("fs");
const path = require("path");
const { ROOT, NOTES_DIR, walkMarkdownFiles } = require("../lib/notes");
const { headingSlug, stripTocLabel, parseTocLinkLine } = require("../lib/toc-utils");

function collectHeadings(md) {
  const entries = [];
  const used = new Set();

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
    entries.push({ text, slug, label: stripTocLabel(text) });
  }

  return entries;
}

function normalizeLabel(s) {
  return String(s).replace(/\s+/g, " ").trim().toLowerCase();
}

function findHeadingForTocLabel(label, headings) {
  const n = normalizeLabel(label);
  let hit = headings.find((h) => normalizeLabel(h.label) === n);
  if (hit) return hit;
  hit = headings.find((h) => normalizeLabel(h.text) === n);
  if (hit) return hit;
  return headings.find(
    (h) =>
      normalizeLabel(h.label).includes(n) ||
      n.includes(normalizeLabel(h.label))
  );
}

function fixTocAnchorsInMarkdown(md) {
  if (!/^##\s+Table of Contents\s*$/im.test(md)) {
    return { md, changed: false };
  }

  const headings = collectHeadings(md);
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
      const parsed = parseTocLinkLine(line);
      if (parsed) {
        const hit = findHeadingForTocLabel(parsed.label, headings);
        if (hit && hit.slug !== parsed.anchor) {
          changed = true;
          const prefix = parsed.lineNumber ? `${parsed.lineNumber}. ` : "- ";
          out.push(`${prefix}[${parsed.label}](#${hit.slug})`);
          continue;
        }
      }
    }
    out.push(line);
  }

  return { md: out.join("\n"), changed };
}

let total = 0;
for (const filePath of walkMarkdownFiles(NOTES_DIR)) {
  const original = fs.readFileSync(filePath, "utf8");
  const { md, changed } = fixTocAnchorsInMarkdown(original);
  if (changed) {
    fs.writeFileSync(filePath, md.endsWith("\n") ? md : md + "\n", "utf8");
    console.log("anchors fixed:", path.relative(ROOT, filePath));
    total++;
  }
}
console.log(`Done. ${total} file(s) updated.`);
