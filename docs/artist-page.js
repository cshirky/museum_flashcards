// Runs on every /artist/<slug>/ leaf page. CURRENT_ARTIST_SLUG is set by a
// tiny inline <script> in that page's HTML — everything else (data lookup,
// rendering) is identical across all of them, so this one file drives all
// of them rather than duplicating logic into hundreds of generated pages.
(function () {
  "use strict";

  const { escapeHtml, initHoverPreview, buildDisplayCard } = window.MuseumShared;

  const slug = typeof CURRENT_ARTIST_SLUG !== "undefined" ? CURRENT_ARTIST_SLUG : null;
  const index = typeof ARTISTS_INDEX !== "undefined" ? ARTISTS_INDEX : {};
  const record = slug ? index[slug] : null;

  const headerEl = document.getElementById("artist-header");
  const gridEl = document.getElementById("artist-grid");

  if (!record) {
    headerEl.innerHTML = "<h1>Artist not found</h1><p>This artist isn't in the current collection data.</p>";
  } else {
    document.title = `${record.name} — Museum Flashcards`;

    const wikiMatched = !!record.wikipediaExtract;
    const wikiUrl =
      record.wikipediaUrl || `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(record.name)}`;
    const datesText = record.birthYear
      ? record.deathYear
        ? `${record.birthYear}–${record.deathYear}`
        : `b. ${record.birthYear}`
      : "";

    headerEl.innerHTML = `
      <h1>${escapeHtml(record.name)}</h1>
      <p class="artist-meta">
        ${datesText ? `${escapeHtml(datesText)} &middot; ` : ""}<a class="artist-link${
      wikiMatched ? "" : " artist-link-missing"
    }" href="${escapeHtml(wikiUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>
      </p>
      ${record.wikipediaExtract ? `<p class="artist-bio">${escapeHtml(record.wikipediaExtract)}</p>` : ""}
    `;

    const works = (typeof ARTWORKS !== "undefined" ? ARTWORKS : []).filter((a) =>
      (a.artistSlugs || []).includes(slug)
    );

    if (works.length === 0) {
      gridEl.innerHTML = '<p class="empty-state">No works currently on view for this artist.</p>';
    } else {
      works.forEach((card) => gridEl.appendChild(buildDisplayCard(card, { hideArtist: true })));
    }
  }

  initHoverPreview(gridEl);
})();
