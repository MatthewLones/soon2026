"""
final_filter.py

Reads filtered.json (JSONL) and writes final_furniture.json (JSONL),
keeping every USD (amazon.com) item whose URL is live, with the current
USD price scraped from the listing.

A URL is considered NOT live if:
  - The HTTP request errors out (network error, timeout, etc.)
  - The HTTP status is not in the 2xx range after following redirects
  - The page body contains a known "dead page" marker such as
    "not a live page" or "page not found"

Non-amazon.com URLs are skipped entirely so every output item carries a
real USD price.

Per-category cap is effectively disabled (MAX_PER_CATEGORY = 999) — every
live USD item makes it through.

Results of URL checks are cached in `url_cache.json` as
  {url: {"live": bool, "price_usd": float|null, "checked_at": "YYYY-MM-DD"}}
Bare-bool entries from the old schema are migrated transparently on load
(treated as "known liveness, unknown price" and re-fetched once for price).
Delete the cache file to force full re-validation.

Input:  filtered.json
Output: final_furniture.json
Cache:  url_cache.json
"""

import json
import random
import re
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

import requests

INPUT_PATH = Path(__file__).parent / "filtered.json"
# Write the catalog one level up so the app reads a single canonical file.
OUTPUT_PATH = Path(__file__).parent.parent / "final_furniture.json"
CACHE_PATH = Path(__file__).parent / "url_cache.json"

MAX_PER_CATEGORY = 999            # effectively uncapped: take every live USD item
REQUEST_TIMEOUT = 20              # seconds
DELAY_BETWEEN_REQUESTS = 4.0      # base seconds between requests
DELAY_JITTER = 2.0                # add 0..DELAY_JITTER seconds of randomness
CAPTCHA_BACKOFF_SECONDS = 60.0    # cool-down after a captcha hit
USD_URL_PREFIX = "https://www.amazon.com/"
SUSPECT_BODY_BYTES = 50_000       # real product pages are ~500KB; tiny pages are suspicious

PRICE_RE = re.compile(
    r'<span class="a-offscreen">\s*\$([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s*</span>'
)

# Looked for in the lowercased page body. Any hit means the page is dead.
DEAD_PAGE_MARKERS = (
    "not a live page",                       # the exact phrase Amazon shows
    "we're sorry. the web address",
    "the web address you entered is not",
    "looking for something?",                # appears alongside dogs-of-amazon page
    "page not found",
    "sorry, we couldn't find that page",
)

# Markers that indicate Amazon served us a bot-check page rather than the
# real product. These should NOT be cached — we want to retry on a future run.
CAPTCHA_MARKERS = (
    "captcha",
    "robot check",
    "enter the characters you see below",
    "type the characters you see in this image",
    "automated access to amazon",
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
    """Load cache, migrating any bare-bool entries from the old schema."""
    if not CACHE_PATH.exists():
        return {}
    try:
        raw = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print("Cache file is corrupt, starting with empty cache.")
        return {}

    migrated = {}
    for url, value in raw.items():
        if isinstance(value, bool):
            # Old schema: just a liveness bool. Keep liveness, mark price unknown.
            migrated[url] = {"live": value, "price_usd": None, "checked_at": None}
        elif isinstance(value, dict):
            migrated[url] = {
                "live": bool(value.get("live", False)),
                "price_usd": value.get("price_usd"),
                "checked_at": value.get("checked_at"),
            }
        # silently drop anything else
    return migrated


def save_cache(cache):
    CACHE_PATH.write_text(
        json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8"
    )


def extract_price(body):
    """Pull the first $X.XX from an Amazon listing's a-offscreen span.
    Returns a float or None."""
    m = PRICE_RE.search(body)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None


def looks_like_captcha(body, body_lower):
    """A short page that mentions captcha/robot is almost certainly a bot
    challenge, not a real product page."""
    if len(body) < SUSPECT_BODY_BYTES:
        for marker in CAPTCHA_MARKERS:
            if marker in body_lower:
                return marker
    return None


def check_url(url, session):
    """Return (status, price_usd) where status is one of:
      'live'      — real product page; price_usd may still be None for legit no-price items
      'dead'      — confirmed dead (404, bad status, dead-page marker)
      'transient' — captcha or other temporary failure; DO NOT CACHE, retry next run
    """
    try:
        resp = session.get(
            url,
            headers=HEADERS,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
    except requests.RequestException as e:
        print(f"    network error: {e}")
        return "transient", None

    if resp.status_code in (404, 410):
        print(f"    bad status: {resp.status_code}")
        return "dead", None

    if not (200 <= resp.status_code < 300):
        print(f"    transient status: {resp.status_code}")
        return "transient", None

    body = resp.text
    body_lower = body.lower()

    captcha_marker = looks_like_captcha(body, body_lower)
    if captcha_marker:
        print(f"    CAPTCHA detected ({captcha_marker!r}, body={len(body)}B) — backing off")
        time.sleep(CAPTCHA_BACKOFF_SECONDS)
        return "transient", None

    for marker in DEAD_PAGE_MARKERS:
        if marker in body_lower:
            print(f"    dead-page marker hit: {marker!r}")
            return "dead", None

    price = extract_price(body)
    if price is None:
        print(f"    live but no price found (body={len(body)}B)")
    return "live", price


def polite_sleep():
    time.sleep(DELAY_BETWEEN_REQUESTS + random.uniform(0, DELAY_JITTER))


def fetch_and_record(url, session, cache, today_iso, label):
    """Fetch a URL and update the cache, except for transient failures
    which are left out of the cache so future runs retry them."""
    print(f"{label} {url}")
    status, price_usd = check_url(url, session)

    if status == "transient":
        # Don't cache. If the URL was previously a (poisoned) cache entry, drop it
        # so the next run starts fresh on this URL.
        cache.pop(url, None)
        save_cache(cache)
        polite_sleep()
        return None, None  # signal: skip this item this run

    cache[url] = {
        "live": status == "live",
        "price_usd": price_usd,
        "checked_at": today_iso if status == "live" else None,
    }
    save_cache(cache)
    polite_sleep()
    return status == "live", price_usd


def main():
    cache = load_cache()

    # One-time clean-up: drop captcha-poisoned cache entries from prior runs.
    # Heuristic: live=True with price=None AND checked_at set is suspect
    # (real no-price products are rare; most of these came from captcha runs).
    poisoned = [
        url for url, e in cache.items()
        if e["live"] and e.get("price_usd") is None and e.get("checked_at")
    ]
    if poisoned:
        print(f"Dropping {len(poisoned)} suspect 'live, no-price' cache entries "
              "for re-validation (likely captcha-poisoned).")
        for url in poisoned:
            cache.pop(url)
        save_cache(cache)

    counts = defaultdict(int)
    seen_in_input = defaultdict(int)
    skipped_non_usd = 0
    transient_skipped = 0
    kept = []
    today_iso = date.today().isoformat()

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

            # USD-only: drop non-amazon.com URLs before any HTTP work.
            if not url.startswith(USD_URL_PREFIX):
                skipped_non_usd += 1
                continue

            seen_in_input[category] += 1

            # Already filled this category: skip without spending a request.
            if counts[category] >= MAX_PER_CATEGORY:
                continue

            entry = cache.get(url)
            cached_marker = ""

            if entry is None:
                live, price_usd = fetch_and_record(
                    url, session, cache, today_iso, f"[{category}] checking"
                )
                if live is None:
                    transient_skipped += 1
                    print("  -> SKIP (transient)")
                    continue
            elif entry["live"] and entry.get("price_usd") is None:
                # Legitimate prior no-price entry (none currently exist after
                # the cleanup above, but kept for safety): one re-fetch attempt.
                live, price_usd = fetch_and_record(
                    url, session, cache, today_iso, f"[{category}] backfilling price for"
                )
                if live is None:
                    transient_skipped += 1
                    print("  -> SKIP (transient)")
                    continue
                cached_marker = " (price-backfill)"
            else:
                live = entry["live"]
                price_usd = entry.get("price_usd")
                cached_marker = " (cached)"

            checked_at = cache.get(url, {}).get("checked_at")
            status = "LIVE" if live else "DEAD"
            running = counts[category] + (1 if live else 0)
            price_str = f"${price_usd}" if price_usd is not None else "no-price"
            print(f"  -> {status}{cached_marker}  {price_str}  ({category} {running})")

            if live:
                item["price_usd"] = price_usd
                item["price_as_of"] = checked_at
                kept.append(item)
                counts[category] += 1

    with OUTPUT_PATH.open("w", encoding="utf-8") as f_out:
        for item in kept:
            f_out.write(json.dumps(item, ensure_ascii=False) + "\n")

    print()
    print(f"Wrote {len(kept)} items to {OUTPUT_PATH.name}")
    print(f"Skipped {skipped_non_usd} non-USD items before HTTP.")
    print(f"Skipped {transient_skipped} items due to transient/captcha failures (will retry next run).")
    print("Per-category results (kept / seen-in-input):")
    all_cats = sorted(set(seen_in_input) | set(counts))
    for cat in sorted(all_cats, key=lambda c: (-counts[c], c)):
        print(f"  {cat:<18}{counts[cat]} / {seen_in_input[cat]}")

    no_price = [i for i in kept if i.get("price_usd") is None]
    if no_price:
        print()
        print(f"Live but no-price items: {len(no_price)} "
              "(Amazon page didn't expose a parseable price)")


if __name__ == "__main__":
    main()
