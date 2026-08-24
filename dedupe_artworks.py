#!/usr/bin/env python3
"""
One-off fix for duplicate collection entries already baked into the
generated data files (e.g. Bob Thompson's "The Gambol" existing as two
separate records). fetch_data.py now dedupes at fetch time going forward —
this script applies the same logic retroactively to the already-fetched
data/artworks.json and data/artists_index.json without re-hitting the
Studio Museum API or re-running the (slow, uncached) Wikipedia lookups.

Usage:
    python3 dedupe_artworks.py
"""

import json
from pathlib import Path

from fetch_data import write_json_and_js

ROOT = Path(__file__).parent
ARTWORKS_JSON = ROOT / "data" / "artworks.json"
ARTWORKS_JS = ROOT / "docs" / "data.js"
ARTISTS_INDEX_JSON = ROOT / "data" / "artists_index.json"
ARTISTS_INDEX_JS = ROOT / "docs" / "artists_index.js"


def dedupe_key(a: dict) -> tuple:
    return (a["artist"], a["title"], a["date"])


def dedupe_score(a: dict) -> tuple:
    """Same priority order as fetch_data.py's dedupe_score_raw, just read
    from the already-normalized artwork shape: prefer a recorded medium,
    then longer/more complete dimensions text, then (as a last-resort
    tiebreak, since some duplicate pairs are otherwise identical) the
    higher/most-recently-added id."""
    medium = a.get("medium")
    dims = a.get("dimensions")
    return (bool(medium) and medium != "Medium not recorded", bool(dims), len(dims or ""), int(a["id"]))


def dedupe_artworks(artworks: list[dict]) -> list[dict]:
    groups: dict[tuple, list[dict]] = {}
    order: list[tuple] = []
    for a in artworks:
        k = dedupe_key(a)
        if k not in groups:
            order.append(k)
        groups.setdefault(k, []).append(a)

    deduped = []
    removed = 0
    for k in order:
        group = groups[k]
        if len(group) == 1:
            deduped.append(group[0])
            continue
        removed += len(group) - 1
        deduped.append(max(group, key=dedupe_score))

    print(f"Removed {removed} duplicate artwork records ({len(deduped)} unique works kept).")
    return deduped


def recompute_artist_aggregates(artworks: list[dict], artists_index: dict[str, dict]) -> dict[str, dict]:
    """artworkCount/genres are derived straight from ARTWORKS (the same way
    the app itself would compute them), so they can be recomputed on the
    deduped list without needing the raw per-artist API data again. Every
    other field (name, dates, Wikipedia match) is left untouched."""
    counts: dict[str, int] = {}
    genres: dict[str, dict[str, int]] = {}
    for a in artworks:
        for slug in a.get("artistSlugs") or []:
            counts[slug] = counts.get(slug, 0) + 1
            g = genres.setdefault(slug, {})
            for t in a.get("types") or []:
                g[t] = g.get(t, 0) + 1

    updated = {}
    for slug, rec in artists_index.items():
        new_rec = dict(rec)
        new_rec["artworkCount"] = counts.get(slug, 0)
        new_rec["genres"] = genres.get(slug, {})
        updated[slug] = new_rec
    return updated


def main() -> None:
    artworks = json.loads(ARTWORKS_JSON.read_text(encoding="utf-8"))
    print(f"Loaded {len(artworks)} artworks.")
    deduped = dedupe_artworks(artworks)
    write_json_and_js(ARTWORKS_JSON, ARTWORKS_JS, "ARTWORKS", deduped)
    print(f"Wrote {ARTWORKS_JSON} and {ARTWORKS_JS}")

    artists_index = json.loads(ARTISTS_INDEX_JSON.read_text(encoding="utf-8"))
    updated_index = recompute_artist_aggregates(deduped, artists_index)
    write_json_and_js(ARTISTS_INDEX_JSON, ARTISTS_INDEX_JS, "ARTISTS_INDEX", updated_index, sort_keys=True)
    print(f"Wrote {ARTISTS_INDEX_JSON} and {ARTISTS_INDEX_JS}")


if __name__ == "__main__":
    main()
