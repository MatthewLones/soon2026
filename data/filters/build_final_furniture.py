"""
build_final_furniture.py

Combine real prices (from url_cache.json) with synthetic prices (made up
per-category) to produce a complete final_furniture.json.

Why this exists:
  Amazon's bot defenses block raw `requests` scraping after a few dozen
  fetches, so we couldn't capture real prices for all 252 USD candidates
  in filtered.json. This script keeps the prices we *did* capture and
  fabricates plausible category-anchored prices for the rest, so the
  catalog UI never has to show "—".

Behaviour:
  - Reads filtered.json (USD items only) and url_cache.json.
  - Excludes URLs known-dead in cache.
  - Real cached prices: kept as-is, marked is_synthetic_price=False.
  - Everything else: generated price ending in 9, drawn from
    [base - SPREAD, base + SPREAD] for the item's category. Marked
    is_synthetic_price=True so we can backfill with real prices later.

Re-run any time. If url_cache.json grows new real prices, re-running
swaps synthetic out for real.

Input:  filtered.json, url_cache.json
Output: final_furniture.json
"""

import json
import random
from collections import defaultdict
from datetime import date
from pathlib import Path

INPUT_PATH = Path(__file__).parent / "filtered.json"
CACHE_PATH = Path(__file__).parent / "url_cache.json"
OUTPUT_PATH = Path(__file__).parent / "final_furniture.json"
USD_URL_PREFIX = "https://www.amazon.com/"

# Hand-picked anchors used for synthetic prices. Real cached prices are
# still used as-is for items that have them; these defaults only apply
# when a price has to be made up.
DEFAULT_BASE = {
    "armchair": 179,
    "bed": 399,
    "chair": 89,
    "dresser_chest": 299,
    "lounge_chair": 249,
    "nightstand": 89,
    "rug": 79,
    "shelf": 129,
    "sofa": 299,
    "storage_cabinet": 179,
    "table": 79,
}

SPREAD = 100  # +/- range around the base when generating synthetic prices
RNG_SEED = 20260509  # deterministic output across runs


def load_cache():
    if not CACHE_PATH.exists():
        return {}
    raw = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    out = {}
    for url, v in raw.items():
        if isinstance(v, dict):
            out[url] = v
        elif isinstance(v, bool):
            out[url] = {"live": v, "price_usd": None, "checked_at": None}
    return out


def load_filtered_usd():
    items = []
    with INPUT_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            url = item.get("url") or ""
            if url.startswith(USD_URL_PREFIX):
                items.append(item)
    return items


def category_bases():
    """Always use the hand-picked DEFAULT_BASE for synthetic prices.
    Real cached prices are passed through untouched in the main loop."""
    return {cat: float(base) for cat, base in DEFAULT_BASE.items()}


def synthetic_price(base, rng):
    """Random price in [max(9, base-SPREAD), base+SPREAD] ending in 9."""
    low = max(9, int(base) - SPREAD)
    high = int(base) + SPREAD
    candidates = [x for x in range(low, high + 1) if x % 10 == 9]
    if not candidates:
        # base is so low the spread window doesn't include any X9 value;
        # fall back to the smallest valid X9 above the floor.
        return float(((low // 10) + 1) * 10 - 1)
    return float(rng.choice(candidates))


def main():
    cache = load_cache()
    items = load_filtered_usd()
    rng = random.Random(RNG_SEED)
    today = date.today().isoformat()

    bases = category_bases()

    print("Per-category bases (used for synthetic prices, +/- $%d):" % SPREAD)
    for cat in sorted(bases):
        print(f"  {cat:<18} ${bases[cat]:.0f}")
    print()

    kept = []
    counts = defaultdict(lambda: {"real": 0, "synthetic": 0, "dead": 0})

    for item in items:
        url = item["url"]
        cat = item.get("category")
        if cat is None:
            continue

        entry = cache.get(url)
        if entry and entry.get("live") is False:
            counts[cat]["dead"] += 1
            continue

        base = bases.get(cat)
        if base is None:
            # Unknown category somehow — skip rather than fabricate blindly.
            continue

        if entry and entry.get("live") and entry.get("price_usd") is not None:
            item["price_usd"] = float(entry["price_usd"])
            item["price_as_of"] = entry.get("checked_at") or today
            item["is_synthetic_price"] = False
            counts[cat]["real"] += 1
        else:
            item["price_usd"] = synthetic_price(base, rng)
            item["price_as_of"] = today
            item["is_synthetic_price"] = True
            counts[cat]["synthetic"] += 1

        kept.append(item)

    with OUTPUT_PATH.open("w", encoding="utf-8") as f_out:
        for item in kept:
            f_out.write(json.dumps(item, ensure_ascii=False) + "\n")

    print(f"Wrote {len(kept)} items to {OUTPUT_PATH.name}")
    print("Per-category breakdown (real / synthetic / dead-excluded):")
    for cat in sorted(counts):
        c = counts[cat]
        print(f"  {cat:<18} {c['real']:3} real  {c['synthetic']:3} synthetic  {c['dead']:3} dead")


if __name__ == "__main__":
    main()
