// Shared across every page (the core Study/Quiz/Favorites/Stats/All Artists
// app shell AND the per-artist detail leaf pages), exposed as
// window.MuseumShared so plain <script> tags can use it without a bundler.
// Depends on ARTWORKS (data.js) and ARTIST_WIKI (artist-wiki.js) being
// loaded first as bare globals; expects #image-preview/#image-preview-img
// and #wiki-preview to exist in the page's HTML.

window.MuseumShared = (function () {
  "use strict";

  const artistWikiLookup = typeof ARTIST_WIKI !== "undefined" ? ARTIST_WIKI : {};

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function splitArtistNames(field) {
    return (field || "").split(",").map((n) => n.trim()).filter(Boolean);
  }

  function wikipediaSearchUrl(name) {
    return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(name)}`;
  }

  // The single place that builds a Wikipedia <a> tag for an artist, used by
  // artistLinksHtml below, the All Artists table, and each artist's own
  // detail page — those three used to each build this markup separately,
  // which is how "red link" styling ended up silently broken everywhere at
  // once (see artist-link-missing below).
  //
  // wikiInfo is a {url, extract} pair — from ARTIST_WIKI[name] or an
  // ARTISTS_INDEX record's {wikipediaUrl, wikipediaExtract} (renamed by the
  // caller to match). extract is the real "confident match" signal: every
  // known artist has a wikiInfo entry, even unmatched ones (whose url
  // already points to a Wikipedia search page instead of an article), so
  // mere presence of wikiInfo doesn't mean a real match was found.
  function wikiLinkHtml(name, wikiInfo, linkText) {
    const matched = !!(wikiInfo && wikiInfo.extract);
    const url = (wikiInfo && wikiInfo.url) || wikipediaSearchUrl(name);
    const cls = matched ? "artist-link" : "artist-link artist-link-missing";
    const text = linkText == null ? name : linkText;
    return `<a class="${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" data-artist="${escapeHtml(name)}">${escapeHtml(text)}</a>`;
  }

  // Unmatched artists (no confident Wikipedia article) still get a link —
  // to a Wikipedia search page — but styled as a "red link" (Wikipedia's
  // own term for a link to a page that doesn't exist yet) so it's visually
  // obvious there's nothing to preview before you even hover it.
  function artistLinksHtml(field) {
    const names = splitArtistNames(field);
    if (names.length === 0) return escapeHtml(field || "");
    return names.map((name) => wikiLinkHtml(name, artistWikiLookup[name])).join(", ");
  }

  // ---------- Favorites ----------

  const FAVORITES_KEY = "museumFlashcards.favorites.v1";

  function loadFavorites() {
    try {
      return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveFavorites() {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  }

  let favorites = loadFavorites();

  function isFavorite(id) {
    return !!favorites[id];
  }

  function getFavoriteIds() {
    return Object.keys(favorites);
  }

  function updateFavButtons(id) {
    const fav = isFavorite(id);
    document.querySelectorAll(`.fav-btn[data-id="${id}"]`).forEach((btn) => {
      btn.textContent = fav ? "★" : "☆";
      btn.classList.toggle("active", fav);
    });
  }

  // Pages that care about favorites changing (e.g. the Favorites tab
  // re-rendering itself) listen for this instead of shared.js knowing
  // anything about which tab/page is currently showing.
  function toggleFavorite(id) {
    if (favorites[id]) delete favorites[id];
    else favorites[id] = true;
    saveFavorites();
    updateFavButtons(id);
    document.dispatchEvent(new CustomEvent("museum:favoritechange", { detail: { id } }));
  }

  function makeFavButton(id) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fav-btn" + (isFavorite(id) ? " active" : "");
    btn.dataset.id = id;
    btn.textContent = isFavorite(id) ? "★" : "☆";
    btn.setAttribute("aria-label", "Toggle favorite");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(id);
    });
    return btn;
  }

  // ---------- Misc ----------

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Shared by Quiz and Study, which both filter ARTWORKS by the same
  // Medium/Decade pair. requireDecade excludes artworks with no known
  // decade — both tabs need this so a batch can always convert into the
  // other one's format.
  function filterArtworksPool(opts) {
    opts = opts || {};
    let pool = opts.requireDecade ? ARTWORKS.filter((a) => a.decade) : ARTWORKS.slice();
    if (opts.type) pool = pool.filter((a) => a.types.includes(opts.type));
    if (opts.decade) pool = pool.filter((a) => a.decade === opts.decade);
    return pool;
  }

  function showEmptyState(gridEl, emptyEl) {
    gridEl.innerHTML = "";
    gridEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
  }

  function hideEmptyState(gridEl, emptyEl) {
    emptyEl.classList.add("hidden");
    gridEl.classList.remove("hidden");
  }

  // ---------- Hover image preview (click-outside-to-close lightbox) ----------
  // Hovering a thumbnail opens a full-screen backdrop with the image
  // enlarged and centered (CSS flex-centers it — no cursor-relative math).
  // The preview only opens once the cursor has been still over an image for
  // HOVER_DELAY_MS — a plain mouseover fired it instantly while just passing
  // over the grid, which was distracting. Tracked via mousemove (which stops
  // firing once the pointer stops), restarting the timer on every move and
  // clearing it on leaving the image, so it only fires after real stillness.
  // While shown, the backdrop covers the whole viewport and intercepts
  // every pointer event, so nothing underneath it can receive a stray
  // mouseover — that's what used to let the preview silently swap to a
  // different image as the cursor crossed the (previously click-through)
  // overlay. The only way to dismiss it is a click on the backdrop itself,
  // not the image (checked via e.target === imagePreview, since clicks on
  // the inner wrapper/img report those elements as the target instead).

  const imagePreview = document.getElementById("image-preview");
  const imagePreviewImg = document.getElementById("image-preview-img");
  const HOVER_DELAY_MS = 400;

  function initHoverPreview(container) {
    if (!imagePreview || !imagePreviewImg) return;
    let hoverTimer = null;

    function clearHoverTimer() {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }

    container.addEventListener("mousemove", (e) => {
      const img = e.target.closest("img");
      clearHoverTimer();
      if (!img || !container.contains(img)) return;
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        imagePreviewImg.src = img.src;
        imagePreview.classList.remove("hidden");
      }, HOVER_DELAY_MS);
    });

    container.addEventListener("mouseleave", clearHoverTimer);
  }

  if (imagePreview) {
    imagePreview.addEventListener("click", (e) => {
      if (e.target === imagePreview) imagePreview.classList.add("hidden");
    });
  }

  // ---------- Wikipedia artist hover preview ----------
  // Single shared tooltip, positioned near whichever .artist-link is
  // hovered (event delegation on body, since links are created dynamically
  // across several grids/tables/pages). Only links with a known extract
  // show anything; unmatched (red-link) artists are still clickable, just
  // silent on hover.

  const wikiPreview = document.getElementById("wiki-preview");

  function positionWikiPreview(linkEl) {
    const rect = linkEl.getBoundingClientRect();
    const margin = 8;
    const pw = wikiPreview.offsetWidth;
    const ph = wikiPreview.offsetHeight;

    let left = Math.min(rect.left, window.innerWidth - pw - 8);
    left = Math.max(8, left);

    let top = rect.bottom + margin;
    if (top + ph > window.innerHeight - 8) top = rect.top - ph - margin;
    top = Math.max(8, top);

    wikiPreview.style.left = `${left}px`;
    wikiPreview.style.top = `${top}px`;
  }

  if (wikiPreview) {
    document.body.addEventListener("mouseover", (e) => {
      const link = e.target.closest(".artist-link");
      if (!link) return;
      const wiki = artistWikiLookup[link.dataset.artist];
      if (!wiki || !wiki.extract) return;
      wikiPreview.textContent = wiki.extract;
      wikiPreview.classList.remove("hidden");
      positionWikiPreview(link);
    });

    document.body.addEventListener("mouseout", (e) => {
      const link = e.target.closest(".artist-link");
      if (!link) return;
      if (e.relatedTarget && link.contains(e.relatedTarget)) return;
      wikiPreview.classList.add("hidden");
    });
  }

  // ---------- Shared artwork-card builder ----------
  // Used by Study, Favorites, and each artist's own detail page. opts.hideArtist
  // skips the artist name/dates line — redundant on a page that's already
  // dedicated to that one artist.

  function buildArtworkCard(card, opts) {
    opts = opts || {};
    const div = document.createElement("div");
    div.className = "work-card";

    const img = document.createElement("img");
    img.src = card.image;
    img.alt = "";
    div.appendChild(img);
    div.appendChild(makeFavButton(card.id));

    const title = document.createElement("h3");
    title.textContent = card.title;
    div.appendChild(title);

    if (!opts.hideArtist) {
      const artist = document.createElement("p");
      artist.className = "work-artist";
      artist.innerHTML = card.artistDates
        ? `${artistLinksHtml(card.artist)} (${escapeHtml(card.artistDates)})`
        : artistLinksHtml(card.artist);
      div.appendChild(artist);
    }

    const dateLine = document.createElement("p");
    dateLine.textContent = card.date;
    div.appendChild(dateLine);

    return div;
  }

  return {
    escapeHtml,
    wikipediaSearchUrl,
    wikiLinkHtml,
    artistLinksHtml,
    getFavoriteIds,
    toggleFavorite,
    makeFavButton,
    shuffled,
    filterArtworksPool,
    showEmptyState,
    hideEmptyState,
    initHoverPreview,
    buildArtworkCard,
  };
})();
