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
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API_URL = "https://admin.studiomuseum.org/api"
PAGE_SIZE = 100
REQUEST_DELAY_SECONDS = 0.3
OUTPUT_JS = Path(__file__).parent / "docs" / "data.js"
OUTPUT_JSON = Path(__file__).parent / "data" / "artworks.json"

WIKI_API_BASE = "https://en.wikipedia.org"
WIKI_USER_AGENT = "museum-flashcards-fetcher/1.0 (personal study app; contact via GitHub)"
WIKI_REQUEST_DELAY_SECONDS = 0.4
OUTPUT_ARTISTS_JS = Path(__file__).parent / "docs" / "artists.js"
OUTPUT_ARTISTS_JSON = Path(__file__).parent / "data" / "artists_wiki.json"

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
# Strategy per artist name, cheapest/most-confident first:
#   1. REST summary for the name as-is.
#   2. REST summary for "<name> (artist)" (common disambiguation pattern).
#   3. Wikipedia search API, but only accepted if the top hit's title is a
#      close match to the artist's name (catches minor title variations
#      like accents/hyphenation; NOT a general fuzzy/semantic search — we'd
#      rather link nothing than link the wrong person).
# At every tier, if we know the artist's birth year (from the museum's own
# data) and the candidate's lead paragraph mentions a conflicting year,
# the candidate is rejected. Artists with no confident match get a
# Wikipedia search-results link instead of an article link, and no hover
# extract.


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


def parse_birth_death(artist_dates: str | None) -> tuple[int | None, int | None]:
    """Handles every format seen in this dataset: "b. 1960" (birth only),
    "1920-2003" / "1920–2003" (en-dash or hyphen, optionally spaced),
    "1886/87-1988" (ambiguous birth year), "c. 1765-after 1825"
    (approximate). Just grabbing every 4-digit number and taking the first
    as birth / last as death (when a second one exists) covers all of it."""
    if not artist_dates:
        return None, None
    years = [int(y) for y in re.findall(r"\d{4}", artist_dates)]
    if not years:
        return None, None
    if len(years) == 1:
        return years[0], None
    return years[0], years[-1]


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


def parse_birth_year(artist_dates: str | None) -> int | None:
    return parse_birth_death(artist_dates)[0]


def normalize_for_compare(s: str) -> str:
    s = s.lower()
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def titles_close(a: str, b: str) -> bool:
    """True only if one name is the other's words, in the same order, plus
    optional extra trailing/leading words (e.g. "Name" within "Name
    (artist)"). Order matters: an unordered word-set check would accept
    "Chase Hall" for the Wikipedia article "Charlie Hall Chase" (a horse
    race, not a person) purely because both share the words "chase"/"hall"
    — this catches accents/formatting variations without that risk."""
    na, nb = normalize_for_compare(a), normalize_for_compare(b)
    if na == nb:
        return True
    if not na or not nb:
        return False
    padded_a, padded_b = f" {na} ", f" {nb} "
    return padded_a in padded_b or padded_b in padded_a


def extract_years(text: str, limit: int) -> list[int]:
    return [int(y) for y in re.findall(r"\b(1[5-9]\d{2}|20\d{2})\b", text[:limit])]


def year_conflicts(expected_year: int | None, summary: dict) -> bool:
    """Best-effort sanity check against Wikidata's short description (e.g.
    "American artist (born 1960)" or "(1911-1988)"), which is far more
    reliable for this than scanning the prose lead paragraph — free text
    often mentions an unrelated year (graduation, first show, etc.) before
    the birth year ever appears."""
    if expected_year is None:
        return False
    description = summary.get("description") or ""
    found = extract_years(description, limit=len(description))
    if not found:
        # description had no year at all; check just the first sentence of
        # the lead paragraph as a lower-confidence fallback
        found = extract_years(summary.get("extract") or "", limit=120)
    if not found:
        return False
    return all(abs(y - expected_year) > 2 for y in found)


def wiki_get(url: str, retries: int = 4) -> dict | None:
    req = urllib.request.Request(
        url, headers={"User-Agent": WIKI_USER_AGENT, "Accept": "application/json"}
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt < retries - 1 and (e.code == 429 or e.code >= 500):
                time.sleep(3 * (attempt + 1))
                continue
            return None
        except urllib.error.URLError:
            if attempt < retries - 1:
                time.sleep(2)
                continue
            return None
    return None


def wiki_summary(title: str) -> dict | None:
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="_()")
    result = wiki_get(f"{WIKI_API_BASE}/api/rest_v1/page/summary/{encoded}")
    time.sleep(WIKI_REQUEST_DELAY_SECONDS)
    return result


def wiki_search_title(query: str) -> str | None:
    params = urllib.parse.urlencode(
        {"action": "query", "list": "search", "srsearch": query, "format": "json", "srlimit": 3}
    )
    data = wiki_get(f"{WIKI_API_BASE}/w/api.php?{params}")
    time.sleep(WIKI_REQUEST_DELAY_SECONDS)
    if not data:
        return None
    hits = data.get("query", {}).get("search", [])
    return hits[0]["title"] if hits else None


def strip_middle_initials(name: str) -> str | None:
    """"Gwendolyn C. Knight" -> "Gwendolyn Knight" — Wikipedia article
    titles frequently drop middle initials the museum's records keep."""
    words = name.split()
    if len(words) < 3:
        return None
    kept = [w for i, w in enumerate(words) if not (0 < i < len(words) - 1 and re.fullmatch(r"[A-Z]\.?", w))]
    if len(kept) == len(words):
        return None
    return " ".join(kept)


ART_KEYWORDS = (
    "artist", "painter", "photographer", "sculptor", "printmaker", "illustrator",
    "muralist", "ceramicist", "ceramist", "collagist", "filmmaker", "curator",
    "designer", "installation art", "multimedia artist", "visual artist",
    "conceptual art", "contemporary art", "art historian", "art collective",
    "weaver", "textile", "quilter", "cartoonist", "graphic novelist",
    "art director", "fiber art", "video art", "performance art",
    "composer", "musician", "choreographer", "sound artist",
)


def looks_art_related(summary: dict) -> bool:
    text = f"{summary.get('description') or ''} {summary.get('extract') or ''}".lower()
    return any(kw in text for kw in ART_KEYWORDS)


def find_wikipedia_match(name: str, expected_year: int | None) -> dict | None:
    # Even a literal, exact-name title lookup can silently land on an
    # unrelated page via a genuine Wikipedia redirect — e.g. "Larry Potter"
    # redirects to "Legal disputes over the Harry Potter series", "Catti"
    # redirects to an ancient Germanic tribe. The art-relatedness check
    # therefore applies to every tier, not just the fuzzier search fallback.
    #
    # "(artist)" is tried before the plain name: when two notable people
    # share a name (e.g. Nick Cave the musician vs. Nick Cave the visual
    # artist), the disambiguated page is the correct one for this context,
    # and both may independently pass the art-relatedness gate.
    candidates = [f"{name} (artist)", name]
    stripped = strip_middle_initials(name)
    if stripped:
        candidates.append(stripped)

    for title in candidates:
        summary = wiki_summary(title)
        if not summary or summary.get("type") == "disambiguation":
            continue
        if year_conflicts(expected_year, summary):
            continue
        if not looks_art_related(summary):
            continue
        return summary

    found_title = wiki_search_title(name)
    if found_title and titles_close(name, found_title):
        summary = wiki_summary(found_title)
        if summary and summary.get("type") != "disambiguation":
            if not year_conflicts(expected_year, summary) and looks_art_related(summary):
                return summary

    return None


def summary_page_url(summary: dict) -> str:
    url = summary.get("content_urls", {}).get("desktop", {}).get("page")
    if url:
        return url
    encoded = urllib.parse.quote(summary["title"].replace(" ", "_"), safe="_()")
    return f"{WIKI_API_BASE}/wiki/{encoded}"


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
<title>Museum Flashcards — Studio Museum in Harlem</title>
<link rel="stylesheet" href="../../style.css">
</head>
<body>
<header class="app-header">
  <h1>Museum Flashcards</h1>
  <p class="subtitle">Studio Museum in Harlem collection</p>
</header>

<div class="app-shell">
  <nav class="side-nav">
    <a class="nav-btn" href="../../study/">Study</a>
    <a class="nav-btn" href="../../quiz/">Quiz</a>
    <a class="nav-btn" href="../../favorites/">Favorites</a>
    <a class="nav-btn" href="../../stats/">Stats</a>
    <a class="nav-btn active" href="../../artists/">All Artists</a>
  </nav>

  <main>
    <a class="back-link" href="../../artists/">&larr; All Artists</a>
    <div id="artist-header" class="artist-header"></div>
    <div id="artist-grid" class="browse-grid"></div>
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
<script src="../../artists.js"></script>
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

    artworks = [a for a in (normalize(e) for e in raw_entries) if a is not None]
    skipped = len(raw_entries) - len(artworks)
    print(f"Kept {len(artworks)} artworks with usable image + artist data ({skipped} skipped).")

    write_json_and_js(OUTPUT_JSON, OUTPUT_JS, "ARTWORKS", artworks)
    print(f"Wrote {OUTPUT_JSON} and {OUTPUT_JS}")

    artist_names = collect_artist_names(raw_entries)
    birth_years = collect_artist_birth_years(raw_entries)
    print(f"Looking up {len(artist_names)} unique artists on Wikipedia (this takes a few minutes)...")
    artist_wiki = build_artist_wiki_lookup(artist_names, birth_years)

    write_json_and_js(OUTPUT_ARTISTS_JSON, OUTPUT_ARTISTS_JS, "ARTIST_WIKI", artist_wiki, sort_keys=True)
    print(f"Wrote {OUTPUT_ARTISTS_JSON} and {OUTPUT_ARTISTS_JS}")

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
