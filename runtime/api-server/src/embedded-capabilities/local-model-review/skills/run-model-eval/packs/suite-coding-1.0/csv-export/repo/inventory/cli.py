import argparse
import sys

from .report import render_table
from .store import load_items


def main(argv=None):
    parser = argparse.ArgumentParser(prog="inventory", description="Print the inventory.")
    parser.add_argument("--data", default="data/sample.json", help="inventory JSON file")
    args = parser.parse_args(argv)
    print(render_table(load_items(args.data)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
