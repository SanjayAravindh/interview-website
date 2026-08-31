(() => {
  const topicList = document.getElementById("topic-list");
  const article = document.getElementById("article");
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");

  let notes = [];
  let currentNote = null;
  const slugState = { used: new Set() };

  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  marked.use({
    renderer: {
      heading(arg, level) {
        if (typeof arg === "string") {
          const slug = headingSlug(arg);
          return `<h${level} id="${escapeHtml(slug)}">${arg}</h${level}>\n`;
        }
        const text = this.parser.parseInline(arg.tokens);
        const slug = headingSlug(arg.text);
        return `<h${arg.depth} id="${escapeHtml(slug)}">${text}</h${arg.depth}>\n`;
      },
    },
  });

  function headingSlug(text) {
    const base = String(text)
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section";
    let slug = base;
    let n = 1;
    while (slugState.used.has(slug)) {
      slug = `${base}-${n++}`;
    }
    slugState.used.add(slug);
    return slug;
  }

  function setPlaceholder(message, isError = false) {
    article.innerHTML = `<p class="${isError ? "error" : "placeholder"}">${message}</p>`;
  }

  function hashId() {
    try {
      return decodeURIComponent(location.hash.replace(/^#/, ""));
    } catch {
      return location.hash.replace(/^#/, "");
    }
  }

  function findNoteById(id) {
    if (!id) return null;
    return notes.find((note) => note.id === id) || null;
  }

  function noteIdFromUrl() {
    const fromQuery = new URLSearchParams(location.search).get("note");
    if (fromQuery) return fromQuery;
    const fromHash = hashId();
    return findNoteById(fromHash) ? fromHash : null;
  }

  function noteUrl(noteId, headingId) {
    const url = new URL(location.href);
    url.searchParams.set("note", noteId);
    url.hash = headingId ? headingId : "";
    return url;
  }

  function compareCurriculum(a, b) {
    const folderA = a.description || "Notes";
    const folderB = b.description || "Notes";
    const folderOrderA = a.folderOrder ?? 9999;
    const folderOrderB = b.folderOrder ?? 9999;
    if (folderOrderA !== folderOrderB) return folderOrderA - folderOrderB;
    const noteOrderA = a.noteOrder ?? 9999;
    const noteOrderB = b.noteOrder ?? 9999;
    if (noteOrderA !== noteOrderB) return noteOrderA - noteOrderB;
    return folderA.localeCompare(folderB) || a.id.localeCompare(b.id);
  }

  function groupNotesByFolder(list) {
    const sorted = [...list].sort(compareCurriculum);
    const groups = new Map();
    for (const note of sorted) {
      const folder = note.description || "Notes";
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(note);
    }
    return groups;
  }

  function groupDisplayLabel(folder, folderNotes) {
    const fromNote = folderNotes[0]?.groupLabel;
    return fromNote || folder;
  }

  function sidebarTitle(title) {
    let t = String(title).trim();
    const emDash = t.indexOf(" — ");
    if (emDash !== -1) {
      t = t.slice(0, emDash).trim();
    } else {
      const colon = t.indexOf(": ");
      if (colon !== -1) {
        t = t.slice(0, colon).trim();
      }
    }
    t = t.replace(/^Senior-Level\s+/i, "");
    t = t.replace(/^Master\s+/i, "");
    t = t.replace(/\s+Mastery$/i, "");
    t = t.replace(/\s+Course$/i, "");
    return t.trim();
  }

  function noteLink(note, activeId) {
    const active = note.id === activeId ? "active" : "";
    const href = `?note=${encodeURIComponent(note.id)}`;
    const label = sidebarTitle(note.title);
    return `
      <li>
        <a href="${href}" class="${active}" data-id="${escapeHtml(note.id)}">
          ${escapeHtml(label)}
        </a>
      </li>
    `;
  }

  function renderNav(activeId) {
    const groups = groupNotesByFolder(notes);
    const html = [];
    const folderKeys = [...groups.keys()].sort((a, b) => {
      const orderA = groups.get(a)[0]?.folderOrder ?? 9999;
      const orderB = groups.get(b)[0]?.folderOrder ?? 9999;
      return orderA - orderB || a.localeCompare(b);
    });
    for (const folder of folderKeys) {
      const folderNotes = groups.get(folder);
      html.push(`<li class="topic-group">
        <p class="topic-group-label">${escapeHtml(groupDisplayLabel(folder, folderNotes))}</p>
        <ul class="topic-group-list">
          ${folderNotes.map((note) => noteLink(note, activeId)).join("")}
        </ul>
      </li>`);
    }
    topicList.innerHTML = html.join("");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderQAHtml(qaItems) {
    let html = "<hr><h2 id=\"practice-questions-answers\">Practice Questions & Answers</h2>";
    for (const item of qaItems) {
      const answerHtml = item.answerMd ? marked.parse(item.answerMd) : "";
      html += `<details class="qa-item"><summary>${item.summary}</summary><div class="qa-answer">${answerHtml}</div></details>`;
    }
    return html;
  }

  function extractDetailsBlocks(md) {
    const items = [];
    const re = /<details class="qa-item">\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/gi;
    let body = md;
    let match;
    while ((match = re.exec(md)) !== null) {
      items.push({ summary: match[1].trim(), answerMd: match[2].trim() });
    }
    body = body.replace(re, "");
    body = body.replace(/\n## Practice Questions & Answers\s*/gi, "\n");
    return { body: body.trim(), items };
  }

  function isTocHeading(text, docTitle) {
    if (docTitle && text === docTitle) return false;
    if (/^\d+\.\s/.test(text)) return true;
    if (/^Part\s+\d+/i.test(text)) return true;
    if (/^Concept\s+\d+/i.test(text)) return true;
    if (/^JAVA\s+\d+/i.test(text)) return true;
    if (/^(Quick|Most-Asked|Roadmap)/i.test(text)) return true;
    return false;
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
      out.push(line);
    }

    return out.join("\n");
  }

  function stripTocLabel(text) {
    return String(text)
      .trim()
      .replace(/^\d+\.\s+/, "");
  }

  function insertTableOfContents(md) {
    if (/^##\s+Table of Contents\s*$/im.test(md)) return md;

    const docTitle = md.match(/^#\s+(.+)/)?.[1]?.trim();
    const headings = [];
    for (const line of md.split("\n")) {
      const m = line.match(/^(#{1,2})\s+(.+)$/);
      if (!m) continue;
      const text = m[2].trim();
      if (/^table of contents$/i.test(text)) continue;
      if (/^practice questions/i.test(text)) continue;
      if (!isTocHeading(text, docTitle)) continue;
      headings.push({ text });
    }
    if (headings.length < 2) return md;

    const items = headings.map((h, idx) => {
      const label = stripTocLabel(h.text);
      return `${idx + 1}. [${label}](#${headingSlug(h.text)})`;
    });
    const tocBlock = `## Table of Contents\n\n${items.join("\n")}\n\n---\n`;
    const firstHr = md.indexOf("\n---\n");
    if (firstHr !== -1) {
      return `${md.slice(0, firstHr + 5)}\n${tocBlock}\n${md.slice(firstHr + 5)}`;
    }
    const titleMatch = md.match(/^#\s+.+\n+/);
    if (titleMatch) {
      const pos = titleMatch[0].length;
      return `${md.slice(0, pos)}\n---\n\n${tocBlock}\n${md.slice(pos)}`;
    }
    return `${tocBlock}\n${md}`;
  }

  function renderMarkdownWithQA(markdown) {
    const { body, items } = extractDetailsBlocks(markdown);
    const prepared = insertTableOfContents(body);
    slugState.used = new Set();
    let html = marked.parse(prepared);
    if (items.length) {
      html += renderQAHtml(items);
    }
    return html;
  }

  function highlightCode(root) {
    if (!window.hljs) return;
    root.querySelectorAll("pre code").forEach((block) => {
      window.hljs.highlightElement(block);
    });
  }

  function scrollToHeading(id) {
    if (!id) return false;
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  }

  async function loadNote(note, headingId) {
    if (!note) {
      setPlaceholder("No notes found. Drop a .md file into the notes/ folder, then refresh.");
      renderNav(null);
      return;
    }

    currentNote = note;
    renderNav(note.id);
    setPlaceholder("Loading…");

    try {
      const response = await fetch(encodeURI(note.file), { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Could not load ${note.file} (${response.status})`);
      }
      const markdown = await response.text();
      article.innerHTML = renderMarkdownWithQA(markdown);
      highlightCode(article);
      if (headingId) {
        scrollToHeading(headingId);
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch (error) {
      setPlaceholder(error.message || "Failed to load note.", true);
    }
  }

  function headingFromHash() {
    const id = hashId();
    return id && !findNoteById(id) ? id : "";
  }

  async function syncFromLocation({ replace = false } = {}) {
    const selectedId = noteIdFromUrl();
    const note = findNoteById(selectedId) || notes[0] || null;
    const heading = headingFromHash();

    if (note) {
      const url = noteUrl(note.id, heading);
      const method = replace ? "replaceState" : "pushState";
      const current = location.pathname + location.search + location.hash;
      const next = url.pathname + url.search + url.hash;
      if (current !== next) {
        history[method]({ note: note.id }, "", url);
      }
    }

    if (note && currentNote && currentNote.id === note.id) {
      if (heading) scrollToHeading(heading);
      else window.scrollTo({ top: 0, behavior: "smooth" });
      renderNav(note.id);
      return;
    }

    await loadNote(note, heading);
  }

  sidebarToggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open");
    sidebarToggle.setAttribute("aria-expanded", String(open));
  });

  topicList.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-id]");
    if (!link) return;
    event.preventDefault();
    const note = findNoteById(link.dataset.id);
    if (!note) return;
    const url = noteUrl(note.id);
    history.pushState({ note: note.id }, "", url);
    loadNote(note);
    if (window.matchMedia("(max-width: 860px)").matches) {
      sidebar.classList.remove("open");
      sidebarToggle.setAttribute("aria-expanded", "false");
    }
  });

  article.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href || !href.startsWith("#")) return;
    event.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const note = findNoteById(id);
    if (note) {
      history.pushState({ note: note.id }, "", noteUrl(note.id));
      loadNote(note);
      return;
    }
    if (currentNote) {
      history.pushState({ note: currentNote.id }, "", noteUrl(currentNote.id, id));
    } else {
      history.pushState(null, "", `#${encodeURIComponent(id)}`);
    }
    if (!scrollToHeading(id)) {
      /* anchor missing — stale TOC or duplicate heading slug */
    }
  });

  window.addEventListener("hashchange", () => {
    const id = hashId();
    if (findNoteById(id) && !new URLSearchParams(location.search).get("note")) {
      syncFromLocation({ replace: true });
      return;
    }
    if (id && !findNoteById(id)) {
      scrollToHeading(id);
    }
  });

  window.addEventListener("popstate", () => {
    syncFromLocation({ replace: true });
  });

  async function loadNotesIndex() {
    const sources = ["api/notes", "notes.json"];
    let lastError = "Could not load notes";
    for (const url of sources) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          lastError = `Could not load ${url} (${response.status})`;
          continue;
        }
        return await response.json();
      } catch (error) {
        lastError = error.message || lastError;
      }
    }
    throw new Error(lastError);
  }

  async function init() {
    try {
      const data = await loadNotesIndex();
      notes = Array.isArray(data.notes) ? data.notes.sort(compareCurriculum) : [];
      if (!notes.length) {
        setPlaceholder("No markdown files yet. Add .md files under notes/ (subfolders are fine), then refresh.");
        renderNav(null);
        return;
      }
      await syncFromLocation({ replace: true });
    } catch (error) {
      setPlaceholder(
        `${error.message}. Locally run node server.js. Hosted builds use notes.json.`,
        true
      );
    }
  }

  init();
})();
