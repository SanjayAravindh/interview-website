const fs = require("fs");
const path = require("path");
const { ROOT, NOTES_DIR, walkMarkdownFiles } = require("../lib/notes");
const { headingSlug, parseTocLinkLine } = require("../lib/toc-utils");

const QA_HEADING = /^##\s+(?:\d+\.\s+)?(.*(?:Interview\s*Q&A|Scenario-Based\s+Questions|Scenario\s+Q&A|Practice\s+Questions\s*&\s*Answers).*)$/i;

const ANSWER_PREFIX = /^\*\*(?:A|Ans|Answer)\*\*[.:]?\s*|^\*\*(?:A|Ans|Answer)[.:]\*\*\s*|^(?:A|Answer)[.:]\s*/i;

function findQaSection(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!QA_HEADING.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) {
        end = j;
        break;
      }
    }
    return { start: i, end, heading: lines[i] };
  }
  return null;
}

function parseItems(bodyLines) {
  const items = [];
  let current = null;

  for (const line of bodyLines) {
    const m = line.match(/^###\s+(?:Q\s*)?(\d+)\.\s*(.+)$/i);
    if (m) {
      if (current) items.push(current);
      current = { num: m[1], question: m[2].trim(), answer: [] };
      continue;
    }
    if (/^###\s+/.test(line)) {
      // A sub-heading that is not a numbered question: keep it inside the
      // previous answer rather than dropping it.
      if (current) current.answer.push(line);
      continue;
    }
    if (current) current.answer.push(line);
  }
  if (current) items.push(current);

  // A closing note after the final question sits inside the same section, so it
  // would otherwise be swallowed into the last answer. Split it back out.
  let footer = [];
  const last = items[items.length - 1];
  if (last) {
    const hrIdx = last.answer.findIndex((l) => /^---\s*$/.test(l));
    if (hrIdx !== -1) {
      footer = last.answer.slice(hrIdx);
      last.answer = last.answer.slice(0, hrIdx);
    }
  }

  return { items, footer };
}

function buildDropdowns(items) {
  const out = ["## Practice Questions & Answers", ""];
  for (const item of items) {
    let answer = item.answer.join("\n").trim();
    answer = answer.replace(ANSWER_PREFIX, "").trim();
    if (!answer) continue;
    out.push('<details class="qa-item">');
    out.push(`<summary>${item.num}. ${item.question}</summary>`);
    out.push("");
    out.push(answer);
    out.push("");
    out.push("</details>");
    out.push("");
  }
  return out;
}

function dropTocEntry(lines, removedSlug) {
  const tocStart = lines.findIndex((l) => /^##\s+Table of Contents\s*$/i.test(l));
  if (tocStart === -1) return lines;

  let tocEnd = lines.length;
  for (let j = tocStart + 1; j < lines.length; j++) {
    if (/^##\s+/.test(lines[j]) || /^---\s*$/.test(lines[j])) {
      tocEnd = j;
      break;
    }
  }

  const kept = [];
  for (let i = tocStart + 1; i < tocEnd; i++) {
    const parsed = parseTocLinkLine(lines[i]);
    if (parsed && parsed.anchor === removedSlug) continue;
    kept.push(lines[i]);
  }

  let n = 0;
  const renumbered = kept.map((line) => {
    const parsed = parseTocLinkLine(line);
    if (!parsed) return line;
    n += 1;
    return `${n}. [${parsed.label}](#${parsed.anchor})`;
  });

  return [...lines.slice(0, tocStart + 1), ...renumbered, ...lines.slice(tocEnd)];
}

function convert(md) {
  const normalized = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/<details class="qa-item">/i.test(normalized)) return null;

  let lines = normalized.split("\n");
  const section = findQaSection(lines);
  if (!section) return null;

  const { items, footer } = parseItems(lines.slice(section.start + 1, section.end));
  if (items.length < 2) return null;

  const removedSlug = headingSlug(section.heading.replace(/^##\s+/, "").trim());
  const dropdowns = [...buildDropdowns(items), ...footer];

  lines = [...lines.slice(0, section.start), ...dropdowns, ...lines.slice(section.end)];
  lines = dropTocEntry(lines, removedSlug);

  return { markdown: lines.join("\n").trimEnd() + "\n", count: items.length };
}

const dryTarget = process.argv[2] === "--dry" ? process.argv[3] : null;
if (dryTarget) {
  const original = fs.readFileSync(dryTarget, "utf8");
  const result = convert(original);
  if (!result) {
    console.log("no conversion");
  } else {
    const out = path.join(ROOT, ".qa-preview.md");
    fs.writeFileSync(out, result.markdown, "utf8");
    console.log(`preview -> ${out} (${result.count} questions)`);
  }
  process.exit(0);
}

let converted = 0;
let skipped = 0;

for (const filePath of walkMarkdownFiles(NOTES_DIR).sort()) {
  const original = fs.readFileSync(filePath, "utf8");
  const result = convert(original);
  const rel = path.relative(ROOT, filePath);
  if (!result) {
    skipped += 1;
    console.log(`skip     ${rel}`);
    continue;
  }
  fs.writeFileSync(filePath, result.markdown, "utf8");
  converted += 1;
  console.log(`converted ${rel} (${result.count} questions)`);
}

console.log(`\n${converted} converted, ${skipped} skipped`);
