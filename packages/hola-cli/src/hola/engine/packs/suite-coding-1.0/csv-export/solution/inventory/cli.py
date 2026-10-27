import argparse
import sys

from .report import render_csv, render_table
from .store import load_items


def main(argv=None):
    parser = argparse.ArgumentParser(prog="inventory", description="Print the inventory.")
    parser.add_argument("--data", default="data/sample.json", help="inventory JSON file")
    parser.add_argument("--format", choices=["table", "csv"], default="table", help="output format")
    args = parser.parse_args(argv)
    items = load_items(args.data)
    if args.format == "csv":
        sys.stdout.write(render_csv(items))
    else:
        print(render_table(items))
    return 0


if __name__ == "__main__":
    sys.exit(main())
