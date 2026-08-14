(() => {
  const topicList = document.getElementById("topic-list");
  const article = document.getElementById("article");
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");

  let notes = [];

  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  function setPlaceholder(message, isError = false) {
    article.innerHTML = `<p class="${isError ? "error" : "placeholder"}">${message}</p>`;
  }

  function getNoteByHash() {
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!id) return notes[0] || null;
    return notes.find((note) => note.id === id) || null;
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
    return `
      <li>
        <a href="#${encodeURIComponent(note.id)}" class="${active}" data-id="${escapeHtml(note.id)}">
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

  async function loadNote(note) {
    if (!note) {
      setPlaceholder("No notes found. Drop a .md file into the notes/ folder, then refresh.");
      renderNav(null);
      return;
    }

    renderNav(note.id);
    setPlaceholder("Loading…");

    try {
      const response = await fetch(encodeURI(note.file));
      if (!response.ok) {
        throw new Error(`Could not load ${note.file} (${response.status})`);
      }
      const markdown = await response.text();
      article.innerHTML = marked.parse(markdown);
      if (window.hljs) {
        article.querySelectorAll("pre code").forEach((block) => {
          window.hljs.highlightElement(block);
        });
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setPlaceholder(error.message || "Failed to load note.", true);
    }
  }

  function syncFromHash() {
    const note = getNoteByHash();
    if (!location.hash && note) {
      history.replaceState(null, "", `#${encodeURIComponent(note.id)}`);
    }
    loadNote(note);
  }

  sidebarToggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open");
    sidebarToggle.setAttribute("aria-expanded", String(open));
  });

  topicList.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 860px)").matches) {
      sidebar.classList.remove("open");
      sidebarToggle.setAttribute("aria-expanded", "false");
    }
  });

  window.addEventListener("hashchange", syncFromHash);

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
      syncFromHash();
    } catch (error) {
      setPlaceholder(
        `${error.message}. Locally run node server.js. Hosted builds use notes.json.`,
        true
      );
    }
  }

  init();
})();
