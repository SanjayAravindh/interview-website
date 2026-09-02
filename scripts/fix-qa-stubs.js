/**
 * Fix Q&A stubs by scanning details blocks line-by-line (handles corrupted nesting).
 */
const fs = require("fs");
const path = require("path");
const { ROOT } = require("../lib/notes");
const answers = require("./qa-stub-answers");

const STUB =
  "_Work through this on your own first — detailed answer not included in the source note._";

const FILES = [
  { rel: "notes/Spring/Spring_Core.md", map: answers.springCore },
  { rel: "notes/Java/java-collections.md", map: answers.collections },
  { rel: "notes/Java/java-concurrency.md", map: answers.concurrency },
];

function normalizeKey(s) {
  return s.replace(/\s+/g, " ").trim();
}

function findAnswer(summary, map) {
  const firstLine = normalizeKey(summary.split(/\r?\n/)[0]);
  if (map[firstLine]) return map[firstLine];
  for (const [key, value] of Object.entries(map)) {
    const nk = normalizeKey(key);
    if (firstLine === nk || firstLine.startsWith(nk.slice(0, 45)) || nk.startsWith(firstLine.slice(0, 45))) {
      return value;
    }
  }
  return null;
}

function fixFile(rel, map) {
  const filePath = path.join(ROOT, rel);
  let md = fs.readFileSync(filePath, "utf8");
  let replaced = 0;
  const missing = [];

  const blockRe =
    /<details class="qa-item">\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/g;

  md = md.replace(blockRe, (full, summary, body) => {
    const trimmed = body.trim();
    if (!trimmed.includes(STUB)) return full;
    const answer = findAnswer(summary, map);
    if (!answer) {
      missing.push(normalizeKey(summary.split(/\r?\n/)[0]).slice(0, 90));
      return full;
    }
    replaced++;
    return `<details class="qa-item">\n<summary>${summary.trim()}</summary>\n\n${answer}\n\n</details>`;
  });

  fs.writeFileSync(filePath, md, "utf8");
  return {
    rel,
    replaced,
    missing,
    remaining: (md.match(/Work through this on your own first/g) || []).length,
  };
}

const results = FILES.map(({ rel, map }) => fixFile(rel, map));
console.log(JSON.stringify(results, null, 2));
const total = results.reduce((s, r) => s + r.remaining, 0);
if (total) process.exit(1);
