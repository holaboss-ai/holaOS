import contextlib
import io
import unittest
from pathlib import Path

from inventory.cli import main

SAMPLE = str(Path(__file__).resolve().parents[1] / "data" / "sample.json")

TABLE = """\
SKU      NAME                   QTY     PRICE
---------------------------------------------
A-001    Anchor                   0      2.50
B-104    Bolt, M4               500      0.12
D-075    Drill bit set            3     42.50
H-010    Hammer                   8     19.99
S-330    Saw blade 10"           14      5.00
W-200    Wing nut               120      0.35
"""

CSV_LINES = [
    "sku,name,qty,unit_price",
    "A-001,Anchor,0,2.50",
    'B-104,"Bolt, M4",500,0.12',
    "D-075,Drill bit set,3,42.50",
    "H-010,Hammer,8,19.99",
    'S-330,"Saw blade 10""",14,5.00',
    "W-200,Wing nut,120,0.35",
]


def run(*args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(["--data", SAMPLE, *args])
    return code, out.getvalue()


class HiddenCsvTest(unittest.TestCase):
    def test_csv_output(self):
        code, out = run("--format", "csv")
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines(), CSV_LINES)

    def test_name_with_comma_is_quoted(self):
        _, out = run("--format", "csv")
        self.assertIn('B-104,"Bolt, M4",500,0.12', out.splitlines())

    def test_rows_in_table_order(self):
        _, table = run()
        _, csv_out = run("--format", "csv")
        table_skus = [line.split()[0] for line in table.splitlines()[2:]]
        csv_skus = [line.split(",")[0] for line in csv_out.splitlines()[1:]]
        self.assertEqual(csv_skus, table_skus)

    def test_price_has_two_decimals(self):
        _, out = run("--format", "csv")
        self.assertTrue(any(line.startswith("S-330,") and line.endswith(",5.00") for line in out.splitlines()))

    def test_default_output_unchanged(self):
        code, out = run()
        self.assertEqual(code, 0)
        self.assertEqual(out, TABLE)

    def test_explicit_table_matches_default(self):
        self.assertEqual(run("--format", "table"), run())

    def test_unknown_format_is_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            run("--format", "xml")
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
