(() => {
  const topicList = document.getElementById("topic-list");
  const article = document.getElementById("article");
  const content = document.getElementById("content");
  const searchForm = document.getElementById("site-search");
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");
  const noteCount = document.getElementById("note-count");
  const readerGroup = document.getElementById("reader-group");
  const readerTitle = document.getElementById("reader-title");
  const readerProgress = document.getElementById("reader-progress");

  let notes = [];
  let currentNote = null;
  let searchDocs = [];
  let searchReady = false;
  let searchTimer = 0;
  let activeResult = -1;
  let tocSpyLinks = [];
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
    article.classList.remove("is-ready");
    if (!isError && message === "Loading…") {
      article.innerHTML = `
        <div class="article-skeleton" aria-busy="true">
          <span class="sk sk-title"></span>
          <span class="sk sk-line"></span>
          <span class="sk sk-line"></span>
          <span class="sk sk-line short"></span>
          <span class="sk sk-line"></span>
          <span class="visually-hidden">Loading note</span>
        </div>`;
      return;
    }
    article.innerHTML = `<p class="${isError ? "error" : "placeholder"}">${message}</p>`;
  }

  function updateReaderChrome(note) {
    if (!note) {
      readerGroup.textContent = "";
      readerTitle.textContent = "Choose a topic";
      readerProgress.style.width = "0%";
      return;
    }
    const folder = note.description || "Notes";
    const folderNotes = notes.filter((item) => (item.description || "Notes") === folder);
    readerGroup.textContent = groupDisplayLabel(folder, folderNotes.length ? folderNotes : [note]);
    readerTitle.textContent = sidebarTitle(note.title);
  }

  function updateReadingProgress() {
    const max = content.scrollHeight - content.clientHeight;
    const pct = max <= 0 ? 0 : Math.min(100, (content.scrollTop / max) * 100);
    readerProgress.style.width = `${pct}%`;
    updateHeadingSpy();
  }

  function updateHeadingSpy() {
    if (!tocSpyLinks.length) return;
    const probe = content.getBoundingClientRect().top + 72;
    let current = tocSpyLinks[0];
    for (const link of tocSpyLinks) {
      const id = decodeURIComponent(link.getAttribute("href").slice(1));
      const heading = document.getElementById(id);
      if (!heading) continue;
      if (heading.getBoundingClientRect().top <= probe) current = link;
    }
    tocSpyLinks.forEach((link) => link.classList.toggle("toc-current", link === current));
  }

  function bindHeadingSpy() {
    tocSpyLinks = [];
    const tocHeading = article.querySelector("#table-of-contents");
    if (!tocHeading) return;
    let list = tocHeading.nextElementSibling;
    while (list && list.tagName !== "OL" && list.tagName !== "UL") {
      list = list.nextElementSibling;
    }
    if (!list) return;
    tocSpyLinks = [...list.querySelectorAll('a[href^="#"]')];
    tocSpyLinks.forEach((link) => link.classList.add("toc-link"));
    updateHeadingSpy();
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

  function noteUrl(noteId, headingId, query) {
    const url = new URL(location.href);
    url.searchParams.set("note", noteId);
    const q = query === undefined ? new URLSearchParams(location.search).get("q") : query;
    if (q) url.searchParams.set("q", q);
    else url.searchParams.delete("q");
    url.hash = headingId ? headingId : "";
    return url;
  }

  function currentSearchQuery() {
    return (new URLSearchParams(location.search).get("q") || "").trim();
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
        <p class="topic-group-label">
          <span>${escapeHtml(groupDisplayLabel(folder, folderNotes))}</span>
          <span class="topic-group-count">${folderNotes.length}</span>
        </p>
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
    const top =
      el.getBoundingClientRect().top -
      content.getBoundingClientRect().top +
      content.scrollTop -
      16;
    content.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    return true;
  }

  async function loadNote(note, headingId) {
    if (!note) {
      updateReaderChrome(null);
      setPlaceholder("No notes found. Drop a .md file into the notes/ folder, then refresh.");
      renderNav(null);
      return;
    }

    currentNote = note;
    renderNav(note.id);
    updateReaderChrome(note);
    setPlaceholder("Loading…");
    content.scrollTo({ top: 0 });

    try {
      const response = await fetch(encodeURI(note.file), { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Could not load ${note.file} (${response.status})`);
      }
      const markdown = await response.text();
      article.innerHTML = renderMarkdownWithQA(markdown);
      article.classList.add("is-ready");
      highlightCode(article);
      highlightArticleQuery(currentSearchQuery());
      bindHeadingSpy();
      if (headingId) {
        scrollToHeading(headingId);
      } else {
        content.scrollTo({ top: 0, behavior: "smooth" });
      }
      updateReadingProgress();
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
      updateReaderChrome(note);
      if (heading) scrollToHeading(heading);
      else content.scrollTo({ top: 0, behavior: "smooth" });
      renderNav(note.id);
      return;
    }

    await loadNote(note, heading);
  }

  topicList.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-id]");
    if (!link) return;
    event.preventDefault();
    const note = findNoteById(link.dataset.id);
    if (!note) return;
    const url = noteUrl(note.id);
    history.pushState({ note: note.id }, "", url);
    loadNote(note);
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

  function tokenizeQuery(raw) {
    return String(raw)
      .toLowerCase()
      .split(/[^\p{L}\p{N}_+-]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
  }

  function snippetAround(text, tokens) {
    const lower = text.toLowerCase();
    let idx = -1;
    let matched = tokens[0] || "";
    for (const token of tokens) {
      const at = lower.indexOf(token);
      if (at !== -1) {
        idx = at;
        matched = token;
        break;
      }
    }
    if (idx === -1) {
      return escapeHtml(text.slice(0, 160)) + (text.length > 160 ? "…" : "");
    }
    const start = Math.max(0, idx - 48);
    const end = Math.min(text.length, idx + matched.length + 90);
    const slice = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    return highlightPlain(slice, tokens);
  }

  function highlightPlain(text, tokens) {
    const escaped = escapeHtml(text);
    if (!tokens.length) return escaped;
    const pattern = tokens
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    return escaped.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
  }

  function searchNotes(raw) {
    const tokens = tokenizeQuery(raw);
    if (!tokens.length || !searchDocs.length) return [];

    const hits = [];
    for (const doc of searchDocs) {
      const titleLower = doc.title.toLowerCase();
      const titleScore = tokens.every((t) => titleLower.includes(t)) ? 50 : 0;
      if (titleScore) {
        hits.push({
          noteId: doc.id,
          title: doc.title,
          group: doc.group,
          heading: doc.title,
          headingId: "",
          snippet: highlightPlain(doc.title, tokens),
          score: titleScore + (titleLower.startsWith(tokens[0]) ? 10 : 0),
        });
      }

      for (const section of doc.sections || []) {
        const headingLower = (section.heading || "").toLowerCase();
        const bodyLower = (section.text || "").toLowerCase();
        const headingHit = tokens.every((t) => headingLower.includes(t));
        const bodyHit = tokens.every((t) => bodyLower.includes(t));
        const mixedHit =
          !headingHit &&
          !bodyHit &&
          tokens.every((t) => headingLower.includes(t) || bodyLower.includes(t));
        if (!headingHit && !bodyHit && !mixedHit) continue;

        const score =
          (headingHit ? 30 : 0) +
          (bodyHit ? 12 : 0) +
          (mixedHit ? 6 : 0) +
          (titleScore ? 4 : 0);
        hits.push({
          noteId: doc.id,
          title: doc.title,
          group: doc.group,
          heading: section.heading || doc.title,
          headingId: section.headingId || "",
          snippet: headingHit
            ? highlightPlain(section.heading, tokens)
            : snippetAround(section.text || section.heading, tokens),
          score,
        });
      }
    }

    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const seen = new Set();
    const unique = [];
    for (const hit of hits) {
      const key = `${hit.noteId}#${hit.headingId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(hit);
      if (unique.length >= 24) break;
    }
    return unique;
  }

  function renderSearchResults(query, hits) {
    if (!query.trim()) {
      searchResults.hidden = true;
      searchResults.innerHTML = "";
      searchInput.setAttribute("aria-expanded", "false");
      activeResult = -1;
      return;
    }

    searchResults.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
    if (!searchReady) {
      searchResults.innerHTML = `<p class="search-status">Loading search index…</p>`;
      return;
    }
    if (!hits.length) {
      searchResults.innerHTML = `<p class="search-empty">No matches for “${escapeHtml(query.trim())}”.</p>`;
      activeResult = -1;
      return;
    }

    searchResults.innerHTML = hits
      .map(
        (hit, index) => `
      <button type="button" class="search-result" role="option" data-index="${index}"
        data-note="${escapeHtml(hit.noteId)}" data-heading="${escapeHtml(hit.headingId)}"
        style="--i:${index}" aria-selected="${index === activeResult}">
        <span class="search-result-note">${escapeHtml(hit.group)} · ${escapeHtml(sidebarTitle(hit.title))}</span>
        <span class="search-result-heading">${escapeHtml(hit.heading)}</span>
        <span class="search-result-snippet">${hit.snippet}</span>
      </button>`
      )
      .join("");
  }

  function setActiveResult(index) {
    const buttons = [...searchResults.querySelectorAll(".search-result")];
    if (!buttons.length) return;
    activeResult = (index + buttons.length) % buttons.length;
    buttons.forEach((btn, i) => btn.setAttribute("aria-selected", String(i === activeResult)));
    buttons[activeResult].scrollIntoView({ block: "nearest" });
  }

  async function openSearchHit(noteId, headingId, query) {
    const note = findNoteById(noteId);
    if (!note) return;
    const url = noteUrl(note.id, headingId, query);
    history.pushState({ note: note.id }, "", url);
    searchResults.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    await loadNote(note, headingId);
  }

  function highlightArticleQuery(raw) {
    const tokens = tokenizeQuery(raw);
    article.querySelectorAll("mark.search-hit").forEach((mark) => {
      mark.replaceWith(document.createTextNode(mark.textContent));
    });
    if (!tokens.length) return;

    const pattern = new RegExp(
      `(${tokens
        .slice()
        .sort((a, b) => b.length - a.length)
        .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})`,
      "gi"
    );
    const skip = new Set(["SCRIPT", "STYLE", "CODE"]);
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || skip.has(parent.tagName)) continue;
      if (!pattern.test(walker.currentNode.nodeValue)) {
        pattern.lastIndex = 0;
        continue;
      }
      pattern.lastIndex = 0;
      nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      text.replace(pattern, (match, _g, offset) => {
        if (offset > last) frag.append(text.slice(last, offset));
        const mark = document.createElement("mark");
        mark.className = "search-hit";
        mark.textContent = match;
        frag.append(mark);
        last = offset + match.length;
        return match;
      });
      if (last < text.length) frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }

  async function loadSearchIndex() {
    const sources = ["api/search-index", "search-index.json"];
    for (const url of sources) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) continue;
        const data = await response.json();
        searchDocs = Array.isArray(data.documents) ? data.documents : [];
        searchReady = true;
        if (searchInput.value.trim()) {
          renderSearchResults(searchInput.value, searchNotes(searchInput.value));
        }
        return;
      } catch {
        /* try next source */
      }
    }
    searchReady = true;
    searchDocs = [];
  }

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const buttons = searchResults.querySelectorAll(".search-result");
    const chosen = buttons[activeResult] || buttons[0];
    if (!chosen) return;
    openSearchHit(chosen.dataset.note, chosen.dataset.heading, searchInput.value.trim());
  });

  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      activeResult = -1;
      renderSearchResults(searchInput.value, searchNotes(searchInput.value));
    }, 120);
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResult(activeResult + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResult(activeResult - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const buttons = searchResults.querySelectorAll(".search-result");
      const chosen = buttons[activeResult] || buttons[0];
      if (chosen) {
        openSearchHit(chosen.dataset.note, chosen.dataset.heading, searchInput.value.trim());
      }
    } else if (event.key === "Escape") {
      searchResults.hidden = true;
      searchInput.setAttribute("aria-expanded", "false");
      searchInput.blur();
    }
  });

  searchResults.addEventListener("mousedown", (event) => {
    const button = event.target.closest(".search-result");
    if (!button) return;
    event.preventDefault();
    openSearchHit(button.dataset.note, button.dataset.heading, searchInput.value.trim());
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && event.target !== searchInput && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const tag = event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  document.addEventListener("click", (event) => {
    if (!searchForm.contains(event.target)) {
      searchResults.hidden = true;
      searchInput.setAttribute("aria-expanded", "false");
    }
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
      loadSearchIndex();
      if (notes.length) {
        noteCount.hidden = false;
        noteCount.textContent = `${notes.length} topics`;
      }
      if (!notes.length) {
        setPlaceholder("No markdown files yet. Add .md files under notes/ (subfolders are fine), then refresh.");
        renderNav(null);
        return;
      }
      const existingQ = currentSearchQuery();
      if (existingQ) searchInput.value = existingQ;
      await syncFromLocation({ replace: true });
    } catch (error) {
      setPlaceholder(
        `${error.message}. Locally run node server.js. Hosted builds use notes.json.`,
        true
      );
    }
  }

  content.addEventListener("scroll", updateReadingProgress, { passive: true });

  init();
})();
