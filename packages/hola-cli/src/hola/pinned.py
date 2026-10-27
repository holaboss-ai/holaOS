"""The engine, packs, conditions and bundled subjects, byte for byte as the desktop ships them (see engine/MANIFEST.json)."""

import functools
import json
from pathlib import Path

ENGINE = Path(__file__).resolve().parent / "engine"
SUPPORTED_SUITES = ("suite-standard@1.0",)
DEFAULT_SUITE = "suite-standard@1.0"


def holaeval_path():
    return ENGINE / "holaeval.py"


def pack_path(suite):
    """suite-standard@1.0 → packs/suite-standard-1.0.json, the same file the desktop's BENCH_SUITES names."""
    return ENGINE / "packs" / (suite.replace("@", "-") + ".json")


@functools.lru_cache(maxsize=None)
def conditions():
    return json.loads((ENGINE / "bench-conditions.json").read_text(encoding="utf-8"))


@functools.lru_cache(maxsize=None)
def manifest():
    return json.loads((ENGINE / "MANIFEST.json").read_text(encoding="utf-8"))


def bundled_subjects():
    return json.loads((ENGINE / "subjects.json").read_text(encoding="utf-8"))
