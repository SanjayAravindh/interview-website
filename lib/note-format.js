const fs = require("fs");
const path = require("path");
const { headingSlug, formatTocLine } = require("./toc-utils");

const QA_SECTION_HEADER =
  /^#{1,3}\s+(?:Practice\b[^\n]*answers?|Practice\s+Problems\b[^\n]*|8\.\s*Interview-level\s+questions[^\n]*|Scenario-Based\s+Questions[^\n]*|Guess\s+the\s+Output[^\n]*|Part\s+\d+[^\n]*Final\s+Practice\s+Phase[^\n]*|Final\s+Practice\s+Phase[^\n]*|Part\s+\d+[^\n]*\(with\s+Answers\)[^\n]*)\s*$/gim;

function isTocHeading(text, docTitle) {
  if (docTitle && text === docTitle) return false;
  if (/^\d+\.\s/.test(text)) return true;
  if (/^Lesson\s+\d+/i.test(text)) return true;
  if (/^Part\s+\d+/i.test(text)) return true;
  if (/^Concept\s+\d+/i.test(text)) return true;
  if (/^JAVA\s+\d+/i.test(text)) return true;
  if (/^(Quick|Most-Asked|Roadmap)/i.test(text)) return true;
  return false;
}

function extractHeadings(md) {
  const docTitle = md.match(/^#\s+(.+)/)?.[1]?.trim();
  const headings = [];
  for (const rawLine of md.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const m = line.match(/^(#{1,2})\s+(.+)$/);
    if (!m) continue;
    const text = m[2].trim();
    if (/^table of contents$/i.test(text)) continue;
    if (/^practice questions/i.test(text)) continue;
    if (!isTocHeading(text, docTitle)) continue;
    headings.push({ level: m[1].length, text });
  }
  return headings;
}

function removeExistingTOC(md) {
  md = normalizeMarkdown(md);
  // Match TOC block even when the preceding --- is separated by blank lines from the title.
  return md.replace(/\n## Table of Contents\n[\s\S]*?\n---\n+/g, "\n");
}

function normalizeMarkdown(md) {
  return md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function removeDuplicatePreamble(md) {
  const lines = md.split("\n");
  const firstTitleIdx = lines.findIndex((l) => /^#\s+/.test(l.replace(/\r$/, "")));
  if (firstTitleIdx === -1) return md;

  const titleLine = lines[firstTitleIdx].replace(/\r$/, "").trim();
  let titleCount = 0;
  const out = [];
  let skipping = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === titleLine) {
      titleCount++;
      if (titleCount > 1) {
        skipping = true;
        continue;
      }
    }
    if (skipping) {
      if (line.trim() === "---") {
        skipping = false;
      }
      continue;
    }
    out.push(rawLine.replace(/\r$/, ""));
  }

  return out.join("\n");
}

function hasTopTableOfContents(md) {
  const intro = md.slice(0, Math.min(md.length, 12000));
  const tocIndex = intro.search(/^##\s+Table of Contents\s*$/im);
  if (tocIndex === -1) return false;
  const partIndex = intro.search(/^#{1,2}\s+Part\s+\d+/im);
  const conceptIndex = intro.search(/^##\s+Concept\s+\d+/im);
  const javaIndex = intro.search(/^##\s+JAVA\s+\d+/im);
  const numberedIndex = intro.search(/^##\s+\d+\.\s+/im);
  const nextSection = Math.min(
    partIndex === -1 ? Infinity : partIndex,
    conceptIndex === -1 ? Infinity : conceptIndex,
    javaIndex === -1 ? Infinity : javaIndex,
    numberedIndex === -1 ? Infinity : numberedIndex
  );
  return tocIndex < nextSection;
}

function insertTableOfContents(md) {
  md = normalizeMarkdown(md);
  if (hasTopTableOfContents(md)) return md;

  const headings = extractHeadings(md);
  if (headings.length < 2) return md;

  const items = headings.map((h, idx) => formatTocLine(idx, h.text));

  const tocBlock = `## Table of Contents\n\n${items.join("\n")}\n\n---\n`;

  const titleHr = md.match(/^#\s+[^\n]+\n+---\n+/);
  if (titleHr) {
    const insertPos = titleHr[0].length;
    return `${md.slice(0, insertPos)}\n${tocBlock}\n${md.slice(insertPos)}`;
  }

  const firstHr = md.indexOf("\n---\n");
  if (firstHr !== -1) {
    const insertPos = firstHr + 5;
    return `${md.slice(0, insertPos)}\n${tocBlock}\n${md.slice(insertPos)}`;
  }

  const titleMatch = md.match(/^#\s+.+\n+/);
  if (titleMatch) {
    const pos = titleMatch[0].length;
    return `${md.slice(0, pos)}\n---\n\n${tocBlock}\n${md.slice(pos)}`;
  }

  return `${tocBlock}\n${md}`;
}

function findQASectionEnd(md, startPos, headerLevel) {
  const rest = md.slice(startPos);
  const boundary = new RegExp(`\\n(?=#{1,${headerLevel}}\\s|\\n---\\s*\\n(?=#))`, "m");
  const match = rest.match(boundary);
  return startPos + (match ? match.index : rest.length);
}

function splitQuestionAnswer(text) {
  const trimmed = text.trim();
  if (!trimmed) return { question: "", answer: "" };

  const lines = trimmed.split("\n");
  const firstLine = lines[0];
  const dashOnFirst = firstLine.search(/\s[—–-]\s/);
  if (dashOnFirst > 0 && !firstLine.includes("```")) {
    return {
      question: firstLine.slice(0, dashOnFirst).trim(),
      answer:
        firstLine.slice(dashOnFirst).replace(/^\s*[—–-]\s*/, "").trim() +
        (lines.length > 1 ? "\n" + lines.slice(1).join("\n") : ""),
    };
  }

  if (lines.length === 1) {
    return { question: firstLine, answer: "" };
  }

  return { question: lines[0], answer: lines.slice(1).join("\n").trim() };
}

function pushQA(items, section, summary, answerMd) {
  items.push({
    section,
    summary: summary.trim(),
    answerMd: (answerMd || "").trim(),
  });
}

function parseQAContent(content, items, sectionTitle) {
  const trimmed = content.trim();
  if (!trimmed) return;

  if (/^###\s+Q\d+/m.test(trimmed)) {
    const chunks = trimmed.split(/\n(?=###\s+Q\d+)/);
    for (const chunk of chunks) {
      const match = chunk.match(/^###\s+Q(\d+)\.\s*(.+?)\n([\s\S]*)/);
      if (!match) continue;
      pushQA(items, sectionTitle, `Q${match[1]}. ${match[2].trim()}`, match[3]);
    }
    return;
  }

  if (/^##\s+Level\s+\d+/m.test(trimmed)) {
    const levelChunks = trimmed.split(/\n(?=##\s+Level\s+\d+)/);
    for (const levelChunk of levelChunks) {
      const levelMatch = levelChunk.match(/^##\s+(Level\s+\d+\s+[—–-].+?)\s*\n([\s\S]*)/);
      if (!levelMatch) continue;
      const levelTitle = levelMatch[1].trim();
      const levelBody = levelMatch[2].trim();
      parseNumberedBlocks(levelBody, items, `${sectionTitle} — ${levelTitle}`);
    }
    return;
  }

  if (/^\*\*\d+\./m.test(trimmed)) {
    const chunks = trimmed.split(/\n(?=\*\*\d+\.)/);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;

      let num;
      let question;
      let answer;

      const tight = chunk.match(/^\*\*(\d+)\.\*\*\s*([\s\S]*)/);
      if (tight) {
        num = tight[1];
        const split = splitQuestionAnswer(tight[2]);
        question = split.question;
        answer = split.answer;
      } else {
        const wrapped = chunk.match(/^\*\*(\d+)\.\s*([\s\S]*?)\*\*\s*([\s\S]*)/);
        if (!wrapped) continue;
        num = wrapped[1];
        question = wrapped[2].trim();
        answer = wrapped[3].trim();
      }

      pushQA(items, sectionTitle, `${num}. ${question}`, answer);
    }
    return;
  }

  if (/^-\s*\*"/m.test(trimmed)) {
    const lines = trimmed.split("\n");
    let current = null;
    for (const line of lines) {
      const bullet = line.match(/^-\s*\*"?(.+?)"?\*(?:\s*[—–-]\s*(.*))?$/);
      if (bullet) {
        if (current) pushQA(items, sectionTitle, current.question, current.answer);
        current = {
          question: bullet[1].trim(),
          answer: (bullet[2] || "").trim(),
        };
        continue;
      }
      if (current && line.trim()) {
        current.answer = `${current.answer}\n${line}`.trim();
      }
    }
    if (current) pushQA(items, sectionTitle, current.question, current.answer);
    return;
  }

  parseNumberedBlocks(trimmed, items, sectionTitle);
}

function parseNumberedBlocks(content, items, sectionTitle) {
  const chunks = content.split(/\n(?=\d+\.\s)/);
  for (const chunk of chunks) {
    const match = chunk.match(/^(\d+)\.\s+([\s\S]*)/);
    if (!match) continue;
    const body = match[2].trim();
    if (!body) continue;
    const { question, answer } = splitQuestionAnswer(body);
    const summaryLine = question.split("\n")[0].trim();
    pushQA(
      items,
      sectionTitle,
      `${match[1]}. ${summaryLine}`,
      answer || (question.includes("\n") ? answer : body.includes("\n") ? body.slice(summaryLine.length).trim() : "")
    );
  }
}

function extractAllQASections(md) {
  const items = [];
  const headers = [...md.matchAll(QA_SECTION_HEADER)];
  const removals = [];

  for (const header of headers) {
    const headerEnd = header.index + header[0].length;
    const level = header[0].match(/^#+/)[0].length;
    const sectionEnd = findQASectionEnd(md, headerEnd, level);
    const content = md.slice(headerEnd, sectionEnd).trim();
    const sectionTitle = header[0].replace(/^#+\s*/, "").trim();

    const sectionItems = [];
    parseQAContent(content, sectionItems, sectionTitle);
    if (!sectionItems.length) continue;

    items.push(...sectionItems);
    removals.push({ start: header.index, end: sectionEnd });
  }

  let body = md;
  for (let i = removals.length - 1; i >= 0; i--) {
    const { start, end } = removals[i];
    body = `${body.slice(0, start).trimEnd()}\n\n${body.slice(end).trimStart()}`.trim();
  }

  return { body, items };
}

function extractDetailsBlocks(md) {
  const items = [];
  const re = /<details class="qa-item">\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/gi;
  let body = md;
  let match;
  while ((match = re.exec(md)) !== null) {
    items.push({ section: "", summary: match[1].trim(), answerMd: match[2].trim() });
  }
  body = body.replace(re, "");
  body = body.replace(/\n## Practice Questions & Answers\s*/gi, "\n");
  return { body: body.trim(), items };
}

function buildQASection(items) {
  if (!items.length) return "";

  let out = "\n\n---\n\n## Practice Questions & Answers\n\n";
  let currentSection = "";

  for (const item of items) {
    if (item.section && item.section !== currentSection) {
      currentSection = item.section;
      out += `### ${currentSection}\n\n`;
    }

    const answer =
      item.answerMd ||
      "_Work through this on your own first — detailed answer not included in the source note._";

    out += `<details class="qa-item">\n<summary>${item.summary}</summary>\n\n${answer}\n\n</details>\n\n`;
  }

  return out;
}

function reformatMarkdown(md) {
  md = normalizeMarkdown(md);
  let { body, items: detailItems } = extractDetailsBlocks(md);
  const extracted = extractAllQASections(body);
  body = extracted.body;
  const items = [...extracted.items, ...detailItems];

  body = removeExistingTOC(body);
  body = removeDuplicatePreamble(body);
  body = insertTableOfContents(body);

  if (items.length) {
    body = `${body.trim()}\n${buildQASection(items)}`;
  }

  return body.trim() + "\n";
}

function walkMarkdownFiles(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(fullPath, found);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      found.push(fullPath);
    }
  }
  return found;
}

function reformatAllNotes(notesDir) {
  const files = walkMarkdownFiles(notesDir).sort();
  const results = [];

  for (const filePath of files) {
    const original = fs.readFileSync(filePath, "utf8");
    const reformatted = reformatMarkdown(original);
    if (reformatted !== original) {
      fs.writeFileSync(filePath, reformatted, "utf8");
      results.push({ file: filePath, changed: true });
    } else {
      results.push({ file: filePath, changed: false });
    }
  }

  return results;
}

module.exports = {
  headingSlug,
  insertTableOfContents,
  removeExistingTOC,
  removeDuplicatePreamble,
  normalizeMarkdown,
  extractAllQASections,
  extractDetailsBlocks,
  buildQASection,
  reformatMarkdown,
  reformatAllNotes,
  walkMarkdownFiles,
};
