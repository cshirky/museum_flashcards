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

  // ---------- Grading ----------

  function normalize(str) {
    return (str || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // strip accents
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Levenshtein distance, used to allow close-but-not-exact guesses.
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[n];
  }

  function isCloseMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const longer = Math.max(a.length, b.length);
    if (longer < 3) return false;
    const distance = levenshtein(a, b);
    return distance / longer <= 0.25;
  }

  function gradeFreeText(guessRaw, actualRaw) {
    const guess = normalize(guessRaw);
    const actual = normalize(actualRaw);
    if (!guess) return false;
    if (guess === actual) return true;
    if (guess.length >= 3 && (actual.includes(guess) || guess.includes(actual))) return true;
    return isCloseMatch(guess, actual);
  }

  function gradeArtist(guessRaw, actualArtistField) {
    const guess = normalize(guessRaw);
    if (!guess) return false;
    // artist field may hold multiple comma-separated names for collaborative works
    const names = actualArtistField.split(",").map((n) => n.trim());
    return names.some((full) => {
      if (gradeFreeText(guess, full)) return true;
      const words = normalize(full).split(" ").filter(Boolean);
      const lastName = words[words.length - 1];
      return words.length > 1 && (guess === lastName || isCloseMatch(guess, lastName));
    });
  }

  function gradeCard(card, guesses) {
    const artistGraded = guesses.artist.trim().length > 0;
    const titleGraded = guesses.title.trim().length > 0;
    const decadeGraded = !!card.decade && guesses.decade.trim().length > 0;

    return {
      artist: {
        guess: guesses.artist,
        graded: artistGraded,
        correct: artistGraded && gradeArtist(guesses.artist, card.artist),
      },
      title: {
        guess: guesses.title,
        graded: titleGraded,
        correct: titleGraded && gradeFreeText(guesses.title, card.title),
      },
      decade: {
        guess: guesses.decade,
        graded: decadeGraded,
        correct: decadeGraded && guesses.decade === card.decade,
      },
    };
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

  const typeFilter = document.getElementById("type-filter");
  const typeCounts = countBy((a) => a.types);
  Array.from(typeCounts.keys())
    .sort((a, b) => typeCounts.get(b) - typeCounts.get(a))
    .forEach((type) => {
      const opt = document.createElement("option");
      opt.value = type;
      opt.textContent = `${type} (${typeCounts.get(type)})`;
      typeFilter.appendChild(opt);
    });

  const decadeFilter = document.getElementById("decade-filter");
  const decadeCounts = countBy((a) => [a.decade]);
  Array.from(decadeCounts.keys())
    .sort()
    .forEach((decade) => {
      const opt = document.createElement("option");
      opt.value = decade;
      opt.textContent = `${decade} (${decadeCounts.get(decade)})`;
      decadeFilter.appendChild(opt);
    });

  const guessDecadeSelect = document.getElementById("guess-decade");
  const decades = Array.from(decadeCounts.keys()).sort();
  decades.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    guessDecadeSelect.appendChild(opt);
  });

  // ---------- Deck / study session ----------

  const missedOnlyCheckbox = document.getElementById("missed-only");
  const sessionSizeSelect = document.getElementById("session-size");
  const newSessionBtn = document.getElementById("new-session-btn");
  const deckEmpty = document.getElementById("deck-empty");
  const cardArea = document.getElementById("card-area");
  const poolCountLabel = document.getElementById("pool-count");
  const progressLabel = document.getElementById("progress-label");
  const cardImage = document.getElementById("card-image");
  const cardAnswer = document.getElementById("card-answer");
  const answerTitle = document.getElementById("answer-title");
  const answerArtist = document.getElementById("answer-artist");
  const answerDate = document.getElementById("answer-date");
  const answerMedium = document.getElementById("answer-medium");
  const answerDimensions = document.getElementById("answer-dimensions");
  const answerHistory = document.getElementById("answer-history");
  const guessForm = document.getElementById("guess-form");
  const guessArtistInput = document.getElementById("guess-artist");
  const guessTitleInput = document.getElementById("guess-title");
  const decadeField = document.getElementById("decade-field");
  const resultArtist = document.getElementById("result-artist");
  const resultTitle = document.getElementById("result-title");
  const resultDecade = document.getElementById("result-decade");
  const nextCardBtn = document.getElementById("next-card-btn");

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function isStruggling(id) {
    const s = stats[id];
    if (!s) return false;
    return ["artist", "title", "decade"].some((field) => {
      const f = s[field];
      const total = f.right + f.wrong;
      return total > 0 && f.wrong >= f.right;
    });
  }

  let deck = [];
  let position = 0;
  let answerShown = false;

  function buildDeck() {
    const type = typeFilter.value;
    const decade = decadeFilter.value;
    const missedOnly = missedOnlyCheckbox.checked;
    const sessionSize = Number(sessionSizeSelect.value);

    let pool = ARTWORKS;
    if (type) pool = pool.filter((a) => a.types.includes(type));
    if (decade) pool = pool.filter((a) => a.decade === decade);
    if (missedOnly) pool = pool.filter((a) => isStruggling(a.id));

    const matched = pool.length;
    deck = shuffled(pool);
    if (sessionSize > 0) deck = deck.slice(0, sessionSize);
    position = 0;

    poolCountLabel.textContent =
      matched === 0
        ? ""
        : deck.length < matched
        ? `${matched} pieces match this filter — studying a shuffled set of ${deck.length}.`
        : `${matched} piece${matched === 1 ? "" : "s"} match this filter.`;

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
    cardImage.alt = "";

    answerShown = false;
    guessForm.reset();
    guessForm.classList.remove("hidden");
    decadeField.classList.toggle("hidden", !card.decade);
    [resultArtist, resultTitle, resultDecade].forEach((el) => {
      el.textContent = "";
      el.className = "guess-result";
    });
    cardAnswer.classList.add("hidden");
    nextCardBtn.classList.add("hidden");

    answerTitle.textContent = card.title;
    answerArtist.textContent = card.artistDates
      ? `${card.artist} (${card.artistDates})`
      : card.artist;
    answerDate.textContent = card.date;
    answerMedium.textContent = card.medium;
    answerDimensions.textContent = card.dimensions || "";

    const s = stats[card.id];
    const attempts = s ? s.history.length : 0;
    answerHistory.textContent =
      attempts > 0
        ? `You've seen this before — ${attempts} attempt${attempts === 1 ? "" : "s"} logged.`
        : "First time seeing this one.";

    guessArtistInput.focus();
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

  function submitGuess(e) {
    e.preventDefault();
    if (deck.length === 0 || answerShown) return;

    const card = deck[position];
    const guesses = {
      artist: guessArtistInput.value,
      title: guessTitleInput.value,
      decade: guessDecadeSelect.value,
    };
    const result = gradeCard(card, guesses);
    recordAttempt(card.id, result);

    markResult(resultArtist, result.artist.graded, result.artist.correct);
    markResult(resultTitle, result.title.graded, result.title.correct);
    if (card.decade) markResult(resultDecade, result.decade.graded, result.decade.correct);

    answerShown = true;
    guessArtistInput.disabled = true;
    guessTitleInput.disabled = true;
    guessDecadeSelect.disabled = true;
    document.getElementById("submit-guess-btn").disabled = true;
    cardAnswer.classList.remove("hidden");
    nextCardBtn.classList.remove("hidden");
    nextCardBtn.focus();
  }

  function nextCard() {
    if (deck.length === 0 || !answerShown) return;
    guessArtistInput.disabled = false;
    guessTitleInput.disabled = false;
    guessDecadeSelect.disabled = false;
    document.getElementById("submit-guess-btn").disabled = false;
    position += 1;
    renderCard();
  }

  guessForm.addEventListener("submit", submitGuess);
  nextCardBtn.addEventListener("click", nextCard);
  newSessionBtn.addEventListener("click", buildDeck);
  typeFilter.addEventListener("change", buildDeck);
  decadeFilter.addEventListener("change", buildDeck);
  sessionSizeSelect.addEventListener("change", buildDeck);
  missedOnlyCheckbox.addEventListener("change", buildDeck);

  document.addEventListener("keydown", (e) => {
    if (!tabPanels.study.classList.contains("active")) return;
    if (answerShown && e.key === "Enter" && document.activeElement !== guessArtistInput) {
      e.preventDefault();
      nextCard();
    }
  });

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

  buildDeck();
})();
