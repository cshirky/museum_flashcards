(function () {
  "use strict";

  const STORAGE_KEY = "museumFlashcards.stats.v1";

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

  function statFor(id) {
    return stats[id] || { right: 0, wrong: 0 };
  }

  function recordGrade(id, isRight) {
    const s = statFor(id);
    if (isRight) s.right += 1;
    else s.wrong += 1;
    s.lastSeen = new Date().toISOString();
    stats[id] = s;
    saveStats(stats);
  }

  // ---------- Tabs ----------

  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabPanels = {
    study: document.getElementById("study-tab"),
    stats: document.getElementById("stats-tab"),
  };

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      Object.values(tabPanels).forEach((p) => p.classList.remove("active"));
      tabPanels[btn.dataset.tab].classList.add("active");
      if (btn.dataset.tab === "stats") renderStats();
    });
  });

  // ---------- Artist filter ----------

  const artistFilter = document.getElementById("artist-filter");
  const artists = Array.from(new Set(ARTWORKS.map((a) => a.artist))).sort((a, b) =>
    a.localeCompare(b)
  );
  artists.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    artistFilter.appendChild(opt);
  });

  // ---------- Deck / study session ----------

  const missedOnlyCheckbox = document.getElementById("missed-only");
  const newSessionBtn = document.getElementById("new-session-btn");
  const deckEmpty = document.getElementById("deck-empty");
  const cardArea = document.getElementById("card-area");
  const progressLabel = document.getElementById("progress-label");
  const cardImage = document.getElementById("card-image");
  const cardAnswer = document.getElementById("card-answer");
  const answerTitle = document.getElementById("answer-title");
  const answerArtist = document.getElementById("answer-artist");
  const answerDate = document.getElementById("answer-date");
  const answerMedium = document.getElementById("answer-medium");
  const answerDimensions = document.getElementById("answer-dimensions");
  const answerHistory = document.getElementById("answer-history");
  const showAnswerBtn = document.getElementById("show-answer-btn");
  const gradeButtons = document.getElementById("grade-buttons");
  const rightBtn = document.getElementById("right-btn");
  const wrongBtn = document.getElementById("wrong-btn");

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  let deck = [];
  let position = 0;
  let answerShown = false;

  function buildDeck() {
    const artist = artistFilter.value;
    const missedOnly = missedOnlyCheckbox.checked;

    let pool = ARTWORKS;
    if (artist) pool = pool.filter((a) => a.artist === artist);
    if (missedOnly) {
      pool = pool.filter((a) => {
        const s = statFor(a.id);
        return s.wrong > s.right;
      });
    }

    deck = shuffled(pool);
    position = 0;
    renderCard();
  }

  function renderCard() {
    if (deck.length === 0) {
      cardArea.classList.add("hidden");
      deckEmpty.classList.remove("hidden");
      return;
    }
    cardArea.classList.remove("hidden");
    deckEmpty.classList.add("hidden");

    if (position >= deck.length) position = 0;

    const card = deck[position];
    progressLabel.textContent = `Card ${position + 1} of ${deck.length}`;
    cardImage.src = card.image;
    cardImage.alt = card.title;

    answerShown = false;
    cardAnswer.classList.add("hidden");
    showAnswerBtn.classList.remove("hidden");
    gradeButtons.classList.add("hidden");

    answerTitle.textContent = card.title;
    answerArtist.textContent = card.artistDates
      ? `${card.artist} (${card.artistDates})`
      : card.artist;
    answerDate.textContent = card.date;
    answerMedium.textContent = card.medium;
    answerDimensions.textContent = card.dimensions || "";

    const s = statFor(card.id);
    answerHistory.textContent =
      s.right + s.wrong > 0
        ? `You've seen this before — ${s.right} right, ${s.wrong} wrong.`
        : "First time seeing this one.";
  }

  function revealAnswer() {
    if (deck.length === 0 || answerShown) return;
    answerShown = true;
    cardAnswer.classList.remove("hidden");
    showAnswerBtn.classList.add("hidden");
    gradeButtons.classList.remove("hidden");
  }

  function grade(isRight) {
    if (deck.length === 0 || !answerShown) return;
    const card = deck[position];
    recordGrade(card.id, isRight);
    position += 1;
    renderCard();
  }

  showAnswerBtn.addEventListener("click", revealAnswer);
  rightBtn.addEventListener("click", () => grade(true));
  wrongBtn.addEventListener("click", () => grade(false));
  newSessionBtn.addEventListener("click", buildDeck);
  artistFilter.addEventListener("change", buildDeck);
  missedOnlyCheckbox.addEventListener("change", buildDeck);

  document.addEventListener("keydown", (e) => {
    if (!tabPanels.study.classList.contains("active")) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!answerShown) revealAnswer();
    } else if (e.key === "1" && answerShown) {
      grade(false);
    } else if (e.key === "2" && answerShown) {
      grade(true);
    }
  });

  // ---------- Stats tab ----------

  const statsSummary = document.getElementById("stats-summary");
  const statsBody = document.getElementById("stats-body");
  const statsTable = document.getElementById("stats-table");
  const statsEmpty = document.getElementById("stats-empty");

  let sortKey = "wrong";
  let sortDir = -1;

  function renderStats() {
    const studiedIds = Object.keys(stats);
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
        const total = s.right + s.wrong;
        const accuracy = total > 0 ? s.right / total : 0;
        return { art, right: s.right, wrong: s.wrong, accuracy, total };
      })
      .filter(Boolean);

    const totalRight = rows.reduce((sum, r) => sum + r.right, 0);
    const totalWrong = rows.reduce((sum, r) => sum + r.wrong, 0);
    const totalAttempts = totalRight + totalWrong;
    const overallAccuracy = totalAttempts > 0 ? Math.round((totalRight / totalAttempts) * 100) : 0;

    statsSummary.innerHTML = `
      <div><strong>${rows.length}</strong>pieces studied</div>
      <div><strong>${totalRight}</strong>right</div>
      <div><strong>${totalWrong}</strong>wrong</div>
      <div><strong>${overallAccuracy}%</strong>accuracy</div>
    `;

    rows.sort((a, b) => {
      let av, bv;
      if (sortKey === "title") { av = a.art.title; bv = b.art.title; }
      else if (sortKey === "artist") { av = a.art.artist; bv = b.art.artist; }
      else if (sortKey === "accuracy") { av = a.accuracy; bv = b.accuracy; }
      else { av = a[sortKey]; bv = b[sortKey]; }

      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * (av - bv);
    });

    statsBody.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><img src="${r.art.image}" alt=""></td>
        <td>${r.art.title}</td>
        <td>${r.art.artist}</td>
        <td class="right-count">${r.right}</td>
        <td class="wrong-count">${r.wrong}</td>
        <td>${Math.round(r.accuracy * 100)}%</td>
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

  buildDeck();
})();
