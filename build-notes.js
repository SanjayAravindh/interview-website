const fs = require("fs");
const path = require("path");
const { ROOT, NOTES_DIR, listNotes } = require("./lib/notes");

const DIST = path.join(ROOT, "dist");
const SITE_FILES = ["index.html", "styles.css", "app.js"];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function emptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

emptyDir(DIST);

for (const file of SITE_FILES) {
  fs.copyFileSync(path.join(ROOT, file), path.join(DIST, file));
}

if (fs.existsSync(NOTES_DIR)) {
  copyDir(NOTES_DIR, path.join(DIST, "notes"));
}

const payload = { notes: listNotes() };
fs.writeFileSync(path.join(DIST, "notes.json"), JSON.stringify(payload, null, 2));
fs.writeFileSync(path.join(ROOT, "notes.json"), JSON.stringify(payload, null, 2));

console.log(`Built ${payload.notes.length} note(s) → dist/`);
