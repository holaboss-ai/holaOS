"""The engine, packs, conditions and bundled subjects, byte for byte as the desktop ships them (see engine/MANIFEST.json)."""

import functools
import hashlib
import json
from pathlib import Path

ENGINE = Path(__file__).resolve().parent / "engine"
# Mirrors BENCH_SUITES in runtime/api-server/src/bench-runner.ts: the holaeval subcommand and where it may run.
SUITES = {
    "suite-standard@1.0": {"command": "bench", "platforms": None},
    "suite-standard@1.1": {"command": "bench", "platforms": None},
    "suite-coding@1.0": {"command": "code", "platforms": ("darwin",)},
}
SUPPORTED_SUITES = tuple(SUITES)
DEFAULT_SUITE = "suite-standard@1.0"


def suite_family(suite):
    """suite-standard@1.1 → suite-standard@1: a minor version changes the items, not what a model needs to run them."""
    name, _, version = suite.partition("@")
    return f"{name}@{version.split('.')[0]}"


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


@functools.lru_cache(maxsize=None)
def fingerprint():
    """sha256 of the manifest the engine files on disk would have: the site counts runs only from engines it
    knows, and a file edited after install changes this even when MANIFEST.json is left alone."""
    files = {p.relative_to(ENGINE).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(ENGINE.rglob("*"))
             if p.is_file() and "__pycache__" not in p.parts and p.name != "MANIFEST.json"}
    return hashlib.sha256((json.dumps({"files": dict(sorted(files.items()))}, indent=2) + "\n").encode()).hexdigest()


def bundled_subjects():
    return json.loads((ENGINE / "subjects.json").read_text(encoding="utf-8"))
