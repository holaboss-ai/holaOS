import json

from .models import Item


def load_items(path):
    """Read items from a JSON file: a list of objects with sku, name, qty and price_cents."""
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    return [Item(sku=r["sku"], name=r["name"], qty=int(r["qty"]), price_cents=int(r["price_cents"])) for r in rows]
