const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { ROOT, NOTES_DIR, listNotes } = require("./lib/notes");

const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(text);
}

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded.replace(/^\/+/, "") || "index.html";
  const resolved = path.normalize(path.join(ROOT, relative));
  const fromRoot = path.relative(ROOT, resolved);
  if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/notes") {
    try {
      return sendJson(res, 200, { notes: listNotes() });
    } catch (error) {
      return sendJson(res, 500, { error: error.message || "Failed to list notes" });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendText(res, 405, "Method Not Allowed");
  }

  const filePath = safeResolve(url.pathname);
  if (!filePath) {
    return sendText(res, 403, "Forbidden");
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return sendText(res, 404, "Not Found");
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    if (req.method === "HEAD") {
      return res.end();
    }
    fs.createReadStream(filePath).pipe(res);
  });
});

if (!fs.existsSync(NOTES_DIR)) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
}

server.listen(PORT, () => {
  console.log(`Interview Notes running at http://localhost:${PORT}`);
  console.log(`Drop .md files into ${NOTES_DIR} (subfolders OK), then refresh.`);
});
