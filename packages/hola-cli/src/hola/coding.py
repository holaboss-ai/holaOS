"""suite-coding@1.0 in words: the task matrix and the generated review, as HolaHub's run page writes them.

A port of codingReview and its helpers in frontend apps/holahub/src/routes/bench-run-page.tsx, so the same record
reads the same in a terminal and on the run page.
"""

import re
import statistics
from decimal import ROUND_HALF_UP, Decimal

from hola.record import js_number, js_round

NBSP = " "
HIDDEN_FAILED = re.compile(r"^hidden tests failed \((\d+) of (\d+)\)$")
MIB_SUFFIX = re.compile(r",\s*(\d+)\s*MiB$", re.I)
NVIDIA_PREFIX = re.compile(r"^NVIDIA\s+(GeForce\s+)?", re.I)

TASKS = {
    "fix-pagination": "Fix a failing test",
    "parse-duration": "Implement from a spec",
    "csv-export": "Add a CLI option",
    "checkout-bug": "Fix a reported bug",
    "calc-power": "Change a parser",
}
REVIEW_NAMES = {
    "fix-pagination": "the failing test",
    "parse-duration": "the spec implementation",
    "csv-export": "the CLI option",
    "checkout-bug": "the reported bug",
    "calc-power": "the parser change",
}
REASONS = {
    "tests could not run": "an import or syntax error stopped the code",
    "tests timed out": "the tests timed out",
    "tool call written as text": "wrote a tool call as text instead of calling the tool",
    "request failed": "the model server returned an error",
    "malformed tool call": "wrote a tool call the engine couldn't parse",
    "repository grew past the sandbox limit": "wrote more files than the sandbox allows",
    "stopped by the safety time limit": "hit the 10-minute safety limit",
}


def explain(reason):
    failed = HIDDEN_FAILED.match(reason)
    if failed:
        return f"{failed.group(1)} of {failed.group(2)} hidden tests failed"
    return REASONS.get(reason, reason)


def to_fixed(value, digits):
    """Number.prototype.toFixed: halves round up on the exact binary value, where Python's format rounds to even."""
    return str(Decimal(value).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def thousands(value):
    if value is None:
        return "–"
    return f"{to_fixed(value / 1000, 1)}K" if value >= 1000 else js_number(value)


def median(values):
    return statistics.median(values) if values else None


def top_reason(task):
    reasons = sorted((task.get("reasons") or {}).items(), key=lambda item: -item[1])
    return reasons[0][0] if reasons else None


def machine(hw):
    gpus = hw.get("gpus") or []
    memory = f"{js_number(hw['memory_gb'])} GB" if hw.get("memory_gb") else ""
    if gpus:
        gpu = MIB_SUFFIX.sub(lambda m: f" {js_round(int(m.group(1)) / 1024)} GB", NVIDIA_PREFIX.sub("", gpus[0], count=1))
        return " · ".join(part for part in (gpu, memory and f"{memory} RAM") if part)
    return " · ".join(part for part in (hw.get("cpu") or "Unknown machine", memory) if part)


def engine(provider):
    name = "Ollama" if provider.get("engine") == "ollama" else provider.get("engine")
    return f"{name} {provider['version']}" if provider.get("version") else name


def task_results(record):
    return [r for r in record.get("results") or [] if r.get("kind") == "task"]


def _names(tasks):
    names = [REVIEW_NAMES.get(t["task"], t["task"]) for t in tasks]
    return "".join(names) if len(names) < 2 else f"{', '.join(names[:-1])} and {names[-1]}"


def _or_list(items):
    return "".join(items) if len(items) < 2 else f"{', '.join(items[:-1])} or {items[-1]}"


def review(record):
    """Fixed sentences filled from the record (design D5), so the same record always reads the same."""
    tasks = task_results(record)
    subject, runtime = record["subject"], record["runtime"]
    model = f"{subject['name']} ({subject['quant']})"
    if all(t.get("status") == "unsupported" for t in tasks):
        return [f"Ollama reports no tool calling for {model}, so the coding scenario could not run. That is not a fail."]
    scored = [t for t in tasks if t.get("status") == "ok"]
    always = [t for t in scored if t["passed"] == t["samples"]]
    sometimes = [t for t in scored if 0 < t["passed"] < t["samples"]]
    never = [t for t in scored if t["passed"] == 0]
    attempts = [a for t in tasks for a in t.get("attempts") or []]
    where = f"On {machine(runtime.get('hardware') or {})} with {engine(runtime.get('provider') or {})}"
    lines = []
    if always:
        also = f", and {_names(sometimes)} some of the time" if sometimes else ""
        lines.append(f"{where}, {model} solved {_names(always)} every time{also}.")
    elif sometimes:
        lines.append(f"{where}, {model} solved {_names(sometimes)} some of the time and no task every time.")
    else:
        lines.append(f"{where}, {model} solved none of the tasks.")
    if never:
        only_reason = top_reason(never[0]) if len(never) == 1 else None
        if only_reason:
            lines.append(f"It did not solve {_names(never)}: {explain(only_reason)}.")
        else:
            items = [f"{REVIEW_NAMES.get(t['task'], t['task'])} ({explain(top_reason(t))})" if top_reason(t)
                     else REVIEW_NAMES.get(t["task"], t["task"]) for t in never]
            lines.append(f"It did not solve {_or_list(items)}.")
    turns = median([a["turns"] for a in attempts])
    tokens = median([a["completion_tokens"] for a in attempts])
    seconds = median([a["seconds"] for a in attempts])
    if turns is not None and tokens is not None and seconds is not None:
        lines.append(f"A typical try took {js_number(turns)} turns and {thousands(js_round(tokens))} generated tokens, "
                     f"about {js_round(seconds)}{NBSP}s on this machine.")
    touched = sum(1 for a in attempts if a.get("touched_tests"))
    if touched:
        lines.append(f"It edited the visible tests in {touched} {'try' if touched == 1 else 'tries'}; "
                     "they were restored before grading.")
    lines.append(f"This shows what {subject['name']} can do as a coding agent on this hardware. It is not a ranking.")
    return lines


def matrix(record):
    """One row per task in tier order: title, score, finished, and the main reason a try failed."""
    rows = []
    for t in task_results(record):
        title = TASKS.get(t["task"], t["task"])
        if t.get("status") == "unsupported":
            rows.append((title, "not supported", "–", "no tool calling in this Ollama model"))
            continue
        finished = (t.get("metrics") or {}).get("finished")
        reason = top_reason(t) if t.get("status") == "ok" and t["passed"] < t["samples"] else None
        rows.append((title, f"{t['passed']}/{t['samples']}",
                     f"finished {finished}/{t['samples']}" if finished is not None else "–",
                     explain(reason) if reason else ("did not finish" if t.get("status") == "incomplete" else "")))
    return rows
