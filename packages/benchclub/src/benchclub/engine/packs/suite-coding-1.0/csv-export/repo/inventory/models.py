from dataclasses import dataclass


@dataclass(frozen=True)
class Item:
    sku: str
    name: str
    qty: int
    price_cents: int
