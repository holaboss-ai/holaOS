from .money import percent_of


class UnknownCode(Exception):
    """A discount code the shop doesn't offer."""


CODES = {
    "SAVE10": ("percent", 10),
    "SAVE25": ("percent", 25),
    "FIVEOFF": ("fixed", 500),
}


def apply_code(subtotal_cents, code):
    """Return the total after applying a discount code to the order subtotal."""
    if code is None:
        return subtotal_cents
    code = code.strip().upper()
    if code not in CODES:
        raise UnknownCode(code)
    kind, value = CODES[code]
    if kind == "percent":
        return subtotal_cents - percent_of(subtotal_cents, value)
    return max(subtotal_cents - value, 0)
