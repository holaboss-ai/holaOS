"""Run Record assembly: a port of runtime/api-server/src/bench-run-record.ts.

The desktop and the CLI must write the same record for the same run; the parity golden in
runtime/api-server/src/__fixtures__/parity/ is asserted byte for byte by both test suites.
"""

import json
import math

RUN_RECORD_SCHEMA = "hola.run-record/0.1"


class SubjectError(ValueError):
    pass


def _non_empty_string(value):
    return isinstance(value, str) and value.strip() != ""


def parse_bench_subject(raw):
    value = raw if isinstance(raw, dict) else {}
    ollama = value.get("ollama") if isinstance(value.get("ollama"), dict) else {}
    if value.get("type") != "model":
        raise SubjectError('subject.type must be "model"')
    for key, field in (("id", value.get("id")), ("name", value.get("name")), ("quant", value.get("quant")),
                       ("ollama.tag", ollama.get("tag"))):
        if not _non_empty_string(field):
            raise SubjectError(f"subject.{key} is required")
    return value


def min_ollama_version(suite_floor, subject, compare):
    """The higher of the suite's floor and the model's own floor; None when neither sets one."""
    floors = [f for f in (suite_floor, (subject.get("ollama") or {}).get("min_version")) if _non_empty_string(f)]
    highest = None
    for floor in floors:
        if highest is None or compare(floor, highest) > 0:
            highest = floor
    return highest


def build_run_record(*, run_id, bench, subject, digest, evidence, client, artifacts, conditions):
    """Client-side fields only: verification, provenance, submitter and signature are filled by HolaHub on submit."""
    known = (subject.get("ollama") or {}).get("known_digests") or []
    return {
        "schema": RUN_RECORD_SCHEMA,
        "run_id": run_id,
        "suite": bench["suite"],
        "subject": {
            "type": "model",
            "id": subject["id"],
            "name": subject["name"],
            "vendor": subject.get("vendor"),
            "version": digest,
            "quant": subject["quant"],
            "tag": subject["ollama"]["tag"],
            "digest_registered": digest is not None and digest in known,
            "capabilities": bench["capabilities"],
        },
        "test_agent": {**bench["test_agent"], "settings": {**bench["request"], "warmup_load_ms": bench["warmup_load_ms"]}},
        "runtime": {
            "kind": evidence["kind"],
            "hardware": bench["machine"],
            "provider": evidence["provider"],
            "client": client,
            "conditions": conditions,
        },
        "results": bench["results"],
        "artifacts": artifacts,
        "verification": None,
        "provenance": None,
        "submitter": None,
        "signature": None,
        "started_at": bench["started_at"],
        "finished_at": bench["finished_at"],
        "wall_seconds": bench["wall_seconds"],
    }


def js_round(x):
    """Math.round: halves go up, where Python's round() goes to even."""
    return math.floor(x + 0.5)


def bench_highlights(events):
    """Seconds from `run_started`: first token, task done and errors. A port of benchHighlights in bench-runner.ts."""
    origin = next((e["at"] for e in events if e.get("type") == "run_started"), None)
    if origin is None:
        return []
    highlights = []
    seen = set()
    for event in events:
        task = event.get("task") if isinstance(event.get("task"), str) else None
        if not task or task == "warmup":
            continue
        t = js_round((event["at"] - origin) / 100) / 10
        if event.get("type") == "text" and task not in seen:
            seen.add(task)
            highlights.append({"t": t, "label": "first_token", "task": task})
        elif event.get("type") == "task_done":
            highlights.append({"t": t, "label": "error" if event.get("status") == "error" else "task_done", "task": task})
        elif (event.get("type") == "sample_done" and isinstance(event.get("reason"), str)
              and event["reason"].startswith("request failed")):
            highlights.append({"t": t, "label": "error", "task": task})
    return highlights


def publish_blockers(record):
    """Why HolaHub would refuse this record; empty when it can be published."""
    blockers = []
    provider = (record.get("runtime") or {}).get("provider") or {}
    if provider.get("managed") is not True:
        blockers.append("it ran on an Ollama server hola did not start, so its conditions are unknown")
    subject = record.get("subject") or {}
    if subject.get("digest_registered") is not True:
        blockers.append(f"the model build ({(subject.get('version') or 'unknown')[:12]}) is not one HolaHub has registered")
    return blockers


# ---------- JSON exactly as JSON.stringify(value, null, 2) writes it ----------

def js_number(x):
    """Number::toString from ECMA-262, built on Python's shortest round-trip digits (the same digits JS picks)."""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if math.isnan(x) or math.isinf(x):
        return "null"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    mantissa, _, exp = repr(abs(x)).partition("e")
    whole, _, frac = mantissa.partition(".")
    digits = (whole + frac).lstrip("0")
    stripped = digits.rstrip("0")
    k = len(stripped)
    n = int(exp or 0) - len(frac) + (len(digits) - k) + k
    if k <= n <= 21:
        body = stripped + "0" * (n - k)
    elif 0 < n <= 21:
        body = stripped[:n] + "." + stripped[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * -n + stripped
    else:
        e = n - 1
        body = (stripped if k == 1 else stripped[0] + "." + stripped[1:]) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + body


def _encode(value, indent, sort_keys):
    if value is None:
        return "null"
    if isinstance(value, (bool, int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    inner = indent + "  "
    if isinstance(value, dict):
        if not value:
            return "{}"
        keys = sorted(value) if sort_keys else list(value)
        items = [f"{inner}{json.dumps(str(k), ensure_ascii=False)}: {_encode(value[k], inner, sort_keys)}" for k in keys]
        return "{\n" + ",\n".join(items) + "\n" + indent + "}"
    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        return "[\n" + ",\n".join(inner + _encode(item, inner, sort_keys) for item in value) + "\n" + indent + "]"
    raise TypeError(f"not JSON: {type(value).__name__}")


def dumps(value, sort_keys=False):
    """The bytes the desktop writes for the same value (plus a trailing newline); sort_keys gives the parity form."""
    return _encode(value, "", sort_keys) + "\n"
