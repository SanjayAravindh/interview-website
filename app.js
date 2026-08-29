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

  function groupNotesByFolder(list) {
    const groups = new Map();
    for (const note of list) {
      const folder = note.description || "Notes";
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(note);
    }
    return groups;
  }

  function noteLink(note, activeId) {
    const active = note.id === activeId ? "active" : "";
    const href = `?note=${encodeURIComponent(note.id)}`;
    return `
      <li>
        <a href="${href}" class="${active}" data-id="${escapeHtml(note.id)}">
          ${escapeHtml(note.title)}
        </a>
      </li>
    `;
  }

  function renderNav(activeId) {
    const groups = groupNotesByFolder(notes);
    const html = [];
    for (const [folder, folderNotes] of groups) {
      html.push(`<li class="topic-group">
        <p class="topic-group-label">${escapeHtml(folder)}</p>
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
      slugState.used = new Set();
      article.innerHTML = marked.parse(markdown);
      if (window.hljs) {
        article.querySelectorAll("pre code").forEach((block) => {
          window.hljs.highlightElement(block);
        });
      }
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
    scrollToHeading(id);
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
      notes = Array.isArray(data.notes) ? data.notes : [];
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
