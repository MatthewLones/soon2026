"""
Filter items from a JSON file:
  1. Keep only items that have a '3dmodel_id'
  2. Remove items whose text contains any blocked keyword (kids, children, ...)
  3. Keep ONLY items in our allowed furniture categories
  4. Streamline each surviving item to just the fields we care about
Then show the distribution of 'country' values among the survivors.

Edit the config block below, then run:
    python filter_items.py
"""

import json
import re
from collections import Counter
from pathlib import Path

# ---- EDIT THESE ----------------------------------------------------------
INPUT_PATH = Path("furniture1.json")
OUTPUT_PATH = Path("filtered.json")      # set to None to skip writing

BLOCKED_KEYWORDS = ["kid", "kids", "children", "child", "toddler", "baby"]
WHOLE_WORDS_ONLY = True
PREFERRED_LANGUAGE = "en_US"

# Allow-list of furniture categories. Each category has a list of synonyms /
# variants we'll match against the item's product_type and English name.
# Matching is case-insensitive and handles underscores, hyphens, and plurals.
ALLOWED_CATEGORIES = {
    "sofa":            ["sofa", "sectional sofa", "sectional"],
    "couch":           ["couch"],
    "lounge_chair":    ["lounge chair", "lounge"],
    "armchair":        ["armchair", "arm chair", "accent chair"],
    "chair":           ["chair", "office chair", "dining chair", "side chair",
                        "rocking chair", "stool", "bar stool"],
    "table":           ["table", "coffee table", "dining table", "side table",
                        "end table", "console table", "desk"],
    "bed":             ["bed", "bed frame", "headboard", "bunk bed",
                        "platform bed", "daybed", "futon"],
    "dresser_chest":   ["dresser", "chest", "chest of drawers", "bureau"],
    "nightstand":      ["nightstand", "bedside table", "night stand"],
    "shelf":           ["shelf", "shelves", "shelving", "bookshelf",
                        "bookcase", "shelving unit"],
    "storage_cabinet": ["storage cabinet", "cabinet", "cupboard", "armoire",
                        "wardrobe", "credenza", "sideboard", "buffet"],
    "rug":             ["rug", "area rug", "carpet"],
}
# --------------------------------------------------------------------------


# ============================ Loading ====================================

def load_items(path: Path):
    """Load items from a JSON array file, or fall back to JSON Lines."""
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []

    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return [data]
    except json.JSONDecodeError:
        pass

    items = []
    for line_num, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError as e:
            print(f"Warning: skipping invalid JSON on line {line_num}: {e}")
    return items


# ============================ Filters ====================================

def has_3dmodel_id(item) -> bool:
    if not isinstance(item, dict):
        return False
    value = item.get("3dmodel_id")
    if value is None:
        return False
    if isinstance(value, (str, list)) and len(value) == 0:
        return False
    return True


def collect_strings(value):
    """Recursively yield every string found inside a nested structure."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from collect_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from collect_strings(v)


def build_blocked_pattern(keywords, whole_words_only):
    if not keywords:
        return None
    escaped = [re.escape(kw) for kw in keywords if kw]
    if not escaped:
        return None
    joined = "|".join(escaped)
    pattern = rf"\b(?:{joined})\b" if whole_words_only else f"(?:{joined})"
    return re.compile(pattern, re.IGNORECASE)


def contains_blocked_keyword(item, pattern) -> bool:
    if pattern is None:
        return False
    for s in collect_strings(item):
        if pattern.search(s):
            return True
    return False


# ----- Category allow-list -----

def normalize_text(s: str) -> str:
    """Lowercase, replace _ and - with spaces, collapse whitespace."""
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[_\-]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def build_category_patterns(allowed):
    """
    Compile one regex per category that matches any synonym as a whole word
    (or whole phrase). Plural 's' is tolerated. Returns {category: pattern}.
    """
    patterns = {}
    for category, synonyms in allowed.items():
        # Sort by length descending so multi-word synonyms get tried first
        normalized = sorted({normalize_text(s) for s in synonyms},
                            key=len, reverse=True)
        escaped = [re.escape(s) for s in normalized if s]
        if not escaped:
            continue
        # \b...s?\b allows optional plural and word-boundary safety
        joined = "|".join(escaped)
        patterns[category] = re.compile(rf"\b(?:{joined})s?\b", re.IGNORECASE)
    return patterns


def get_english_name(item) -> str:
    """Pull the English item_name if available."""
    names = item.get("item_name")
    if isinstance(names, list):
        for entry in names:
            if isinstance(entry, dict) and entry.get("language_tag") == "en_US":
                return entry.get("value") or ""
    return ""


def get_product_type_text(item) -> str:
    """Pull the product_type code (e.g. 'SOFA') as a normalized string."""
    pt = item.get("product_type")
    if isinstance(pt, list) and pt:
        first = pt[0]
        if isinstance(first, dict):
            return first.get("value") or ""
    return ""


def matched_category(item, patterns):
    """
    Return the category name the item matches, or None.
    Checks product_type first (most reliable), then English item_name.
    """
    haystacks = [
        normalize_text(get_product_type_text(item)),
        normalize_text(get_english_name(item)),
    ]
    for category, pattern in patterns.items():
        for haystack in haystacks:
            if haystack and pattern.search(haystack):
                return category
    return None


# ============================ Streamlining ===============================

def pick_localized(entries, language=PREFERRED_LANGUAGE):
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if isinstance(entry, dict) and entry.get("language_tag") == language:
            return entry.get("value")
    for entry in entries:
        if isinstance(entry, dict) and entry.get("value") is not None:
            return entry.get("value")
    return None


def simplify_dimensions(dims):
    if not isinstance(dims, dict):
        return None
    result = {}
    for key, payload in dims.items():
        if isinstance(payload, dict) and "value" in payload:
            result[key] = {
                "value": payload.get("value"),
                "unit": payload.get("unit"),
            }
    return result or None


def simplify_weight(weight):
    if isinstance(weight, list) and weight:
        first = weight[0]
        if isinstance(first, dict):
            return {"value": first.get("value"), "unit": first.get("unit")}
    return None


def build_product_url(item):
    item_id = item.get("item_id")
    domain = item.get("domain_name") or "amazon.com"
    if not item_id:
        return None
    return f"https://www.{domain}/dp/{item_id}"


def streamline(item, category=None):
    return {
        "item_id": item.get("item_id"),
        "3dmodel_id": item.get("3dmodel_id"),
        "category": category,
        "product_type": (item.get("product_type", [{}])[0].get("value")
                         if item.get("product_type") else None),
        "name": pick_localized(item.get("item_name")),
        "brand": pick_localized(item.get("brand")),
        "color": pick_localized(item.get("color")),
        "material": pick_localized(item.get("material")),
        "dimensions": simplify_dimensions(item.get("item_dimensions")),
        "weight": simplify_weight(item.get("item_weight")),
        "country": item.get("country"),
        "url": build_product_url(item),
    }


# ============================ Distribution ===============================

def get_country(item):
    country = item.get("country")
    if isinstance(country, list) and country:
        return country[0]
    return country if country else "UNKNOWN"


# ============================ Main =======================================

def main():
    items = load_items(INPUT_PATH)
    print(f"Loaded {len(items)} item(s) from {INPUT_PATH}")

    # Step 1: keep only items with a 3dmodel_id
    with_model = [item for item in items if has_3dmodel_id(item)]
    print(f"After 3dmodel_id filter: {len(with_model)} item(s) "
          f"(removed {len(items) - len(with_model)})")

    # Step 2: remove items containing blocked keywords
    blocked_pattern = build_blocked_pattern(BLOCKED_KEYWORDS, WHOLE_WORDS_ONLY)
    after_blocked = [item for item in with_model
                     if not contains_blocked_keyword(item, blocked_pattern)]
    print(f"After keyword filter: {len(after_blocked)} item(s) "
          f"(removed {len(with_model) - len(after_blocked)})")

    # Step 3: keep only items in allowed furniture categories
    category_patterns = build_category_patterns(ALLOWED_CATEGORIES)
    survivors = []
    category_counts = Counter()
    for item in after_blocked:
        category = matched_category(item, category_patterns)
        if category is not None:
            survivors.append((item, category))
            category_counts[category] += 1
    print(f"After category filter: {len(survivors)} item(s) "
          f"(removed {len(after_blocked) - len(survivors)})")

    # Step 4: streamline
    streamlined = [streamline(item, cat) for item, cat in survivors]

    if OUTPUT_PATH:
        lines = [json.dumps(item, ensure_ascii=False) for item in streamlined]
        OUTPUT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"Wrote filtered items to {OUTPUT_PATH}")

    # Category breakdown
    print("\nCategory distribution among filtered items:")
    if category_counts:
        width = max(len(c) for c in category_counts) + 2
        for category, count in category_counts.most_common():
            print(f"  {category:<{width}} {count}")
    else:
        print("  (no items)")

    # Country distribution
    counts = Counter(get_country(item) for item in streamlined)
    total = sum(counts.values())
    print("\nCountry distribution among filtered items:")
    if not counts:
        print("  (no items)")
        return

    width = max(len(str(c)) for c in counts) + 2
    for country, count in counts.most_common():
        pct = (count / total) * 100 if total else 0
        bar = "#" * int(pct / 2)
        print(f"  {country:<{width}} {count:>5}  {pct:5.1f}%  {bar}")


if __name__ == "__main__":
    main()