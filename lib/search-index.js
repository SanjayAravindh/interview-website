const fs = require("fs");
const path = require("path");
const { NOTES_DIR, listNotes } = require("./notes");
const { headingSlug } = require("./toc-utils");

function uniqueHeadingSlug(text, used) {
  const base = headingSlug(text);
  let slug = base;
  let n = 1;
  while (used.has(slug)) {
    slug = `${base}-${n++}`;
  }
  used.add(slug);
  return slug;
}

function toPlain(md) {
  return String(md)
    .replace(/<details[\s\S]*?<\/details>/gi, (block) =>
      block.replace(/<[^>]+>/g, " ")
    )
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSections(markdown) {
  const used = new Set();
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let current = {
    heading: "",
    headingId: "",
    lines: [],
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,2})\s+(.+)$/);
    if (heading) {
      const text = heading[2].trim();
      if (/^table of contents$/i.test(text)) {
        continue;
      }
      if (current.heading || current.lines.length) {
        sections.push(current);
      }
      current = {
        heading: text,
        headingId: uniqueHeadingSlug(text, used),
        lines: [],
      };
      continue;
    }
    current.lines.push(line);
  }
  if (current.heading || current.lines.length) {
    sections.push(current);
  }
  return sections;
}

function buildSearchIndex() {
  const notes = listNotes();
  const documents = notes.map((note) => {
    const fullPath = path.join(NOTES_DIR, note.file.replace(/^notes\//, ""));
    const markdown = fs.readFileSync(fullPath, "utf8");
    const sections = splitSections(markdown)
      .map((section) => {
        const text = toPlain(section.lines.join("\n"));
        if (!section.heading && !text) return null;
        return {
          heading: section.heading,
          headingId: section.headingId,
          text: text.slice(0, 8000),
        };
      })
      .filter(Boolean);

    return {
      id: note.id,
      title: note.title,
      group: note.groupLabel || note.description || "Notes",
      sections,
    };
  });

  return { generatedAt: new Date().toISOString(), documents };
}

module.exports = { buildSearchIndex, toPlain };
