"""
final_filter.py

Reads filtered.json (JSONL) and writes final_furniture.json (JSONL),
keeping the first 3 items per category whose Amazon URL is actually live.

A URL is considered NOT live if:
  - The HTTP request errors out (network error, timeout, etc.)
  - The HTTP status is not in the 2xx range after following redirects
  - The page body contains a known "dead page" marker such as
    "not a live page" or "page not found"

Once a category has 3 valid items we stop checking that category and skip
remaining items of that category. If a category has fewer than 3 valid items
in the file, we keep whatever valid ones we found.

Results of URL checks are cached in a sidecar file (`url_cache.json`) so
re-runs only re-check URLs whose status is unknown. Delete that file to
force re-validation.

Input:  filtered.json
Output: final_furniture.json
Cache:  url_cache.json
"""

import json
import time
from collections import defaultdict
from pathlib import Path

import requests

INPUT_PATH = Path(__file__).parent / "filtered.json"
OUTPUT_PATH = Path(__file__).parent / "final_furniture.json"
CACHE_PATH = Path(__file__).parent / "url_cache.json"

MAX_PER_CATEGORY = 3
REQUEST_TIMEOUT = 20          # seconds
DELAY_BETWEEN_REQUESTS = 0.6  # seconds, be polite to Amazon

# Looked for in the lowercased page body. Any hit means the page is dead.
DEAD_PAGE_MARKERS = (
    "not a live page",                       # the exact phrase Amazon shows
    "we're sorry. the web address",
    "the web address you entered is not",
    "looking for something?",                # appears alongside dogs-of-amazon page
    "page not found",
    "sorry, we couldn't find that page",
)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def load_cache():
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print("Cache file is corrupt, starting with empty cache.")
    return {}


def save_cache(cache):
    CACHE_PATH.write_text(
        json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8"
    )


def is_url_live(url, session):
    """Return True if the URL fetches successfully and the page body
    does not look like an Amazon dead-page error."""
    try:
        resp = session.get(
            url,
            headers=HEADERS,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
    except requests.RequestException as e:
        print(f"    network error: {e}")
        return False

    if not (200 <= resp.status_code < 300):
        print(f"    bad status: {resp.status_code}")
        return False

    body = resp.text.lower()
    for marker in DEAD_PAGE_MARKERS:
        if marker in body:
            print(f"    dead-page marker hit: {marker!r}")
            return False

    return True


def main():
    cache = load_cache()
    counts = defaultdict(int)
    seen_in_input = defaultdict(int)
    kept = []

    session = requests.Session()

    with INPUT_PATH.open("r", encoding="utf-8") as f_in:
        for line_num, raw_line in enumerate(f_in, start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"Skipping malformed JSON on line {line_num}: {e}")
                continue

            category = item.get("category")
            url = item.get("url")
            if category is None or not url:
                continue

            seen_in_input[category] += 1

            # Already filled this category: skip without spending a request.
            if counts[category] >= MAX_PER_CATEGORY:
                continue

            # Use cache when possible.
            if url in cache:
                live = cache[url]
                cached_marker = " (cached)"
            else:
                print(f"[{category}] checking {url}")
                live = is_url_live(url, session)
                cache[url] = live
                save_cache(cache)
                time.sleep(DELAY_BETWEEN_REQUESTS)
                cached_marker = ""

            status = "LIVE" if live else "DEAD"
            running = counts[category] + (1 if live else 0)
            print(f"  -> {status}{cached_marker}  ({category} {running}/{MAX_PER_CATEGORY})")

            if live:
                kept.append(item)
                counts[category] += 1

    with OUTPUT_PATH.open("w", encoding="utf-8") as f_out:
        for item in kept:
            f_out.write(json.dumps(item, ensure_ascii=False) + "\n")

    print()
    print(f"Wrote {len(kept)} items to {OUTPUT_PATH.name}")
    print("Per-category results (kept / seen-in-input):")
    all_cats = sorted(set(seen_in_input) | set(counts))
    for cat in sorted(all_cats, key=lambda c: (-counts[c], c)):
        print(f"  {cat:<18}{counts[cat]} / {seen_in_input[cat]}")

    short = [c for c in all_cats if counts[c] < MAX_PER_CATEGORY]
    if short:
        print()
        print("Categories that did not reach 3 valid items:")
        for c in short:
            print(f"  {c}: only {counts[c]} valid out of {seen_in_input[c]}")


if __name__ == "__main__":
    main()
