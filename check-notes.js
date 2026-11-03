const fs = require("fs");
const path = require("path");
const { ROOT, NOTES_DIR, walkMarkdownFiles } = require("./lib/notes");

function supportedVisualizers() {
  const source = fs.readFileSync(path.join(ROOT, "visualizers.js"), "utf8");
  const at = source.indexOf('getAttribute("data-visualizer")');
  const slice = at === -1 ? "" : source.slice(at, at + 600);
  const names = new Set(
    [...slice.matchAll(/\bkind\s*(?:===|!==)\s*"([^"]+)"/g)].map((match) => match[1])
  );
  if (!names.size) {
    console.error("visualizers.js:1: could not read visualizer names");
    process.exit(1);
  }
  return names;
}

function noteLink(destination) {
  let url = destination.trim();
  if (!url) return null;
  if (url.startsWith("<")) {
    const end = url.indexOf(">");
    url = end === -1 ? url.slice(1) : url.slice(1, end);
  } else {
    url = url.split(/\s+/)[0];
  }
  if (!url || url.startsWith("#") || url.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const filePart = url.split("#")[0].split("?")[0];
  if (!filePart.toLowerCase().endsWith(".md")) return null;
  try {
    return decodeURI(filePart);
  } catch {
    return filePart;
  }
}

function checkNote(file, visualizers) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const problems = [];
  let open = null;
  let heading = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    const ticks = trimmed.match(/^(`{3,})(.*)$/);

    if (open) {
      if (ticks && ticks[2].trim() === "" && ticks[1].length >= open.length) open = null;
      continue;
    }

    if (ticks && !ticks[2].includes("`")) {
      const info = ticks[2].trim();
      open = { line: lineNo, length: ticks[1].length };
      if (info === "visualizer" || info.startsWith("visualizer ") || info.startsWith("visualizer\t")) {
        const name = info.slice("visualizer".length).trim();
        if (!visualizers.has(name)) {
          problems.push(`${rel}:${lineNo}: unknown visualizer "${name}"`);
        }
      }
      continue;
    }

    if (/^#\s+\S/.test(trimmed)) heading = true;

    const linkRe = /\[([^\]]*)\]\(([^)]*)\)/g;
    let match;
    while ((match = linkRe.exec(line))) {
      if (match.index > 0 && line[match.index - 1] === "!") continue;
      const target = noteLink(match[2]);
      if (!target) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        problems.push(`${rel}:${lineNo}: missing note ${target}`);
      }
    }
  }

  if (open) problems.push(`${rel}:${open.line}: unclosed code fence`);
  if (!heading) problems.push(`${rel}:1: no # heading`);
  return problems;
}

const visualizers = supportedVisualizers();
const problems = walkMarkdownFiles(NOTES_DIR).flatMap((file) => checkNote(file, visualizers));
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
