const fs = require("fs");
const path = require("path");
const { annotateCurriculumOrder } = require("./curriculum-order");

const ROOT = path.join(__dirname, "..");
const NOTES_DIR = path.join(ROOT, "notes");

function titleFromMarkdown(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function slugify(relativePath) {
  return relativePath
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .replace(/[^\w/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
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

function listNotes() {
  const files = walkMarkdownFiles(NOTES_DIR);

  const notes = files.map((fullPath) => {
    const relative = path.relative(NOTES_DIR, fullPath).replace(/\\/g, "/");
    const markdown = fs.readFileSync(fullPath, "utf8");
    const fallbackTitle = path.basename(relative, path.extname(relative));
    const folder = path.posix.dirname(relative);
    return {
      id: slugify(relative),
      title: titleFromMarkdown(markdown, fallbackTitle),
      description: folder === "." ? undefined : folder,
      file: `notes/${relative}`,
    };
  });

  return annotateCurriculumOrder(notes);
}

module.exports = { ROOT, NOTES_DIR, listNotes, walkMarkdownFiles };
