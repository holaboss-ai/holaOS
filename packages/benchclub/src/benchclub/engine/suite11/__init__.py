"""suite-standard@1.1 graders: one pure, stdlib-only function per benchmark.

The CLI grades locally with these and the site re-grades the uploaded log with the same code, so a
verdict never depends on where it was computed. No grader executes, imports or eval()s model output.
"""

import importlib

from .common import FORMAT_ERROR, OUTCOMES, PASS, UNFINISHED, UNSUPPORTED, WRONG, normalize_response

BENCHES = ("bfcl", "when2call", "ifbench", "ifeval", "jsonschema", "reasoning", "simpleqa")


def unsupported(item, capabilities):
    """A tool item the build can't take: left out of its scores rather than counted as failed."""
    if item.get("tools") and "tools" not in (capabilities or []):
        return {"passed": False, "outcome": UNSUPPORTED, "detail": "this model has no tool support in Ollama"}
    return None


def grade(item, response):
    """Verdict for one item: {"passed", "outcome", "detail"}; outcome is one of OUTCOMES."""
    bench = item["bench"]
    if bench not in BENCHES:
        raise ValueError(f"unknown bench {bench!r}")
    resp = normalize_response(response)
    verdict = importlib.import_module(f".{bench}", __name__).grade(item, resp)
    outcome = verdict["outcome"]
    if outcome not in OUTCOMES:
        raise ValueError(f"{bench} returned unknown outcome {outcome!r}")
    if outcome in (WRONG, FORMAT_ERROR) and resp["done_reason"] == "length":
        outcome = UNFINISHED
    return {"passed": outcome == PASS, "outcome": outcome, "detail": verdict.get("detail", "")}
