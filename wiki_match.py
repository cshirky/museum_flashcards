#!/usr/bin/env python3
"""
Wikipedia artist matcher — shared by fetch_data.py (the flashcards data
pipeline) and the missing-Wikipedia-pages research project in ARTIST_DATA/.

Strategy per artist name, cheapest/most-confident first:
  0. MANUAL_WIKI_MATCHES — hand-verified name -> article title overrides.
  1. REST summary for "<name> (artist)" (common disambiguation pattern).
  2. REST summary for the name as-is.
  3. REST summary with middle initials stripped.
  4. Wikipedia search API, but only accepted if the top hit's title is a
     close match to the artist's name (catches minor title variations
     like accents/hyphenation; NOT a general fuzzy/semantic search — we'd
     rather link nothing than link the wrong person).
At every tier, if we know the artist's birth year (from the museum's own
data) and the candidate's description mentions a conflicting year, the
candidate is rejected, as is any candidate whose description/lead has no
art-related keyword.

Usage:
    python3 wiki_match.py "Artist Name" [--dates "b. 1950"]
    python3 wiki_match.py --recheck ARTIST_DATA/ARTIST_IMAGE_NOWIKI.md

--recheck parses "## N. Artist Name" headings (numbered or not) and their
"- Dates:" lines from a markdown file in the ARTIST_DATA conventions and
reports any names the matcher can now resolve — artists gain Wikipedia
pages over time, so this is meant to be re-run occasionally.
"""

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

WIKI_API_BASE = "https://en.wikipedia.org"
WIKI_USER_AGENT = "museum-flashcards-fetcher/1.0 (personal study app; contact via GitHub)"
WIKI_REQUEST_DELAY_SECONDS = 0.4


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
    # "photograph" (not "photographer") also catches "photography"/"photographed";
    # "photojournal" catches photojournalist/photojournalism, which contain
    # neither — a gap that cost us Robert A. Sengstacke and LeRoy Woodson.
    "artist", "painter", "photograph", "photojournal", "sculptor", "printmaker", "illustrator",
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


# Hand-verified matches for names the automatic tiers get wrong or miss —
# Wikipedia titles the page differently, the museum's spelling differs, or
# the plain name lands on a namesake/disambiguation page. Checked against
# the museum's artist dates; see ARTIST_DATA/ARTIST_IMAGE_NOWIKI.md history.
MANUAL_WIKI_MATCHES = {
    "Al Loving": "Alvin D. Loving",
    "Antony Charles Robert Armstrong-Jones": "Antony Armstrong-Jones, 1st Earl of Snowdon",
    "Asiru Olatunde": "Asiru Olatunde",
    "Bob Thompson": "Bob Thompson (painter)",
    "Bourmand Byron": "Bourmond Byron",
    "Carol Byard": "Carole Byard",
    "Catti": "Catherine James Catti",
    "Chester Higgins": "Chester Higgins Jr.",
    "Christian Walker": "Christian Walker (photographer)",
    "Cynthia Hawkins": "Cynthia Hawkins",
    "Dana C. Chandler Jr.": "Dana Chandler",
    "Deborah Roberts": "Deborah Roberts (visual artist)",
    "Derek Walcott": "Derek Walcott",
    "Dr. Eugene Grigsby": "J. Eugene Grigsby",
    "Dr.Charles Smith": "Dr. Charles Smith",
    "Earlie Hudnall Jr.": "Earlie Hudnall, Jr.",
    "Elliott Jerome Brown Jr.": "Elliott Jerome Brown Jr.",
    "Emma Amos": "Emma Amos (painter)",
    "Enida Beal": "Endia Beal",
    "Frank Stewart": "Frank Stewart (artist)",
    "Frank Wimberly": "Frank Wimberley",
    "Herbert Alexander Gentry": "Herbert Gentry",
    "James L. Wells": "James Lesesne Wells",
    "James Little": "James Little (painter)",
    "Jeanne Raynal": "Jeanne Reynal",
    "Jules Allen": "Jules T. Allen",
    "Kameelah Janan Rasheed": "Kameelah Janan Rasheed",
    "Leroy Woodson": "LeRoy Woodson",
    "Mallica Kapo Reynolds": "Mallica Reynolds",
    "Michael Cummings": "Michael A. Cummings",
    "Michael Platt": "Michael B. Platt",
    "Michael Richards": "Michael Richards (sculptor)",
    "Mose Ernest Tolliver": "Mose Tolliver",
    "Noah Davis": "Noah Davis (painter)",
    "P.H. Polk": "P. H. Polk",
    "Prophet Royal Robertson": "Royal Robertson",
    "Robert A. Pruitt": "Robert Pruitt (artist)",
    "Robert A. Sengstacke": "Robert A. Sengstacke",
    "Rushern Baker": "Rushern Baker IV",
    "Thorton Dial": "Thornton Dial",
    "Tim Rollins & K.O.S": "Tim Rollins and K.O.S.",
    "Walter Williams": "Walter H. Williams",
    "Zora J Murff": "Zora J. Murff",
    "Zwelethu Mthethwa": "Zwelethu Mthethwa",
}


def find_wikipedia_match(name: str, expected_year: int | None) -> dict | None:
    manual_title = MANUAL_WIKI_MATCHES.get(name)
    if manual_title:
        summary = wiki_summary(manual_title)
        if summary and summary.get("type") != "disambiguation":
            return summary
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


# ---------- CLI ----------


def _report(name: str, dates: str | None) -> bool:
    summary = find_wikipedia_match(name, parse_birth_year(dates))
    if summary:
        print(f"MATCH  {name} ({dates or 'no dates'}) -> {summary['title']}")
        print(f"       {summary_page_url(summary)}")
        print(f"       {summary.get('description') or (summary.get('extract') or '')[:100]}")
        return True
    print(f"no match  {name} ({dates or 'no dates'})")
    return False


def _recheck(path: str) -> None:
    md = open(path, encoding="utf-8").read()
    entries = re.findall(r"^## (?:\d+\. )?(.+)\n\n- Dates: (.+)$", md, re.M)
    print(f"{len(entries)} entries in {path}")
    matched = 0
    for name, dates in entries:
        if _report(name.strip(), None if dates.strip() == "—" else dates.strip()):
            matched += 1
    print(f"\n{matched}/{len(entries)} matched")


def main() -> None:
    parser = argparse.ArgumentParser(description="Match artist names to Wikipedia articles.")
    parser.add_argument("name", nargs="?", help="artist name to look up")
    parser.add_argument("--dates", help='museum dates string, e.g. "b. 1950" or "1920–2003"')
    parser.add_argument("--recheck", metavar="FILE", help="re-run the matcher over an ARTIST_DATA markdown list")
    args = parser.parse_args()

    if args.recheck:
        _recheck(args.recheck)
    elif args.name:
        _report(args.name, args.dates)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
