"""Runs saved on this machine: one directory per run under the runs dir, named by its run id."""

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from hola import paths, pinned
from hola.errors import HolaError
from hola.record import dumps, publish_blockers

RUN_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PUBLISHED_FILE = "published.json"


def read_record(run_dir):
    try:
        return json.loads((Path(run_dir) / "run-record.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def published(run_dir):
    """What `mark_published` saved after the run went up, or None."""
    try:
        return json.loads((Path(run_dir) / PUBLISHED_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def mark_published(run_dir, url):
    (Path(run_dir) / PUBLISHED_FILE).write_text(dumps({
        "url": url, "published_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}), encoding="utf-8")


def busy_reading(conditions):
    """(percent, "during" | "before") that decides whether a run was busy, or None.

    Others' CPU while it generated decides; a record without that reading falls back to the pre-run sample.
    """
    during, before = conditions.get("others_cpu_busy_pct"), conditions.get("cpu_busy_pct")
    if isinstance(during, (int, float)):
        return during, "during"
    if isinstance(before, (int, float)):
        return before, "before"
    return None


def was_busy(conditions):
    reading = busy_reading(conditions)
    return reading is not None and reading[0] > pinned.conditions()["busy_others_cpu_pct"]


def speed(record, task):
    result = next((r for r in record.get("results") or [] if r.get("task") == task and r.get("kind") == "speed"), None)
    return (result or {}).get("metrics") or {} if (result or {}).get("status") == "ok" else {}


def summarize(run_dir, record):
    subject = record.get("subject") or {}
    runtime = record.get("runtime") or {}
    shallow, deep = speed(record, "speed@0"), speed(record, "speed@8k")
    tasks = {r["task"]: {k: r.get(k) for k in ("status", "passed", "samples")}
             for r in record.get("results") or [] if r.get("kind") == "task"}
    return {
        "run_id": record.get("run_id"),
        "run_dir": str(run_dir),
        "subject_id": subject.get("id"),
        "subject_name": subject.get("name"),
        "quant": subject.get("quant"),
        "suite": f"{(record.get('suite') or {}).get('id')}@{(record.get('suite') or {}).get('version')}",
        "started_at": record.get("started_at"),
        "decode_tps": shallow.get("decode_tps"),
        "decode_tps_8k": deep.get("decode_tps"),
        "ttft_ms": shallow.get("ttft_ms"),
        "cpu_offload": bool(shallow.get("cpu_offload") or deep.get("cpu_offload")),
        "vram_bytes": shallow.get("vram_bytes"),
        "tasks": tasks,
        "hardware": runtime.get("hardware") or {},
        "conditions": runtime.get("conditions") or {},
        "digest_registered": subject.get("digest_registered"),
        "publish_blockers": publish_blockers(record),
        "published": published(run_dir),
    }


def list_runs(root=None):
    """Finished runs, newest first; an unfinished or unreadable run is not listed."""
    root = Path(root) if root else paths.runs_dir()
    if not root.is_dir():
        return []
    out = []
    for entry in root.iterdir():
        if RUN_ID_RE.match(entry.name):
            record = read_record(entry)
            if record and record.get("run_id") == entry.name:
                out.append(summarize(entry, record))
    return sorted(out, key=lambda run: run["started_at"] or "", reverse=True)


def resolve(ref, root=None):
    """A run id, a unique prefix of one, or "latest" → (run_dir, record)."""
    runs = list_runs(root)
    if not runs:
        raise HolaError("not_found", "There are no finished runs on this machine yet.", "Run one: hola eval <model>")
    ref = (ref or "").strip().lower()
    matches = runs[:1] if ref == "latest" else [r for r in runs if ref and r["run_id"].startswith(ref)]
    if not matches:
        raise HolaError("not_found", f"No run matches {ref}.", "See your runs with `hola runs`.")
    if len(matches) > 1:
        raise HolaError("not_found", f"{ref} matches {len(matches)} runs.", "Type more of the run id.")
    run_dir = Path(matches[0]["run_dir"])
    return run_dir, read_record(run_dir)
