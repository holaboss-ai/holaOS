"""Run Record assembly: the CLI/runner is the sole writer of benchclub.run-record/0.2.

The record's goldens live with this package (tests/golden/); the desktop is out of scope (ruling D).
"""

import hashlib
import json
import math
from pathlib import Path

RUN_RECORD_SCHEMA = "benchclub.run-record/0.2"


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


def runtime_backend(hardware):
    """The headline split key (cuda|metal|rocm|vulkan|cpu), read from the engine's machine_info."""
    gpus = hardware.get("gpus") or []
    names = " ".join(g if isinstance(g, str) else str(g.get("name", "")) for g in gpus).lower()
    if "nvidia" in names:
        return "cuda"
    platform = (hardware.get("platform") or "").lower()
    if "macos" in platform or "darwin" in platform or (hardware.get("machine") == "arm64" and "mac" in platform):
        return "metal"
    if "amd" in names or "radeon" in names:
        return "rocm"
    return "cpu"


def runtime_profile(provider):
    """RuntimeProfile id as "<engine>-<major.minor>" (e.g. ollama-0.40); the hub owns the canonical registry."""
    engine = provider.get("engine") or "engine"
    parts = (provider.get("version") or "").split(".")
    version = ".".join(parts[:2]) if len(parts) >= 2 else (provider.get("version") or "0")
    return f"{engine}-{version}"


def jcs(value):
    """RFC 8785 (JCS) canonical form of one JSON value: sorted keys (UTF-16 order), ES6 numbers, no whitespace."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0].encode("utf-16-be"))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + jcs(v) for k, v in items) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(jcs(item) for item in value) + "]"
    raise TypeError(f"not JSON: {type(value).__name__}")


_WIRE_NAME = {"run_started": "run_start", "run_finished": "run_done",
              "sample_done": "task_done", "attempt_start": "task_start"}
# The only event names carried on the wire (contract: event-chunk/0.1 name table). Everything else is
# engine lifecycle noise (phase/engine_ready/pull_progress/start/done …) that stays in the local record and
# never reaches the server — regrade, seq anchoring and replay all key on these. tool_result is the paired
# outcome of tool_call (agent-loop evidence); request_error is a reserved name this engine doesn't emit.
_CANONICAL = {"run_start", "run_done", "task_start", "task_done", "text", "tool_call", "tool_result",
              "request_error"}


def _scrub_home(value, home):
    """Replace the OS user-home prefix with '~' in every string, recursively — so no run leaks a username
    into the uploaded log (defense-in-depth beside dropping lifecycle events; the first real run leaked a
    $HOME path via a lifecycle 'file' field)."""
    if isinstance(value, str):
        return value.replace(home, "~") if home and home in value else value
    if isinstance(value, dict):
        return {k: _scrub_home(v, home) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrub_home(v, home) for v in value]
    return value


def _to_wire(event):
    """A persisted native event ({type, at, seq, ...}) → the event-chunk wire shape ({event, t, ...}),
    or None when it isn't carried on the wire. Only canonical names ride the wire; lifecycle events are
    dropped. task_start/task_done come in two scopes: sample-scoped (capability samples, sample present)
    and task-scoped (warmup/speed, no sample); the capability task-level aggregate (kind=task, no sample)
    is derivable from samples and dropped. Transport fields (type, at, seq) become event and t; seq is
    positional on the wire."""
    name = _WIRE_NAME.get(event.get("type"), event.get("type"))
    if name not in _CANONICAL:
        return None
    if name in ("task_start", "task_done") and "sample" not in event and event.get("kind") == "task":
        return None
    wire = {k: v for k, v in event.items() if k not in ("type", "at", "seq")}
    wire["event"] = name
    wire["t"] = event.get("at")
    return wire


def wire_events(events, home=None):
    """The native stream normalized to the ordered event-chunk wire log (seq is positional, 0-based),
    with the uploader's home prefix scrubbed from every string value."""
    home = str(Path.home()) if home is None else home
    return [_scrub_home(w, home) for w in (_to_wire(e) for e in events) if w is not None]


def events_canonical(events):
    """The wire log's canonical string: each wire event JCS-normalized, joined by single newlines in seq
    order, no trailing newline. events.sha256 (Cross-side ruling A) is sha256 over its UTF-8 bytes, computed
    the same local and platform; the server holds only the wire shape, so nothing else is verifiable."""
    return "\n".join(jcs(w) for w in wire_events(events))


def events_integrity(events):
    """0.2 integrity block over the canonical wire log; chunks is 0 offline (no chunk uploads)."""
    wire = wire_events(events)
    canonical = "\n".join(jcs(w) for w in wire).encode("utf-8")
    return {"sha256": hashlib.sha256(canonical).hexdigest(), "bytes": len(canonical), "chunks": 0,
            "last_seq": len(wire) - 1 if wire else 0}


def _bare(digest):
    """The bare 64-hex of an engine digest, with or without a sha256: prefix."""
    return digest.split(":", 1)[1] if digest and ":" in digest else digest


def _sha256_ref(digest):
    """OCI-style sha256:<hex> for subject.version (Cross-side ruling C); None (infra failure) stays None."""
    return None if not digest else digest if digest.startswith("sha256:") else f"sha256:{digest}"


def _span(wire, task, sample=None):
    """Positional seq range of a task's (or one sample's) events in the wire log. Sample-scoped events
    carry sample; text within a sample does not, so the span is bounded by the sample's task_start and
    task_done and covers the text positionally between them."""
    if sample is None:
        idxs = [i for i, w in enumerate(wire) if w.get("task") == task]
    else:
        idxs = [i for i, w in enumerate(wire) if w.get("task") == task and w.get("sample") == sample]
    return {"from_seq": idxs[0], "to_seq": idxs[-1]} if idxs else None


def _result_0_2(result, wire):
    """One 0.1 engine result mapped onto a 0.2 speedResult or taskResult, with wire-log seq ranges."""
    if result.get("kind") != "task":
        span = _span(wire, result.get("task"))
        return {**result, "events": span} if span else dict(result)
    if result.get("status") == "unsupported":
        # Ruling: unsupported omits passed/samples_n/samples/score (a distinct state, not a 0-of-n).
        return {k: result[k] for k in ("task", "kind", "category", "status", "tokens", "time") if k in result}
    out = {k: v for k, v in result.items() if k not in ("attempts", "samples")}
    out["samples_n"] = result.get("samples")
    fallback = _span(wire, result.get("task")) or {"from_seq": 0, "to_seq": 0}
    out["samples"] = [{**attempt, "events": _span(wire, result.get("task"), attempt.get("sample")) or fallback}
                      for attempt in result.get("attempts", [])]
    return out


def build_run_record(*, run_id, job_id, placement, bench, subject, digest, evidence, client, events, conditions):
    """The client-written fields of a benchclub.run-record/0.2. The server fills counted, verification,
    provenance, submitter, signature and artifacts on submit; offline runs are valid locally but unsubmittable."""
    known = (subject.get("ollama") or {}).get("known_digests") or []
    provider = evidence["provider"]
    hardware = bench["machine"]
    wire = wire_events(events)
    return {
        "schema": RUN_RECORD_SCHEMA,
        "run_id": run_id,
        "job_id": job_id,
        "placement": placement,
        "suite": bench["suite"],
        "subject": {
            "type": "model",
            "id": subject["id"],
            "name": subject["name"],
            **({"vendor": subject["vendor"]} if subject.get("vendor") else {}),
            "version": _sha256_ref(digest),
            "quant": subject["quant"],
            "tag": subject["ollama"]["tag"],
            "digest_registered": digest is not None and _bare(digest) in {_bare(k) for k in known},
            "capabilities": bench["capabilities"],
        },
        "test_agent": {
            **bench["test_agent"],
            "settings": {
                **bench["request"],
                "warmup_load_ms": bench["warmup_load_ms"],
                **({"sandbox": bench["sandbox"]} if js_truthy(bench.get("sandbox")) else {}),
            },
        },
        "runtime": {
            "backend": runtime_backend(hardware),
            "profile": runtime_profile(provider),
            "hardware": hardware,
            "provider": provider,
            "client": client,
            "conditions": {**conditions, **(bench.get("conditions") or {})},
        },
        "events": events_integrity(events),
        "results": [_result_0_2(result, wire) for result in bench["results"]],
        "artifacts": None,
        "counted": None,
        "not_counted_reason": None,
        "verification": None,
        "provenance": None,
        "submitter": None,
        "signature": None,
        "started_at": bench["started_at"],
        "finished_at": bench["finished_at"],
        "wall_seconds": bench["wall_seconds"],
    }


def js_truthy(value):
    """JavaScript's truthiness, where an empty object or list is true."""
    return value is not None and value is not False and value != "" and not (
        isinstance(value, (int, float)) and (value == 0 or value != value))


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
        blockers.append("it ran on an Ollama server benchclub did not start, so its conditions are unknown")
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
