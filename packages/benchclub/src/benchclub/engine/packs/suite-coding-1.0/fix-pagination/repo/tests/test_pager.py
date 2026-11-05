import unittest

from pager import page_count, paginate


class PaginateTest(unittest.TestCase):
    def test_first_page(self):
        self.assertEqual(paginate(list(range(10)), 1, 3), [0, 1, 2])

    def test_second_page(self):
        self.assertEqual(paginate(list(range(10)), 2, 3), [3, 4, 5])

    def test_page_count(self):
        self.assertEqual(page_count(10, 3), 4)
        self.assertEqual(page_count(0, 3), 0)

    def test_rejects_page_zero(self):
        with self.assertRaises(ValueError):
            paginate([1, 2, 3], 0, 2)

    def test_rejects_per_page_zero(self):
        with self.assertRaises(ValueError):
            paginate([1, 2, 3], 1, 0)


if __name__ == "__main__":
    unittest.main()
