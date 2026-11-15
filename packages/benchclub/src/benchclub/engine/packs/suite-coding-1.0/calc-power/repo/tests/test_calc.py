import unittest

from calc import CalcError, evaluate


class CalcTest(unittest.TestCase):
    def test_precedence(self):
        self.assertEqual(evaluate("1 + 2 * 3"), 7)

    def test_parentheses(self):
        self.assertEqual(evaluate("(1 + 2) * 3"), 9)

    def test_division(self):
        self.assertEqual(evaluate("10 / 4"), 2.5)

    def test_left_associative(self):
        self.assertEqual(evaluate("1 - 2 - 3"), -4)

    def test_unary_minus(self):
        self.assertEqual(evaluate("-3 * 2"), -6)

    def test_subtract_negative(self):
        self.assertEqual(evaluate("2 - -1"), 3)

    def test_incomplete(self):
        with self.assertRaises(CalcError):
            evaluate("2 +")

    def test_division_by_zero(self):
        with self.assertRaises(CalcError):
            evaluate("1 / 0")


if __name__ == "__main__":
    unittest.main()
