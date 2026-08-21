(function () {
  "use strict";

  const STORAGE_KEY = "museumFlashcards.stats.v2";
  const MAX_HISTORY_PER_ARTWORK = 20;

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
        history: [],
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
    s.history.unshift({
      timestamp: new Date().toISOString(),
      artistGuess: result.artist.guess,
      titleGuess: result.title.guess,
      decadeGuess: result.decade.guess,
      artistCorrect: result.artist.graded ? result.artist.correct : null,
      titleCorrect: result.title.graded ? result.title.correct : null,
      decadeCorrect: result.decade.graded ? result.decade.correct : null,
    });
    if (s.history.length > MAX_HISTORY_PER_ARTWORK) {
      s.history.length = MAX_HISTORY_PER_ARTWORK;
    }
    s.lastSeen = new Date().toISOString();
    saveStats(stats);
  }

  function markResult(el, graded, correct) {
    if (!graded) {
      el.textContent = "not graded";
      el.className = "guess-result skipped";
      return;
    }
    el.textContent = correct ? "✓ correct" : "✗ incorrect";
    el.className = "guess-result " + (correct ? "correct" : "incorrect");
  }

  // ---------- Tabs ----------

  const navButtons = document.querySelectorAll(".nav-btn");
  const tabPanels = {
    mix: document.getElementById("mix-tab"),
    browse: document.getElementById("browse-tab"),
    stats: document.getElementById("stats-tab"),
  };

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      navButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      Object.values(tabPanels).forEach((p) => p.classList.remove("active"));
      tabPanels[btn.dataset.tab].classList.add("active");
      if (btn.dataset.tab === "stats") renderStats();
    });
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

  const mmTypeFilter = document.getElementById("mm-type-filter");
  const mmDecadeFilter = document.getElementById("mm-decade-filter");
  populateFilter(mmTypeFilter, typeCounts, byCountDesc(typeCounts));
  populateFilter(mmDecadeFilter, decadeCounts, alphabetically);

  const browseTypeFilter = document.getElementById("browse-type-filter");
  const browseDecadeFilter = document.getElementById("browse-decade-filter");
  populateFilter(browseTypeFilter, typeCounts, byCountDesc(typeCounts));
  populateFilter(browseDecadeFilter, decadeCounts, alphabetically);

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- Hover image preview ----------
  // Fixed, centered in the viewport via CSS — deliberately ignores cursor
  // position so it doesn't jitter while the mouse moves within the same image.

  const imagePreview = document.getElementById("image-preview");
  const imagePreviewImg = document.getElementById("image-preview-img");

  function initHoverPreview(container) {
    container.addEventListener("mouseover", (e) => {
      const img = e.target.closest("img");
      if (!img || !container.contains(img)) return;
      imagePreviewImg.src = img.src;
      imagePreview.classList.remove("hidden");
    });
    container.addEventListener("mouseout", (e) => {
      const img = e.target.closest("img");
      if (!img || !container.contains(img)) return;
      if (e.relatedTarget && img.contains(e.relatedTarget)) return;
      imagePreview.classList.add("hidden");
    });
  }

  // ---------- Mix & Match tab ----------

  const MIX_SET_SIZE = 9;

  const mmPoolCount = document.getElementById("mm-pool-count");
  const mmEmpty = document.getElementById("mm-empty");
  const mmGrid = document.getElementById("mm-grid");
  const mmSubmitBtn = document.getElementById("mm-submit-btn");
  const mmNewSetBtn = document.getElementById("mm-new-set-btn");
  const mmScore = document.getElementById("mm-score");

  let mmBatch = [];
  let mmSubmitted = false;

  // Per-field multiset of the batch's true values (e.g. 9 decades, possibly with
  // duplicates) and the current selections, keyed by card index. Options already
  // picked in one card's dropdown are removed from the others of the same field —
  // computed fresh from these two each time, so re-selecting/clearing stays correct.
  let mmPools = { artist: [], title: [], decade: [] };
  let mmSelections = { artist: {}, title: {}, decade: {} };

  function buildMixPool() {
    const type = mmTypeFilter.value;
    const decade = mmDecadeFilter.value;
    // decade is required per-card so the matching game has a full set of options
    let pool = ARTWORKS.filter((a) => a.decade);
    if (type) pool = pool.filter((a) => a.types.includes(type));
    if (decade) pool = pool.filter((a) => a.decade === decade);
    return pool;
  }

  function availableOptions(field, forIdx) {
    const remaining = mmPools[field].slice();
    Object.keys(mmSelections[field]).forEach((idxStr) => {
      const idx = Number(idxStr);
      if (idx === forIdx) return;
      const val = mmSelections[field][idx];
      if (!val) return;
      const pos = remaining.indexOf(val);
      if (pos !== -1) remaining.splice(pos, 1);
    });
    return remaining;
  }

  function refreshFieldSelects(field) {
    mmBatch.forEach((card, idx) => {
      const select = mmGrid.querySelector(`select[data-field="${field}"][data-idx="${idx}"]`);
      if (!select) return;
      const currentVal = select.value;
      select.innerHTML = "";
      select.appendChild(new Option("Choose…", ""));
      availableOptions(field, idx).forEach((v) => select.appendChild(new Option(v, v)));
      select.value = currentVal;
    });
  }

  function makeMixField(container, label, field, idx) {
    const wrap = document.createElement("label");
    wrap.className = "mm-field";
    wrap.append(label);

    const select = document.createElement("select");
    select.className = "mm-select";
    select.dataset.field = field;
    select.dataset.idx = String(idx);
    select.appendChild(new Option("Choose…", ""));
    wrap.appendChild(select);

    const result = document.createElement("span");
    result.className = "guess-result";
    result.id = `mm-result-${field}-${idx}`;
    wrap.appendChild(result);

    container.appendChild(wrap);
  }

  function renderMixGrid() {
    mmPools = {
      artist: shuffled(mmBatch.map((c) => c.artist)),
      title: shuffled(mmBatch.map((c) => c.title)),
      decade: mmBatch.map((c) => c.decade).sort(),
    };
    mmSelections = { artist: {}, title: {}, decade: {} };

    mmGrid.innerHTML = "";
    mmBatch.forEach((card, idx) => {
      const div = document.createElement("div");
      div.className = "mm-card";

      const img = document.createElement("img");
      img.src = card.image;
      img.alt = "";
      div.appendChild(img);

      makeMixField(div, "Artist", "artist", idx);
      makeMixField(div, "Title", "title", idx);
      makeMixField(div, "Decade", "decade", idx);

      mmGrid.appendChild(div);
    });

    ["artist", "title", "decade"].forEach(refreshFieldSelects);
  }

  mmGrid.addEventListener("change", (e) => {
    const select = e.target.closest(".mm-select");
    if (!select) return;
    const field = select.dataset.field;
    const idx = Number(select.dataset.idx);
    mmSelections[field][idx] = select.value;
    refreshFieldSelects(field);
  });

  function newMixSet() {
    const pool = buildMixPool();
    mmScore.textContent = "";
    mmSubmitted = false;

    if (pool.length < MIX_SET_SIZE) {
      mmGrid.innerHTML = "";
      mmGrid.classList.add("hidden");
      mmSubmitBtn.classList.add("hidden");
      mmEmpty.classList.remove("hidden");
      mmPoolCount.textContent =
        pool.length > 0 ? `Only ${pool.length} matching works — need at least ${MIX_SET_SIZE}.` : "";
      return;
    }

    mmEmpty.classList.add("hidden");
    mmGrid.classList.remove("hidden");
    mmSubmitBtn.classList.remove("hidden");
    mmSubmitBtn.disabled = false;
    mmPoolCount.textContent = `${pool.length} works match this filter.`;

    mmBatch = shuffled(pool).slice(0, MIX_SET_SIZE);
    renderMixGrid();
  }

  function submitMix() {
    if (mmSubmitted || mmBatch.length === 0) return;

    const allSelects = Array.from(mmGrid.querySelectorAll(".mm-select"));
    const anySelected = allSelects.some((s) => s.value.length > 0);
    if (!anySelected) {
      mmScore.textContent = "Choose some answers first.";
      return;
    }

    mmSubmitted = true;
    let rightTotal = 0;
    let gradedTotal = 0;

    mmBatch.forEach((card, idx) => {
      const result = {};
      ["artist", "title", "decade"].forEach((field) => {
        const select = mmGrid.querySelector(`select[data-field="${field}"][data-idx="${idx}"]`);
        const guess = select.value;
        const graded = guess.length > 0;
        const correct = graded && guess === card[field];
        result[field] = { guess, graded, correct };
        if (graded) {
          gradedTotal += 1;
          if (correct) rightTotal += 1;
        }
        markResult(document.getElementById(`mm-result-${field}-${idx}`), graded, correct);
        select.disabled = true;
      });
      recordAttempt(card.id, result);
    });

    mmScore.textContent = `${rightTotal} / ${gradedTotal} correct.`;
    mmSubmitBtn.disabled = true;
  }

  mmNewSetBtn.addEventListener("click", newMixSet);
  mmSubmitBtn.addEventListener("click", submitMix);
  mmTypeFilter.addEventListener("change", newMixSet);
  mmDecadeFilter.addEventListener("change", newMixSet);
  initHoverPreview(mmGrid);

  // ---------- Study (browse) tab ----------

  const BROWSE_SET_SIZE = 9;

  const browsePoolCount = document.getElementById("browse-pool-count");
  const browseEmpty = document.getElementById("browse-empty");
  const browseGrid = document.getElementById("browse-grid");
  const browseNewSetBtn = document.getElementById("browse-new-set-btn");

  function newBrowseSet() {
    const type = browseTypeFilter.value;
    const decade = browseDecadeFilter.value;

    let pool = ARTWORKS;
    if (type) pool = pool.filter((a) => a.types.includes(type));
    if (decade) pool = pool.filter((a) => a.decade === decade);

    if (pool.length === 0) {
      browseGrid.innerHTML = "";
      browseGrid.classList.add("hidden");
      browseEmpty.classList.remove("hidden");
      browsePoolCount.textContent = "";
      return;
    }

    browseEmpty.classList.add("hidden");
    browseGrid.classList.remove("hidden");

    const batch = shuffled(pool).slice(0, BROWSE_SET_SIZE);
    browsePoolCount.textContent = `${pool.length} work${pool.length === 1 ? "" : "s"} match this filter — showing ${batch.length}.`;

    browseGrid.innerHTML = "";
    batch.forEach((card) => {
      const div = document.createElement("div");
      div.className = "browse-card";

      const img = document.createElement("img");
      img.src = card.image;
      img.alt = "";
      div.appendChild(img);

      const title = document.createElement("h3");
      title.textContent = card.title;
      div.appendChild(title);

      const artist = document.createElement("p");
      artist.className = "browse-artist";
      artist.textContent = card.artistDates ? `${card.artist} (${card.artistDates})` : card.artist;
      div.appendChild(artist);

      const decadeLine = document.createElement("p");
      decadeLine.textContent = card.decade ? `${card.decade} (${card.date})` : card.date;
      div.appendChild(decadeLine);

      browseGrid.appendChild(div);
    });
  }

  browseNewSetBtn.addEventListener("click", newBrowseSet);
  browseTypeFilter.addEventListener("change", newBrowseSet);
  browseDecadeFilter.addEventListener("change", newBrowseSet);
  initHoverPreview(browseGrid);

  // ---------- Stats tab ----------

  const statsSummary = document.getElementById("stats-summary");
  const statsBody = document.getElementById("stats-body");
  const statsTable = document.getElementById("stats-table");
  const statsEmpty = document.getElementById("stats-empty");

  let sortKey = "overallAcc";
  let sortDir = 1;

  function pct(f) {
    const total = f.right + f.wrong;
    return total > 0 ? f.right / total : null;
  }

  function fmtPct(p) {
    return p === null ? "—" : `${Math.round(p * 100)}%`;
  }

  function renderStats() {
    const studiedIds = Object.keys(stats).filter((id) => stats[id].history.length > 0);
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
        const artistAcc = pct(s.artist);
        const titleAcc = pct(s.title);
        const decadeAcc = pct(s.decade);
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
          lastGuesses: s.history[0],
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
      const guessTitle = r.lastGuesses
        ? `Last guess — artist: "${r.lastGuesses.artistGuess || "(blank)"}", title: "${r.lastGuesses.titleGuess || "(blank)"}", decade: "${r.lastGuesses.decadeGuess || "(blank)"}"`
        : "";
      tr.title = guessTitle;
      tr.innerHTML = `
        <td><img src="${r.art.image}" alt=""></td>
        <td>${r.art.title}</td>
        <td>${r.art.artist}</td>
        <td>${r.type}</td>
        <td>${r.decade}</td>
        <td>${fmtPct(r.artistAcc)}</td>
        <td>${fmtPct(r.titleAcc)}</td>
        <td>${fmtPct(r.decadeAcc)}</td>
        <td>${fmtPct(r.overallAcc)}</td>
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

  // ---------- Init ----------

  newMixSet();
  newBrowseSet();
})();
