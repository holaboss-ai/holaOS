#!/usr/bin/env python3
"""Fingerprint the measurement engine bundled in the benchclub package.

The CLI/runner engine copy is the source of truth (the desktop is out of scope), so this no longer
syncs from the desktop. It maintains MANIFEST.json — a sha256 per engine file — so the hub and CI can
verify the engine they read against a known fingerprint, and so an edit that forgets to refresh the
fingerprint is caught.

usage: sync-engine.py           recompute MANIFEST.json from the engine dir
       sync-engine.py --check   exit 1 if MANIFEST.json is stale (engine changed without a rewrite)
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
ENGINE = PACKAGE / "src" / "benchclub" / "engine"
MANIFEST = "MANIFEST.json"


def engine_files():
    """Every engine file except the manifest, keyed by posix-relative name."""
    return {p.relative_to(ENGINE).as_posix(): p.read_bytes() for p in sorted(ENGINE.rglob("*"))
            if p.is_file() and "__pycache__" not in p.parts and p.name != MANIFEST}


def manifest_bytes(files):
    digest = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    return (json.dumps({"files": digest}, indent=2) + "\n").encode()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report a stale manifest instead of rewriting it")
    args = ap.parse_args()
    want = manifest_bytes(engine_files())
    path = ENGINE / MANIFEST
    have = path.read_bytes() if path.exists() else b""
    count = len(json.loads(want)["files"])
    if args.check:
        if want != have:
            print("MANIFEST.json is stale. Run: python3 packages/benchclub/scripts/sync-engine.py", file=sys.stderr)
            return 1
        print(f"engine manifest current ({count} files)")
        return 0
    path.write_text(want.decode(), encoding="utf-8")
    print(f"wrote src/benchclub/engine/{MANIFEST} ({count} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
