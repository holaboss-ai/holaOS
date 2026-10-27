#!/usr/bin/env python3
"""Copy the measurement engine the desktop runs into the hola package, or check that the copy matches.

usage: sync-engine.py           copy every source into src/hola/engine/ and rewrite MANIFEST.json
       sync-engine.py --check   exit 1 if the committed copy differs from its sources
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
REPO = PACKAGE.parent.parent
ENGINE = PACKAGE / "src" / "hola" / "engine"
SKILL = REPO / "runtime/api-server/src/embedded-capabilities/local-model-review/skills/run-model-eval"
SUBJECTS_TS = REPO / "apps/desktop/shared/bench-subjects.ts"

COPIES = {
    "holaeval.py": SKILL / "holaeval.py",
}
PACKS = SKILL / "packs"
MANIFEST = "MANIFEST.json"


def bundled_subjects():
    """The desktop's BUNDLED_BENCH_SUBJECTS as JSON; Node strips the TS types itself."""
    node = shutil.which("node")
    if not node:
        sys.exit("sync-engine: node (>= 22.18) is needed to read apps/desktop/shared/bench-subjects.ts")
    script = ("const m = await import(process.argv[1]);"
              "process.stdout.write(JSON.stringify(m.BUNDLED_BENCH_SUBJECTS, null, 2) + '\\n');")
    out = subprocess.run([node, "--no-warnings", "--input-type=module", "-e", script, SUBJECTS_TS.as_uri()],
                         capture_output=True, check=False)
    if out.returncode != 0:
        sys.exit(f"sync-engine: could not read {SUBJECTS_TS}: {out.stderr.decode().strip()}")
    return out.stdout


def expected_files():
    files = {name: src.read_bytes() for name, src in COPIES.items()}
    for src in sorted(PACKS.rglob("*")):
        if src.is_file():
            files["packs/" + src.relative_to(PACKS).as_posix()] = src.read_bytes()
    files["subjects.json"] = bundled_subjects()
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    files[MANIFEST] = (json.dumps({"files": manifest}, indent=2) + "\n").encode()
    return files


def current_files():
    if not ENGINE.exists():
        return {}
    return {p.relative_to(ENGINE).as_posix(): p.read_bytes() for p in ENGINE.rglob("*")
            if p.is_file() and "__pycache__" not in p.parts}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report drift instead of copying")
    args = ap.parse_args()
    want = expected_files()
    have = current_files()
    drift = sorted({name for name in want.keys() | have.keys() if want.get(name) != have.get(name)})
    if args.check:
        if drift:
            for name in drift:
                state = "missing" if name not in have else "extra" if name not in want else "differs"
                print(f"  {state}: src/hola/engine/{name}", file=sys.stderr)
            print("The hola engine copy is out of date. Run: python3 packages/hola-cli/scripts/sync-engine.py",
                  file=sys.stderr)
            return 1
        print(f"engine in sync ({len(want)} files)")
        return 0
    for name in drift:
        target = ENGINE / name
        if name in want:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(want[name])
        else:
            target.unlink()
    print(f"synced {len(drift)} of {len(want)} files into {ENGINE.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
