# Code Review — HTML/CSS/JS (docs/)

Ad hoc review looking for redundancy, dead code, and stale/out-of-sync
comments across `docs/app.js`, `docs/shared.js`, `docs/artist-page.js`,
`docs/style.css`, and the five tab-shell `index.html` files (plus the
`ARTIST_PAGE_TEMPLATE` in `fetch_data.py`, since it generates 630 of the
HTML files under `docs/artist/`). No functional bugs found — everything
below is cleanup/consistency, not breakage.

## 1. ~~Decade quiz's "off" switch left several downstream spots live~~ — fixed

The Decade drag-and-drop UI was intentionally commented out (not deleted)
in `e373a1e` so it can be restored later, but a couple of places that
*consume* decade-quiz results weren't updated to match at the time: the
Stats table's row tooltip still referenced `lastAttempt.decadeGuess`
(always blank going forward), and `renderStats()` still displayed a
**Decade %** column that could only ever show "—" for new attempts.

Fixed by applying the same "comment out, don't delete" pattern one layer
further out: the tooltip's decade clause and the `Decade %` `<th>`/`<td>`
are now commented out (JS `//`/HTML `<!-- -->`) in `app.js` and all five
tab shells, restorable alongside the rest of the Decade quiz UI. The
summary totals (`app.js` ~line 685-691) were left folding in
`s.decade.right/wrong` from before the feature was disabled — that's
inert-but-correct (decade just stops contributing further attempts) rather
than something that needs disabling.

## 2. `TAB_SLUGS` and `SLUG_TABS` are duplicate objects

`app.js:113-114`:

```js
const TAB_SLUGS = { quiz: "quiz", study: "study", favorites: "favorites", stats: "stats", artists: "artists" };
const SLUG_TABS = { quiz: "quiz", study: "study", favorites: "favorites", stats: "stats", artists: "artists" };
```

Both are used (`TAB_SLUGS` to build a path from a tab name, `SLUG_TABS` to
recover a tab name from a URL segment), but since tab names and their URL
slugs are identical strings, the two maps have identical contents — this
is really one identity set serving two lookup directions. One `const
TAB_SLUG_NAMES = new Set([...])`-plus-passthrough (or just one object,
since `obj[key]` and membership-check both need the same map) would do the
job of both without carrying two names for one fact. Low priority — just a
name-for-name duplication, not a bug.

## 3. `formatArtistDates` logic duplicated between `app.js` and `artist-page.js`

`app.js:771-774` defines:

```js
function formatArtistDates(birthYear, deathYear) {
  if (!birthYear) return "—";
  return deathYear ? `${birthYear}–${deathYear}` : `b. ${birthYear}`;
}
```

`artist-page.js:27-31` re-implements the same `b. YYYY` / `YYYY–YYYY`
formatting inline (with a blank-string fallback instead of "—", the only
difference) because it runs in a separate IIFE with no access to `app.js`'s
module-local function. Since `shared.js` already exists specifically to
hold logic used by both the tab shell and the per-artist leaf pages
(`window.MuseumShared`), this is a good candidate to move there — one
function, one source of truth for the "b. 1950" / "1950–2010" formatting
rule instead of two copies that could drift.

## 4. Per-artist page template's nav is out of sync with the current tab-shell nav

`fetch_data.py`'s `ARTIST_PAGE_TEMPLATE` (~line 326-332), which generates
all 630 pages under `docs/artist/<slug>/`, still renders:

```html
<nav class="side-nav">
  <a class="nav-btn" href="../../study/">Study</a>
  <a class="nav-btn" href="../../quiz/">Quiz</a>
  <a class="nav-btn active" href="../../artists/">All Artists</a>
  <a class="nav-btn" href="../../favorites/">Favorites</a>
  <a class="nav-btn" href="../../stats/">Stats</a>
</nav>
```

Recent commits (`4b2dd77`, `10093ad`) moved Quiz + Stats into a shared
`.nav-row` on the five tab-shell pages and relabeled the Stats button
`(Stats)`. The artist-page nav was never touched, so all 630 generated
pages currently show a five-item flat nav with plain `Stats`, visually
inconsistent with every other page in the app. This may be intentional
(the artist page is a simpler leaf template using real `<a>` navigation
rather than the JS tab router, so it doesn't strictly need the `.nav-row`
grouping), but flagging since it's the same kind of drift the last several
UI-polish commits were fixing elsewhere — worth a decision either way
rather than leaving it as an unnoticed inconsistency. If it should match,
the fix is in `ARTIST_PAGE_TEMPLATE` plus a regenerate
(`generate_artist_pages`), not hand-editing the generated files.

## 5. A few `shared.js` exports have no external caller

`artistNameLinkHtml`, `wikipediaSearchUrl`, and `toggleFavorite` are all
included in `window.MuseumShared`'s returned object, but neither `app.js`
nor `artist-page.js` (the only two consumers) call them directly — each is
only used internally within `shared.js` itself (`artistLinksHtml` calls
`artistNameLinkHtml`; `wikiLinkHtml` calls `wikipediaSearchUrl`;
`makeFavButton` calls `toggleFavorite`). Not dead code — just public
surface nothing currently uses. Low priority; only worth trimming if
`MuseumShared`'s API surface becomes something worth keeping minimal on
purpose.

## Not flagged (checked, found clean)

- No unused CSS classes/selectors — cross-checked every class in
  `style.css` against all JS/HTML/`fetch_data.py` and every one is
  referenced somewhere.
- All five tab-shell `index.html` files are still byte-identical
  (`md5sum` match).
- `.btn-primary`'s comment ("currently just the Quiz submit button") is
  still accurate — it's the only element using that class across all five
  shells.
- No leftover references to the old 9-item quiz/study set size, the old
  3-column grid, or the removed `.quiz-field-label` class — all fully
  cleaned up in earlier commits.
