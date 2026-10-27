"""The `hola` command."""

import argparse

from hola import __version__


def main(argv=None):
    ap = argparse.ArgumentParser(prog="hola", description="Benchmark a local model the way holaOS does.")
    ap.add_argument("--version", action="version", version=f"hola {__version__}")
    ap.parse_args(argv)
    ap.print_help()
    return 0
