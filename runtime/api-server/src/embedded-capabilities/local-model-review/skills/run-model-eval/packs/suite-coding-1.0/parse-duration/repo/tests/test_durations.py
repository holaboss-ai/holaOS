import unittest

from durations import format_duration, parse_duration


class ParseDurationTest(unittest.TestCase):
    def test_seconds(self):
        self.assertEqual(parse_duration("90s"), 90)

    def test_hours_and_minutes(self):
        self.assertEqual(parse_duration("1h30m"), 5400)


class FormatDurationTest(unittest.TestCase):
    def test_hours_and_minutes(self):
        self.assertEqual(format_duration(5400), "1h30m")

    def test_zero(self):
        self.assertEqual(format_duration(0), "0s")

    def test_every_unit(self):
        self.assertEqual(format_duration(93784), "1d2h3m4s")


if __name__ == "__main__":
    unittest.main()
