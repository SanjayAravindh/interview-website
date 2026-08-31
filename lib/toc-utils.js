/**
 * Shared TOC label/slug helpers (Node + browser-compatible logic).
 */

function headingSlug(text) {
  const base =
    String(text)
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section";
  return base;
}

/** Remove leading "N. " from numbered section titles for TOC display. */
function stripTocLabel(text) {
  return String(text)
    .trim()
    .replace(/^\d+\.\s+/, "");
}

function formatTocLine(index, headingText, slug) {
  const label = stripTocLabel(headingText);
  const anchor = slug || headingSlug(headingText);
  return `${index + 1}. [${label}](#${anchor})`;
}

function parseTocLinkLine(line) {
  const trimmed = line.trim();
  const numbered = trimmed.match(/^(\d+)\.\s+\[(.+?)\]\((#[^)]+)\)\s*$/);
  if (numbered) {
    return {
      lineNumber: numbered[1],
      label: numbered[2],
      anchor: numbered[3].slice(1),
    };
  }
  const bullet = trimmed.match(/^-\s+\[(.+?)\]\((#[^)]+)\)\s*$/);
  if (bullet) {
    return { lineNumber: null, label: bullet[1], anchor: bullet[2].slice(1) };
  }
  return null;
}

/** Fix duplicate numbering: `1. [1. Title](#x)` → `1. [Title](#x)` */
function fixTocLine(line) {
  const trimmed = line.trim();
  const dup = trimmed.match(/^(\d+)\.\s+\[\d+\.\s+(.+)\]\((#[^)]+)\)\s*$/);
  if (dup) {
    return `${dup[1]}. [${dup[2]}](${dup[3]})`;
  }
  return line;
}

module.exports = {
  headingSlug,
  stripTocLabel,
  formatTocLine,
  parseTocLinkLine,
  fixTocLine,
};
