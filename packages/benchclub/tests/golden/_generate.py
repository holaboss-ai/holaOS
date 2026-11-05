#!/usr/bin/env python3
"""Regenerate the CLI-owned run-record goldens from their seeds (inputs/bench-output/subject/evidence).

The CLI/runner is the sole writer of benchclub.run-record/0.2, so these goldens live with the CLI (not the
desktop parity fixtures). Run after changing record.build_run_record:
    python3 -I tests/golden/_generate.py
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "src"))

from benchclub import record  # noqa: E402

CLIENT = {"app": "benchclub", "version": "0.1.0"}
VARIANTS = ("standard", "coding")


def read(variant, name):
    return json.loads((HERE / variant / name).read_text(encoding="utf-8"))


def build(variant):
    inputs = read(variant, "inputs.json")
    return record.build_run_record(
        run_id=inputs["run_id"], job_id=f"local:{inputs['run_id']}", placement="local",
        bench=read(variant, "bench-output.json"), subject=read(variant, "subject.json"),
        digest=inputs["digest"], evidence=read(variant, "evidence.json"), client=CLIENT,
        events=inputs["events"], conditions=inputs["conditions"])


def main():
    for variant in VARIANTS:
        rec = build(variant)
        (HERE / variant / "run-record.json").write_text(record.dumps(rec, sort_keys=True), encoding="utf-8")
        print(f"wrote {variant}/run-record.json (schema {rec['schema']})")


if __name__ == "__main__":
    main()
