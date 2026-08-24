(function () {
  "use strict";

  const {
    escapeHtml,
    artistDetailHref,
    artistLinksHtml,
    wikiLinkHtml,
    makeFavButton,
    getFavoriteIds,
    shuffled,
    describeFilter,
    filterArtworksPool,
    showEmptyState,
    hideEmptyState,
    initHoverPreview,
    buildArtworkCard,
  } = window.MuseumShared;

  const STORAGE_KEY = "museumFlashcards.stats.v3";

  function loadStats() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveStats(stats) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  }

  let stats = loadStats();

  function blankFieldStat() {
    return { right: 0, wrong: 0 };
  }

  function statFor(id) {
    if (!stats[id]) {
      stats[id] = {
        artist: blankFieldStat(),
        title: blankFieldStat(),
        decade: blankFieldStat(),
        lastAttempt: null,
        lastSeen: null,
      };
    }
    return stats[id];
  }

  function recordAttempt(id, result) {
    const s = statFor(id);
    ["artist", "title", "decade"].forEach((field) => {
      if (result[field].graded) {
        if (result[field].correct) s[field].right += 1;
        else s[field].wrong += 1;
      }
    });
    s.lastAttempt = {
      artistGuess: result.artist.guess,
      titleGuess: result.title.guess,
      decadeGuess: result.decade.guess,
    };
    s.lastSeen = new Date().toISOString();
    saveStats(stats);
  }

  // correctValue/correctValueHtml are only shown when the guess was graded
  // and wrong. correctValueHtml (already-safe markup, e.g. artist links)
  // takes priority over the plain-text correctValue when both are given.
  function markResult(el, graded, correct, correctValue, correctValueHtml) {
    if (!graded) {
      el.textContent = "not graded";
      el.className = "guess-result skipped";
      return;
    }
    if (correct) {
      el.textContent = "✓ correct";
      el.className = "guess-result correct";
    } else if (correctValueHtml) {
      el.innerHTML = `✗ incorrect — ${correctValueHtml}`;
      el.className = "guess-result incorrect";
    } else {
      el.textContent = correctValue ? `✗ incorrect — ${correctValue}` : "✗ incorrect";
      el.className = "guess-result incorrect";
    }
  }

  // Favorites storage/toggling now lives in shared.js (window.MuseumShared)
  // since the per-artist detail pages need it too. This page just reacts
  // when a favorite changes anywhere, to keep the Favorites tab in sync if
  // it's the one currently showing.
  document.addEventListener("museum:favoritechange", () => {
    if (tabPanels.favorites.classList.contains("active")) renderFavorites();
  });

  // ---------- Tabs / routing ----------
  // Each tab has a matching URL path (e.g. .../quiz/) backed by an identical
  // index.html copy in that directory, so direct navigation and refresh work
  // with a plain static file server — no server-side rewrite rules needed.
  // In-app nav clicks use the History API so switching tabs doesn't reload.
  //
  // The site's base path is computed at load time instead of assumed to be
  // "/", so this works unmodified whether served from a domain root (e.g.
  // `python -m http.server` from this folder) or a subpath (e.g. GitHub
  // Pages project sites at /reponame/).

  const TAB_SLUGS = { quiz: "quiz", study: "study", favorites: "favorites", stats: "stats", artists: "artists" };
  const SLUG_TABS = { quiz: "quiz", study: "study", favorites: "favorites", stats: "stats", artists: "artists" };

  function computeBasePath() {
    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments.length && SLUG_TABS[segments[segments.length - 1]]) {
      segments.pop();
    }
    return segments.length ? `/${segments.join("/")}/` : "/";
  }

  const BASE_PATH = computeBasePath();

  function tabFromPath(pathname) {
    const segments = pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    return SLUG_TABS[lastSegment] || "study";
  }

  const navButtons = document.querySelectorAll(".nav-btn");
  const tabPanels = {
    quiz: document.getElementById("quiz-tab"),
    study: document.getElementById("study-tab"),
    favorites: document.getElementById("favorites-tab"),
    stats: document.getElementById("stats-tab"),
    artists: document.getElementById("artists-tab"),
  };

  function activateTab(name, opts) {
    opts = opts || {};
    navButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    Object.entries(tabPanels).forEach(([key, panel]) => panel.classList.toggle("active", key === name));
    if (name === "stats") renderStats();
    if (name === "favorites") renderFavorites();
    if (name === "artists") renderAllArtists();

    const path = `${BASE_PATH}${TAB_SLUGS[name]}/`;
    if (opts.replaceHistory) {
      history.replaceState(null, "", path);
    } else if (!opts.skipHistory && window.location.pathname !== path) {
      history.pushState(null, "", path);
    }
  }

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  window.addEventListener("popstate", () => {
    activateTab(tabFromPath(window.location.pathname), { skipHistory: true });
  });

  // ---------- Type / decade filter options ----------

  function countBy(getKeys) {
    const counts = new Map();
    ARTWORKS.forEach((a) => {
      getKeys(a).forEach((k) => {
        if (!k) return;
        counts.set(k, (counts.get(k) || 0) + 1);
      });
    });
    return counts;
  }

  const typeCounts = countBy((a) => a.types);
  const decadeCounts = countBy((a) => [a.decade]);

  function populateFilter(selectEl, counts, sortFn) {
    Array.from(counts.keys())
      .sort(sortFn)
      .forEach((key) => {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = `${key} (${counts.get(key)})`;
        selectEl.appendChild(opt);
      });
  }

  const byCountDesc = (counts) => (a, b) => counts.get(b) - counts.get(a);
  const alphabetically = (a, b) => a.localeCompare(b);

  const quizTypeFilter = document.getElementById("quiz-type-filter");
  const quizDecadeFilter = document.getElementById("quiz-decade-filter");
  populateFilter(quizTypeFilter, typeCounts, byCountDesc(typeCounts));
  populateFilter(quizDecadeFilter, decadeCounts, alphabetically);

  const studyTypeFilter = document.getElementById("study-type-filter");
  const studyDecadeFilter = document.getElementById("study-decade-filter");
  populateFilter(studyTypeFilter, typeCounts, byCountDesc(typeCounts));
  populateFilter(studyDecadeFilter, decadeCounts, alphabetically);

  // shuffled, initHoverPreview, and the Wikipedia hover tooltip now live in
  // shared.js — the tooltip and the image lightbox wire themselves up
  // automatically there (as long as #image-preview/#wiki-preview exist in
  // this page's HTML), so there's nothing to initialize here beyond
  // calling initHoverPreview(container) per grid, same as before.

  // ---------- Quiz tab ----------

  const QUIZ_SET_SIZE = 9;

  const quizPoolCount = document.getElementById("quiz-pool-count");
  const quizEmpty = document.getElementById("quiz-empty");
  const quizGrid = document.getElementById("quiz-grid");
  const quizSubmitBtn = document.getElementById("quiz-submit-btn");
  const quizNewSetBtn = document.getElementById("quiz-new-set-btn");
  const quizToStudyBtn = document.getElementById("quiz-to-study-btn");
  const quizScore = document.getElementById("quiz-score");

  let quizBatch = [];
  let quizSubmitted = false;

  // Per-field multiset of the batch's true values (e.g. 9 decades, possibly with
  // duplicates) and the current selections, keyed by card index. Options already
  // picked in one card's dropdown are removed from the others of the same field —
  // computed fresh from these two each time, so re-selecting/clearing stays correct.
  let quizPools = { artist: [], title: [], decade: [] };
  let quizSelections = { artist: {}, title: {}, decade: {} };

  function buildQuizPool() {
    // decade is required per-card so the matching game has a full set of options
    return filterArtworksPool({ type: quizTypeFilter.value, decade: quizDecadeFilter.value, requireDecade: true });
  }

  function availableOptions(field, forIdx) {
    const remaining = quizPools[field].slice();
    Object.keys(quizSelections[field]).forEach((idxStr) => {
      const idx = Number(idxStr);
      if (idx === forIdx) return;
      const val = quizSelections[field][idx];
      if (!val) return;
      const pos = remaining.indexOf(val);
      if (pos !== -1) remaining.splice(pos, 1);
    });
    return remaining;
  }

  function refreshFieldSelects(field) {
    quizBatch.forEach((card, idx) => {
      const select = quizGrid.querySelector(`select[data-field="${field}"][data-idx="${idx}"]`);
      if (!select) return;
      const currentVal = select.value;
      select.innerHTML = "";
      select.appendChild(new Option("Choose…", ""));
      availableOptions(field, idx).forEach((v) => select.appendChild(new Option(v, v)));
      select.value = currentVal;
    });
  }

  function makeQuizField(container, label, field, idx) {
    const wrap = document.createElement("label");
    wrap.className = "quiz-field";
    wrap.append(label);

    const select = document.createElement("select");
    select.className = "quiz-select";
    select.dataset.field = field;
    select.dataset.idx = String(idx);
    select.appendChild(new Option("Choose…", ""));
    wrap.appendChild(select);

    const result = document.createElement("span");
    result.className = "guess-result";
    result.id = `quiz-result-${field}-${idx}`;
    wrap.appendChild(result);

    container.appendChild(wrap);
  }

  function renderQuizGrid() {
    quizPools = {
      artist: shuffled(quizBatch.map((c) => c.artist)),
      title: shuffled(quizBatch.map((c) => c.title)),
      decade: quizBatch.map((c) => c.decade).sort(),
    };
    quizSelections = { artist: {}, title: {}, decade: {} };

    quizGrid.innerHTML = "";
    quizBatch.forEach((card, idx) => {
      const div = document.createElement("div");
      div.className = "quiz-card";

      const img = document.createElement("img");
      img.src = card.image;
      img.alt = "";
      img.dataset.id = card.id;
      div.appendChild(img);
      div.appendChild(makeFavButton(card.id));

      makeQuizField(div, "Artist", "artist", idx);
      makeQuizField(div, "Title", "title", idx);
      makeQuizField(div, "Decade", "decade", idx);

      quizGrid.appendChild(div);
    });

    ["artist", "title", "decade"].forEach(refreshFieldSelects);
  }

  quizGrid.addEventListener("change", (e) => {
    const select = e.target.closest(".quiz-select");
    if (!select) return;
    const field = select.dataset.field;
    const idx = Number(select.dataset.idx);
    quizSelections[field][idx] = select.value;
    refreshFieldSelects(field);
  });

  function loadQuizBatch(batch, sourceLabel) {
    quizBatch = batch;
    quizScore.textContent = "";
    quizSubmitted = false;
    hideEmptyState(quizGrid, quizEmpty);
    quizSubmitBtn.classList.remove("hidden");
    quizSubmitBtn.disabled = false;
    quizPoolCount.textContent = sourceLabel;
    renderQuizGrid();
  }

  function newQuizSet() {
    const pool = buildQuizPool();

    if (pool.length < QUIZ_SET_SIZE) {
      quizBatch = [];
      quizScore.textContent = "";
      quizSubmitted = false;
      showEmptyState(quizGrid, quizEmpty);
      quizSubmitBtn.classList.add("hidden");
      quizPoolCount.textContent =
        pool.length > 0 ? `Only ${pool.length} matching works — need at least ${QUIZ_SET_SIZE}.` : "";
      return;
    }

    loadQuizBatch(
      shuffled(pool).slice(0, QUIZ_SET_SIZE),
      `${pool.length} work${pool.length === 1 ? "" : "s"} match ${describeFilter(
        quizTypeFilter.value,
        quizDecadeFilter.value
      )}.`
    );
  }

  function submitQuiz() {
    if (quizSubmitted || quizBatch.length === 0) return;

    const allSelects = Array.from(quizGrid.querySelectorAll(".quiz-select"));
    const anySelected = allSelects.some((s) => s.value.length > 0);
    if (!anySelected) {
      quizScore.textContent = "Choose some answers first.";
      return;
    }

    quizSubmitted = true;
    let rightTotal = 0;
    let gradedTotal = 0;

    quizBatch.forEach((card, idx) => {
      const result = {};
      ["artist", "title", "decade"].forEach((field) => {
        const select = quizGrid.querySelector(`select[data-field="${field}"][data-idx="${idx}"]`);
        const guess = select.value;
        const graded = guess.length > 0;
        const correct = graded && guess === card[field];
        result[field] = { guess, graded, correct };
        if (graded) {
          gradedTotal += 1;
          if (correct) rightTotal += 1;
        }
        const correctValueHtml =
          field === "artist" ? artistLinksHtml(card.artist, card.artistSlugs) : undefined;
        markResult(
          document.getElementById(`quiz-result-${field}-${idx}`),
          graded,
          correct,
          card[field],
          correctValueHtml
        );
        select.disabled = true;
      });
      recordAttempt(card.id, result);
    });

    quizScore.textContent = `${rightTotal} / ${gradedTotal} correct.`;
    quizSubmitBtn.disabled = true;
  }

  quizNewSetBtn.addEventListener("click", newQuizSet);
  quizSubmitBtn.addEventListener("click", submitQuiz);
  quizTypeFilter.addEventListener("change", newQuizSet);
  quizDecadeFilter.addEventListener("change", newQuizSet);
  quizToStudyBtn.addEventListener("click", () => {
    if (quizBatch.length === 0) return;
    loadStudyBatch(quizBatch.slice(), `Showing the ${quizBatch.length} works from Quiz.`);
    activateTab("study");
  });
  initHoverPreview(quizGrid);

  // ---------- Study tab ----------

  const STUDY_SET_SIZE = 9;

  const studyPoolCount = document.getElementById("study-pool-count");
  const studyEmpty = document.getElementById("study-empty");
  const studyGrid = document.getElementById("study-grid");
  const studyNewSetBtn = document.getElementById("study-new-set-btn");
  const studyToQuizBtn = document.getElementById("study-to-quiz-btn");

  let studyBatch = [];

  function renderStudyGrid() {
    studyGrid.innerHTML = "";
    studyBatch.forEach((card) => studyGrid.appendChild(buildArtworkCard(card)));
  }

  function loadStudyBatch(batch, sourceLabel) {
    studyBatch = batch;
    hideEmptyState(studyGrid, studyEmpty);
    studyPoolCount.textContent = sourceLabel;
    renderStudyGrid();
  }

  function newStudySet() {
    // decade is required per-card so a set can always convert into Quiz
    const pool = filterArtworksPool({
      type: studyTypeFilter.value,
      decade: studyDecadeFilter.value,
      requireDecade: true,
    });

    if (pool.length === 0) {
      studyBatch = [];
      showEmptyState(studyGrid, studyEmpty);
      studyPoolCount.textContent = "";
      return;
    }

    const batch = shuffled(pool).slice(0, STUDY_SET_SIZE);
    loadStudyBatch(
      batch,
      `${pool.length} work${pool.length === 1 ? "" : "s"} match ${describeFilter(
        studyTypeFilter.value,
        studyDecadeFilter.value
      )} — showing ${batch.length}.`
    );
  }

  studyNewSetBtn.addEventListener("click", newStudySet);
  studyTypeFilter.addEventListener("change", newStudySet);
  studyDecadeFilter.addEventListener("change", newStudySet);
  studyToQuizBtn.addEventListener("click", () => {
    if (studyBatch.length === 0) return;
    loadQuizBatch(studyBatch.slice(), `Showing the ${studyBatch.length} works from Study.`);
    activateTab("quiz");
  });
  initHoverPreview(studyGrid);

  // ---------- Favorites tab ----------

  const favoritesGrid = document.getElementById("favorites-grid");
  const favoritesEmpty = document.getElementById("favorites-empty");

  function renderFavorites() {
    const byId = new Map(ARTWORKS.map((a) => [a.id, a]));
    const items = getFavoriteIds()
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => a.title.localeCompare(b.title));

    if (items.length === 0) {
      favoritesGrid.innerHTML = "";
      favoritesGrid.classList.add("hidden");
      favoritesEmpty.classList.remove("hidden");
      return;
    }

    favoritesEmpty.classList.add("hidden");
    favoritesGrid.classList.remove("hidden");
    favoritesGrid.innerHTML = "";
    items.forEach((card) => favoritesGrid.appendChild(buildArtworkCard(card)));
  }

  initHoverPreview(favoritesGrid);

  // ---------- Stats tab ----------

  const statsSummary = document.getElementById("stats-summary");
  const statsBody = document.getElementById("stats-body");
  const statsTable = document.getElementById("stats-table");
  const statsEmpty = document.getElementById("stats-empty");

  let sortKey = "overallAcc";
  let sortDir = 1;

  function computeAccuracy(f) {
    const total = f.right + f.wrong;
    return total > 0 ? f.right / total : null;
  }

  function formatAccuracy(p) {
    return p === null ? "—" : `${Math.round(p * 100)}%`;
  }

  function renderStats() {
    const studiedIds = Object.keys(stats).filter((id) => stats[id].lastAttempt !== null);
    if (studiedIds.length === 0) {
      statsTable.classList.add("hidden");
      statsSummary.classList.add("hidden");
      statsEmpty.classList.remove("hidden");
      return;
    }
    statsTable.classList.remove("hidden");
    statsSummary.classList.remove("hidden");
    statsEmpty.classList.add("hidden");

    const byId = new Map(ARTWORKS.map((a) => [a.id, a]));
    const rows = studiedIds
      .map((id) => {
        const art = byId.get(id);
        if (!art) return null;
        const s = stats[id];
        const artistAcc = computeAccuracy(s.artist);
        const titleAcc = computeAccuracy(s.title);
        const decadeAcc = computeAccuracy(s.decade);
        const totalRight = s.artist.right + s.title.right + s.decade.right;
        const totalAttempts = totalRight + s.artist.wrong + s.title.wrong + s.decade.wrong;
        const overallAcc = totalAttempts > 0 ? totalRight / totalAttempts : null;
        return {
          art,
          artistAcc,
          titleAcc,
          decadeAcc,
          overallAcc,
          type: art.types.join(", "),
          decade: art.decade || "—",
          lastAttempt: s.lastAttempt,
        };
      })
      .filter(Boolean);

    const totals = { right: 0, wrong: 0 };
    studiedIds.forEach((id) => {
      const s = stats[id];
      ["artist", "title", "decade"].forEach((f) => {
        totals.right += s[f].right;
        totals.wrong += s[f].wrong;
      });
    });
    const totalAttempts = totals.right + totals.wrong;
    const overallAccuracy = totalAttempts > 0 ? Math.round((totals.right / totalAttempts) * 100) : 0;

    statsSummary.innerHTML = `
      <div><strong>${rows.length}</strong>pieces studied</div>
      <div><strong>${totals.right}</strong>correct guesses</div>
      <div><strong>${totals.wrong}</strong>incorrect guesses</div>
      <div><strong>${overallAccuracy}%</strong>overall accuracy</div>
    `;

    rows.sort((a, b) => {
      let av, bv;
      if (sortKey === "title") { av = a.art.title; bv = b.art.title; }
      else if (sortKey === "artistName") { av = a.art.artist; bv = b.art.artist; }
      else if (sortKey === "type" || sortKey === "decade") { av = a[sortKey]; bv = b[sortKey]; }
      else {
        av = a[sortKey] === null ? -1 : a[sortKey];
        bv = b[sortKey] === null ? -1 : b[sortKey];
      }
      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * (av - bv);
    });

    statsBody.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      const guessTitle = r.lastAttempt
        ? `Last guess — artist: "${r.lastAttempt.artistGuess || "(blank)"}", title: "${r.lastAttempt.titleGuess || "(blank)"}", decade: "${r.lastAttempt.decadeGuess || "(blank)"}"`
        : "";
      tr.title = guessTitle;
      tr.innerHTML = `
        <td><img src="${r.art.image}" alt=""></td>
        <td>${r.art.title}</td>
        <td>${artistLinksHtml(r.art.artist, r.art.artistSlugs)}</td>
        <td>${r.type}</td>
        <td>${r.decade}</td>
        <td>${formatAccuracy(r.artistAcc)}</td>
        <td>${formatAccuracy(r.titleAcc)}</td>
        <td>${formatAccuracy(r.decadeAcc)}</td>
        <td>${formatAccuracy(r.overallAcc)}</td>
      `;
      statsBody.appendChild(tr);
    });
  }

  statsTable.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else { sortKey = key; sortDir = -1; }
      renderStats();
    });
  });

  // ---------- All Artists tab ----------

  const artistsCount = document.getElementById("artists-count");
  const allArtistsBody = document.getElementById("all-artists-body");

  // "Dana C. Chandler Jr." should sort under "Chandler", not "Jr." — strip
  // trailing suffix tokens before taking the last word as the sort key.
  // Single-word/mononym names (e.g. "Rozeal.", "Embah") just sort on
  // themselves, which is the only reasonable fallback without a real
  // "family name" field in the source data.
  const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

  // Collective/group names don't fit the "last word is a family name"
  // heuristic at all — called out individually rather than trying to
  // generalize "& <acronym>" parsing for what's currently a single case.
  const SORT_KEY_OVERRIDES = { "Tim Rollins & K.O.S": "rollins" };

  function lastNameKey(fullName) {
    if (SORT_KEY_OVERRIDES[fullName]) return SORT_KEY_OVERRIDES[fullName];
    const words = fullName.trim().split(/\s+/);
    let idx = words.length - 1;
    while (idx > 0 && NAME_SUFFIXES.has(words[idx].toLowerCase().replace(/\.$/, ""))) {
      idx -= 1;
    }
    return (words[idx] || fullName).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  }

  function formatArtistDates(birthYear, deathYear) {
    if (!birthYear) return "—";
    return deathYear ? `${birthYear}–${deathYear}` : `b. ${birthYear}`;
  }

  function formatGenres(genres) {
    return Object.entries(genres || {})
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${escapeHtml(type)} (${count})`)
      .join(", ");
  }

  function renderAllArtists() {
    const index = typeof ARTISTS_INDEX !== "undefined" ? ARTISTS_INDEX : {};

    const firstImageBySlug = new Map();
    ARTWORKS.forEach((a) => {
      (a.artistSlugs || []).forEach((slug) => {
        if (!firstImageBySlug.has(slug)) firstImageBySlug.set(slug, a.image);
      });
    });

    const records = Object.values(index).sort((a, b) => {
      const ka = lastNameKey(a.name);
      const kb = lastNameKey(b.name);
      return ka.localeCompare(kb) || a.name.localeCompare(b.name);
    });

    artistsCount.textContent = `${records.length} artists.`;

    allArtistsBody.innerHTML = "";
    records.forEach((rec) => {
      const tr = document.createElement("tr");
      const img = firstImageBySlug.get(rec.slug);
      const wikiCell = wikiLinkHtml(
        rec.name,
        { url: rec.wikipediaUrl, extract: rec.wikipediaExtract },
        "Wikipedia"
      );
      tr.innerHTML = `
        <td>${img ? `<img src="${escapeHtml(img)}" alt="">` : ""}</td>
        <td><a href="${escapeHtml(artistDetailHref(rec.slug))}">${escapeHtml(rec.name)}</a></td>
        <td>${wikiCell}</td>
        <td>${formatArtistDates(rec.birthYear, rec.deathYear)}</td>
        <td>${rec.artworkCount}</td>
        <td>${formatGenres(rec.genres)}</td>
      `;
      allArtistsBody.appendChild(tr);
    });
  }

  // ---------- Init ----------

  newQuizSet();
  newStudySet();
  activateTab(tabFromPath(window.location.pathname), { replaceHistory: true });
})();
