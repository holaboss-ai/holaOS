PRICES = {
    "widget": 1999,
    "gadget": 2500,
    "gizmo": 300,
    "doohickey": 1000,
}


def price_of(sku):
    try:
        return PRICES[sku]
    except KeyError:
        raise KeyError(f"unknown sku: {sku}") from None
