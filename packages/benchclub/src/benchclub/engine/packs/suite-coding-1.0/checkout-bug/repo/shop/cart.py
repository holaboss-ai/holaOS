from .catalog import price_of
from .pricing import apply_code


class Cart:
    def __init__(self):
        self.lines = {}

    def add(self, sku, qty=1):
        if qty < 1:
            raise ValueError("qty must be at least 1")
        price_of(sku)
        self.lines[sku] = self.lines.get(sku, 0) + qty

    def subtotal_cents(self):
        return sum(price_of(sku) * qty for sku, qty in self.lines.items())

    def total_cents(self, code=None):
        return apply_code(self.subtotal_cents(), code)
