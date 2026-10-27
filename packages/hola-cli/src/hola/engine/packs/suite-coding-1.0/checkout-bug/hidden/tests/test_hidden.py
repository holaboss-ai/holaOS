import unittest

from shop.cart import Cart
from shop.pricing import UnknownCode, apply_code


def three_widgets():
    cart = Cart()
    cart.add("widget", 3)
    return cart


class HiddenCheckoutTest(unittest.TestCase):
    def test_reported_code_as_typed(self):
        self.assertEqual(three_widgets().total_cents("save10 "), 5397)

    def test_reported_code_uppercase(self):
        self.assertEqual(three_widgets().total_cents("SAVE10"), 5397)

    def test_discount_rounds_half_up(self):
        self.assertEqual(apply_code(5985, "SAVE10"), 5386)

    def test_discount_below_half_rounds_down(self):
        self.assertEqual(apply_code(5994, "SAVE10"), 5395)

    def test_fixed_code(self):
        cart = Cart()
        cart.add("doohickey", 2)
        self.assertEqual(cart.total_cents("FIVEOFF"), 1500)

    def test_fixed_code_never_below_zero(self):
        cart = Cart()
        cart.add("gizmo")
        self.assertEqual(cart.total_cents("FIVEOFF"), 0)

    def test_unknown_code(self):
        with self.assertRaises(UnknownCode):
            three_widgets().total_cents("SAVE99")

    def test_no_code(self):
        self.assertEqual(three_widgets().total_cents(), 5997)


if __name__ == "__main__":
    unittest.main()
