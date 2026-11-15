import unittest

from pager import paginate


class HiddenPaginateTest(unittest.TestCase):
    def test_last_page_is_partial(self):
        self.assertEqual(paginate(list(range(10)), 4, 3), [9])

    def test_page_past_the_end_is_empty(self):
        self.assertEqual(paginate(list(range(10)), 5, 3), [])

    def test_one_page_holds_everything(self):
        self.assertEqual(paginate([1, 2], 1, 5), [1, 2])


if __name__ == "__main__":
    unittest.main()
