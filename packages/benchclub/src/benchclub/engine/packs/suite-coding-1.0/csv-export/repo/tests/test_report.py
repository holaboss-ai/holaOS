import contextlib
import io
import unittest
from pathlib import Path

from inventory.cli import main
from inventory.models import Item
from inventory.report import render_table

SAMPLE = str(Path(__file__).resolve().parents[1] / "data" / "sample.json")

TABLE = """\
SKU      NAME                   QTY     PRICE
---------------------------------------------
A-001    Anchor                   0      2.50
B-104    Bolt, M4               500      0.12
D-075    Drill bit set            3     42.50
H-010    Hammer                   8     19.99
S-330    Saw blade 10"           14      5.00
W-200    Wing nut               120      0.35"""


class ReportTest(unittest.TestCase):
    def test_table_output(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(main(["--data", SAMPLE]), 0)
        self.assertEqual(out.getvalue(), TABLE + "\n")

    def test_sorted_by_sku(self):
        items = [Item("B", "b", 1, 100), Item("A", "a", 2, 200)]
        rows = render_table(items).splitlines()[2:]
        self.assertTrue(rows[0].startswith("A "))
        self.assertTrue(rows[1].startswith("B "))

    def test_empty_inventory(self):
        self.assertEqual(len(render_table([]).splitlines()), 2)


if __name__ == "__main__":
    unittest.main()
