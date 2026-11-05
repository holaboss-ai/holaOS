import unittest

from calc import CalcError, evaluate


class HiddenPowerTest(unittest.TestCase):
    def test_power(self):
        self.assertEqual(evaluate("2 ** 10"), 1024)

    def test_right_associative(self):
        self.assertEqual(evaluate("2 ** 3 ** 2"), 512)

    def test_binds_tighter_than_unary_minus_on_the_left(self):
        self.assertEqual(evaluate("-2 ** 2"), -4)

    def test_parenthesised_negative_base(self):
        self.assertEqual(evaluate("(-2) ** 2"), 4)

    def test_negative_exponent(self):
        self.assertEqual(evaluate("2 ** -1"), 0.5)

    def test_unary_minus_on_both_sides(self):
        self.assertEqual(evaluate("-2 ** -2"), -0.25)

    def test_binds_tighter_than_multiplication_on_the_right(self):
        self.assertEqual(evaluate("2 * 3 ** 2"), 18)

    def test_binds_tighter_than_multiplication_on_the_left(self):
        self.assertEqual(evaluate("2 ** 2 * 3"), 12)

    def test_parenthesised_power(self):
        self.assertEqual(evaluate("-(2 ** 2)"), -4)

    def test_parenthesised_exponent(self):
        self.assertEqual(evaluate("2 ** (1 + 2)"), 8)

    def test_subtract_negated_power(self):
        self.assertEqual(evaluate("2 - -2 ** 2"), 6)

    def test_incomplete_power(self):
        with self.assertRaises(CalcError):
            evaluate("2 **")


if __name__ == "__main__":
    unittest.main()
