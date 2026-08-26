#!/usr/bin/env python3
"""
Pulls artwork data (title, artist, date, medium, image) from the Studio
Museum in Harlem's public GraphQL API and writes it out as a JS file the
flashcard app can load directly (no server/build step required).

Also resolves each artist name to a Wikipedia article (URL + lead
paragraph) via Wikipedia's public REST API, so the app can show a link
and hover preview on every artist name. This step re-queries Wikipedia
for every artist on every run (no caching) — with ~630 artists and a
rate-limiting delay between requests, expect it to take several minutes.

Usage:
    python3 fetch_data.py
"""

import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

from wiki_match import (
    WIKI_API_BASE,
    find_wikipedia_match,
    parse_birth_death,
    parse_birth_year,
    summary_page_url,
)

API_URL = "https://admin.studiomuseum.org/api"
PAGE_SIZE = 100
REQUEST_DELAY_SECONDS = 0.3
OUTPUT_JS = Path(__file__).parent / "docs" / "data.js"
OUTPUT_JSON = Path(__file__).parent / "data" / "artworks.json"

OUTPUT_ARTIST_WIKI_JS = Path(__file__).parent / "docs" / "artist-wiki.js"
OUTPUT_ARTIST_WIKI_JSON = Path(__file__).parent / "data" / "artists_wiki.json"

OUTPUT_ARTISTS_INDEX_JS = Path(__file__).parent / "docs" / "artists_index.js"
OUTPUT_ARTISTS_INDEX_JSON = Path(__file__).parent / "data" / "artists_index.json"
ARTIST_PAGES_DIR = Path(__file__).parent / "docs" / "artist"

ARTWORK_FIELDS = """
    id
    slug
    title
    artworkNetxDate
    artworkNetxMedium
    artworkNetxDimensions
    artworkMedia {
        url
        width
        height
    }
    artworkType {
        title
    }
    artists: artworkArtist {
        ... on allArtists_allArtists_Entry {
            id
            slug
            title
            artistDates
        }
    }
"""


def graphql(query: str) -> dict:
    body = json.dumps({"query": query}).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "museum-flashcards-fetcher/1.0 (personal study app)",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read())
    if "errors" in payload:
        raise RuntimeError(f"GraphQL errors: {payload['errors']}")
    return payload["data"]


def fetch_total_count() -> int:
    data = graphql('query { entryCount(type: "allArtworks") }')
    return data["entryCount"]


def fetch_page(limit: int, offset: int) -> list[dict]:
    query = f"""
    query {{
        entries(type: "allArtworks", limit: {limit}, offset: {offset}) {{
            ... on allArtworks_allArtworks_Entry {{
                {ARTWORK_FIELDS}
            }}
        }}
    }}
    """
    data = graphql(query)
    return data["entries"]


# ---------- Deduplication ----------
#
# The museum's own collection database contains true duplicate entries for
# some works — e.g. Bob Thompson's "The Gambol" exists as two separate
# records with the same artist/title/date, one apparently a later
# re-photograph/re-catalog of the same physical work (a fresh imgix
# filename, a Craft-CMS-style "-2" slug). Left in, these double-count that
# work everywhere downstream: artist pages, All Artists' work counts,
# Study/Quiz pools. Applied to raw_entries before anything else in main()
# derives from them, so every downstream consumer (normalize, the artist
# aggregates, the Wikipedia name list) sees the deduplicated set.


def dedupe_key_raw(entry: dict) -> tuple:
    artists = entry.get("artists") or []
    artist_names = tuple(a["title"] for a in artists if a.get("title"))
    title = entry.get("title") or "Untitled"
    date = entry.get("artworkNetxDate") or "Date unknown"
    return (artist_names, title, date)


def dedupe_score_raw(entry: dict) -> tuple:
    """Prefer whichever duplicate normalize() would actually keep data
    from: valid media + artists first (never discard the only usable copy
    in a group), then a recorded medium, then longer/more complete
    dimensions text, then — as a last-resort tiebreak, since some
    duplicate pairs are otherwise identical — the higher/most-recently-
    added id."""
    media = entry.get("artworkMedia") or []
    has_usable = bool(media and media[0].get("url") and (entry.get("artists") or []))
    medium = entry.get("artworkNetxMedium")
    dims = entry.get("artworkNetxDimensions")
    return (has_usable, bool(medium), bool(dims), len(dims or ""), int(entry["id"]))


def dedupe_entries(raw_entries: list[dict]) -> list[dict]:
    groups: dict[tuple, list[dict]] = {}
    order: list[tuple] = []
    for entry in raw_entries:
        key = dedupe_key_raw(entry)
        if key not in groups:
            order.append(key)
        groups.setdefault(key, []).append(entry)

    deduped = []
    removed = 0
    for key in order:
        group = groups[key]
        if len(group) == 1:
            deduped.append(group[0])
            continue
        removed += len(group) - 1
        deduped.append(max(group, key=dedupe_score_raw))

    print(f"Deduplicated {removed} repeated collection entries ({len(deduped)} unique works kept).")
    return deduped


def decade_from_date(date_text: str | None) -> str | None:
    if not date_text:
        return None
    match = re.search(r"\d{4}", date_text)
    if not match:
        return None
    year = int(match.group())
    return f"{(year // 10) * 10}s"


def normalize(entry: dict) -> dict | None:
    media = entry.get("artworkMedia") or []
    artists = entry.get("artists") or []
    if not media or not media[0].get("url") or not artists:
        return None

    date = entry.get("artworkNetxDate") or "Date unknown"
    types = [t["title"] for t in (entry.get("artworkType") or []) if t.get("title")]

    return {
        "id": entry["id"],
        "slug": entry["slug"],
        "title": entry.get("title") or "Untitled",
        "artist": ", ".join(a["title"] for a in artists if a.get("title")),
        "artistSlugs": [a["slug"] for a in artists if a.get("slug")],
        "artistDates": next((a.get("artistDates") for a in artists if a.get("artistDates")), None),
        "date": date,
        "decade": decade_from_date(date),
        "types": types,
        "medium": entry.get("artworkNetxMedium") or "Medium not recorded",
        "dimensions": entry.get("artworkNetxDimensions"),
        "image": media[0]["url"],
    }


# ---------- Wikipedia artist lookup ----------
#
# The matching logic lives in wiki_match.py (shared with the ARTIST_DATA/
# research project); see its docstring for the tiered strategy. Artists
# with no confident match get a Wikipedia search-results link instead of
# an article link, and no hover extract.


def collect_artist_names(raw_entries: list[dict]) -> set[str]:
    names: set[str] = set()
    for entry in raw_entries:
        for a in entry.get("artists") or []:
            if a.get("title"):
                names.add(a["title"])
    return names


def collect_artist_birth_years(raw_entries: list[dict]) -> dict[str, str]:
    birth_years: dict[str, str] = {}
    for entry in raw_entries:
        for a in entry.get("artists") or []:
            name = a.get("title")
            dates = a.get("artistDates")
            if name and dates and name not in birth_years:
                birth_years[name] = dates
    return birth_years


def collect_artist_records(raw_entries: list[dict]) -> dict[str, dict]:
    """One record per artist slug, aggregated across every artwork they're
    credited on: display name, raw date string, per-genre (artwork type)
    work counts, and total artwork count. Genre counts count occurrences,
    not distinct works — a work with two types (e.g. "Work on Paper" and
    "Print") adds one to each of that artist's genre counts, matching how
    the existing medium filter elsewhere in the app already counts."""
    records: dict[str, dict] = {}
    for entry in raw_entries:
        types = [t["title"] for t in (entry.get("artworkType") or []) if t.get("title")]
        for a in entry.get("artists") or []:
            slug = a.get("slug")
            name = a.get("title")
            if not slug or not name:
                continue
            rec = records.setdefault(
                slug,
                {"name": name, "slug": slug, "artistDates": None, "genres": {}, "artworkCount": 0},
            )
            if not rec["artistDates"] and a.get("artistDates"):
                rec["artistDates"] = a.get("artistDates")
            rec["artworkCount"] += 1
            for t in types:
                rec["genres"][t] = rec["genres"].get(t, 0) + 1
    return records


def build_artist_wiki_lookup(artist_names: set[str], birth_years: dict[str, str]) -> dict[str, dict]:
    lookup: dict[str, dict] = {}
    ordered = sorted(artist_names)
    total = len(ordered)
    matched = 0

    for i, name in enumerate(ordered, start=1):
        expected_year = parse_birth_year(birth_years.get(name))
        summary = find_wikipedia_match(name, expected_year)
        if summary:
            matched += 1
            lookup[name] = {"url": summary_page_url(summary), "extract": summary.get("extract") or None}
        else:
            search_url = f"{WIKI_API_BASE}/w/index.php?search=" + urllib.parse.quote(name)
            lookup[name] = {"url": search_url, "extract": None}
        if i % 25 == 0 or i == total:
            print(f"  wikipedia lookups: {i}/{total} ({matched} matched so far)")

    print(f"Matched {matched}/{total} artists to a Wikipedia article.")
    return lookup


def build_artists_index(artist_records: dict[str, dict], artist_wiki: dict[str, dict]) -> dict[str, dict]:
    """Combines the per-artist aggregates with the already-computed
    Wikipedia lookup (keyed by name) into one slug-keyed index for the All
    Artists page and each artist's detail page."""
    index: dict[str, dict] = {}
    for slug, rec in artist_records.items():
        birth_year, death_year = parse_birth_death(rec["artistDates"])
        wiki = artist_wiki.get(rec["name"]) or {}
        index[slug] = {
            "name": rec["name"],
            "slug": slug,
            "birthYear": birth_year,
            "deathYear": death_year,
            "genres": rec["genres"],
            "artworkCount": rec["artworkCount"],
            "wikipediaUrl": wiki.get("url"),
            "wikipediaExtract": wiki.get("extract"),
        }
    return index


# Every generated file is identical apart from the CURRENT_ARTIST_SLUG line
# — all real rendering (bio header, work grid) happens client-side in
# artist-page.js from shared ARTWORKS/ARTISTS_INDEX data. Uses a __SLUG__
# placeholder + str.replace rather than str.format/f-string, since the
# inline <script> and CSS-adjacent markup below is full of literal braces
# that would otherwise need escaping.
ARTIST_PAGE_TEMPLATE = """<!DOCTYPE html>
<!-- One of ~630 generated per-artist pages (see fetch_data.py's
     generate_artist_pages). Only the CURRENT_ARTIST_SLUG line differs
     between them — everything else is rendered by artist-page.js from
     shared data, so this file stays tiny. Do not hand-edit; re-run
     fetch_data.py instead. -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Museum Flashcards — The Studio Museum in Harlem</title>
<link rel="stylesheet" href="../../style.css">
</head>
<body>
<header class="app-header">
  <h1>Museum Flashcards</h1>
  <p class="subtitle">The Studio Museum in Harlem collection</p>
</header>

<div class="app-shell">
  <nav class="side-nav">
    <a class="nav-btn" href="../../study/">Study</a>
    <a class="nav-btn" href="../../quiz/">Quiz</a>
    <a class="nav-btn active" href="../../artists/">All Artists</a>
    <a class="nav-btn" href="../../favorites/">Favorites</a>
    <a class="nav-btn" href="../../stats/">Stats</a>
  </nav>

  <main>
    <a class="back-link" href="../../artists/">&larr; All Artists</a>
    <div id="artist-header" class="artist-header"></div>
    <div id="artist-grid" class="work-grid"></div>
  </main>
</div>

<div id="image-preview" class="image-preview hidden">
  <div class="image-preview-inner">
    <img id="image-preview-img" alt="">
  </div>
</div>

<div id="wiki-preview" class="wiki-preview hidden"></div>

<script>const CURRENT_ARTIST_SLUG = "__SLUG__";</script>
<script src="../../data.js"></script>
<script src="../../artist-wiki.js"></script>
<script src="../../artists_index.js"></script>
<script src="../../shared.js"></script>
<script src="../../artist-page.js"></script>
</body>
</html>
"""


def generate_artist_pages(artists_index: dict[str, dict]) -> None:
    ARTIST_PAGES_DIR.mkdir(parents=True, exist_ok=True)
    existing_dirs = {p.name for p in ARTIST_PAGES_DIR.iterdir() if p.is_dir()}
    current_slugs = set(artists_index.keys())

    for slug in current_slugs:
        page_dir = ARTIST_PAGES_DIR / slug
        page_dir.mkdir(parents=True, exist_ok=True)
        # JSON-escape the slug for safety inside the inline <script> even
        # though museum slugs are already clean lowercase-hyphenated ASCII.
        html = ARTIST_PAGE_TEMPLATE.replace("__SLUG__", json.dumps(slug)[1:-1])
        (page_dir / "index.html").write_text(html, encoding="utf-8")

    # Artists dropped from the collection since the last run leave behind a
    # stale page otherwise — remove any directory that's no longer current.
    stale = existing_dirs - current_slugs
    for slug in stale:
        stale_dir = ARTIST_PAGES_DIR / slug
        (stale_dir / "index.html").unlink(missing_ok=True)
        try:
            stale_dir.rmdir()
        except OSError:
            pass

    print(f"Generated {len(current_slugs)} artist pages ({len(stale)} stale ones removed).")


def write_json_and_js(
    json_path: Path, js_path: Path, var_name: str, data, sort_keys: bool = False
) -> None:
    """Every dataset this script produces is written twice: a pretty-printed
    JSON file (for inspection/version control) and a JS file that just
    assigns the same data to a top-level const, since the frontend loads
    everything via plain <script> tags rather than fetch()."""
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(data, indent=2, sort_keys=sort_keys), encoding="utf-8")

    js_path.parent.mkdir(parents=True, exist_ok=True)
    js_content = "// Generated by fetch_data.py — do not edit by hand.\n"
    js_content += f"const {var_name} = {json.dumps(data, sort_keys=sort_keys)};\n"
    js_path.write_text(js_content, encoding="utf-8")


def main() -> None:
    total = fetch_total_count()
    print(f"Studio Museum collection reports {total} artworks. Fetching...")

    raw_entries: list[dict] = []
    offset = 0
    while offset < total:
        page = fetch_page(PAGE_SIZE, offset)
        raw_entries.extend(page)
        offset += PAGE_SIZE
        print(f"  fetched {min(offset, total)}/{total}")
        time.sleep(REQUEST_DELAY_SECONDS)

    raw_entries = dedupe_entries(raw_entries)

    artworks = [a for a in (normalize(e) for e in raw_entries) if a is not None]
    skipped = len(raw_entries) - len(artworks)
    print(f"Kept {len(artworks)} artworks with usable image + artist data ({skipped} skipped).")

    write_json_and_js(OUTPUT_JSON, OUTPUT_JS, "ARTWORKS", artworks)
    print(f"Wrote {OUTPUT_JSON} and {OUTPUT_JS}")

    artist_names = collect_artist_names(raw_entries)
    birth_years = collect_artist_birth_years(raw_entries)
    print(f"Looking up {len(artist_names)} unique artists on Wikipedia (this takes a few minutes)...")
    artist_wiki = build_artist_wiki_lookup(artist_names, birth_years)

    write_json_and_js(OUTPUT_ARTIST_WIKI_JSON, OUTPUT_ARTIST_WIKI_JS, "ARTIST_WIKI", artist_wiki, sort_keys=True)
    print(f"Wrote {OUTPUT_ARTIST_WIKI_JSON} and {OUTPUT_ARTIST_WIKI_JS}")

    artist_records = collect_artist_records(raw_entries)
    artists_index = build_artists_index(artist_records, artist_wiki)

    write_json_and_js(
        OUTPUT_ARTISTS_INDEX_JSON, OUTPUT_ARTISTS_INDEX_JS, "ARTISTS_INDEX", artists_index, sort_keys=True
    )
    print(f"Wrote {OUTPUT_ARTISTS_INDEX_JSON} and {OUTPUT_ARTISTS_INDEX_JS}")
    print(f"{len(artists_index)} artist records built.")

    generate_artist_pages(artists_index)


if __name__ == "__main__":
    main()
