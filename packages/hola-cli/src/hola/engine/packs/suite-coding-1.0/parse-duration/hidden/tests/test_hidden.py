import unittest

from durations import format_duration, parse_duration


class HiddenExamplesTest(unittest.TestCase):
    def test_example_seconds(self):
        self.assertEqual(parse_duration("90s"), 90)

    def test_example_hours_minutes(self):
        self.assertEqual(parse_duration("1h30m"), 5400)

    def test_example_days(self):
        self.assertEqual(parse_duration("2d"), 172800)

    def test_example_every_unit(self):
        self.assertEqual(parse_duration("1d2h3m4s"), 93784)

    def test_example_zero(self):
        self.assertEqual(parse_duration("0s"), 0)


class HiddenErrorsTest(unittest.TestCase):
    def assertRejects(self, text):
        with self.assertRaises(ValueError, msg=repr(text)):
            parse_duration(text)

    def test_empty(self):
        self.assertRejects("")

    def test_number_without_unit(self):
        self.assertRejects("5")

    def test_unit_without_number(self):
        self.assertRejects("h")

    def test_unknown_unit(self):
        self.assertRejects("1x")

    def test_out_of_order(self):
        self.assertRejects("1m1h")

    def test_repeated_unit(self):
        self.assertRejects("1h1h")

    def test_leading_space(self):
        self.assertRejects(" 1h")

    def test_uppercase_unit(self):
        self.assertRejects("1H")


class HiddenRoundTripTest(unittest.TestCase):
    def test_minute_less_a_second(self):
        self.assertEqual(parse_duration(format_duration(59)), 59)

    def test_one_hour(self):
        self.assertEqual(parse_duration(format_duration(3600)), 3600)

    def test_day_hour_minute_second(self):
        self.assertEqual(parse_duration(format_duration(90061)), 90061)


if __name__ == "__main__":
    unittest.main()
