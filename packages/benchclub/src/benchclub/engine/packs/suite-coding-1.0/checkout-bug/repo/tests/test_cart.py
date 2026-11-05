import unittest

from shop.cart import Cart


class CartTest(unittest.TestCase):
    def test_subtotal(self):
        cart = Cart()
        cart.add("widget", 3)
        self.assertEqual(cart.subtotal_cents(), 5997)

    def test_adding_twice_accumulates(self):
        cart = Cart()
        cart.add("gizmo")
        cart.add("gizmo", 2)
        self.assertEqual(cart.lines, {"gizmo": 3})

    def test_unknown_sku(self):
        with self.assertRaises(KeyError):
            Cart().add("sprocket")

    def test_quarter_off(self):
        cart = Cart()
        cart.add("gadget", 4)
        self.assertEqual(cart.total_cents("SAVE25"), 7500)

    def test_quantity_must_be_positive(self):
        with self.assertRaises(ValueError):
            Cart().add("widget", 0)


if __name__ == "__main__":
    unittest.main()
