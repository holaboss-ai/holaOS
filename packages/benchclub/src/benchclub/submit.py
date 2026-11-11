"""Submitting a run to BenchClub: create or claim a job, run the suite, upload its event log, complete.

`benchclub run <model>` asks BenchClub for a job on a registered model and claims it; `benchclub run <code>`
claims a job made on the web. A record without a claimable job_id is rejected (trust rule #1), so an offline
`benchclub eval` run always stays on this machine. Creating and claiming use the signed-in session; every call
after the claim uses the per-job token the claim hands back.
"""

import json
import os
import re
import sys
import threading
import time
from pathlib import Path

from benchclub import account, bench, hub, ollama, pinned, record as record_mod, runs
from benchclub.errors import HolaError

CHUNK_BYTES = 64 * 1024
EVENT_CHUNK_SCHEMA = "benchclub.event-chunk/0.1"
SIGN_IN = "Run `benchclub login`, then run this again."
CODE_SHAPE = re.compile(r"[A-Z0-9]{4,12}")
CODE_NOISE = re.compile(r"[\s-]")
PROGRESS_SECONDS = 3

# What each not-counted reason means and what to do, in the order they are worth fixing.
REASONS = {
    "engine_outside_profile": "BenchClub doesn't count runs on this Ollama version yet. Install a version "
                              "`benchclub doctor` says counts, then run it again.",
    "digest_not_registered": "The version this model's tag points to now isn't registered on BenchClub yet. "
                             "New versions are usually registered within a day; run it again then.",
    "regrade_mismatch": "BenchClub's regrade of the uploaded log didn't match this run, so it doesn't count. "
                        "Run `benchclub doctor`, then run it again.",
    "aborted": "The job stopped or expired before the run finished. Run it again.",
    "claim_mismatch": "This run doesn't match the job it claimed. Update benchclub, then run it again.",
    "schema_invalid": "BenchClub couldn't read this run's record. Update benchclub, then run it again.",
    "suite_hash_mismatch": "This run used a different copy of the suite than BenchClub's. Update benchclub, "
                           "then run it again.",
    "suite_not_frozen": "This suite isn't open for counted runs yet.",
}
SPEED_VOID = ("Speed isn't counted: other programs used too much CPU while it generated. Close them and "
              "run it again for a speed number.")


def normalize_code(text):
    return CODE_NOISE.sub("", text).upper()


def looks_like_code(text):
    """A job code as the web shows it: capitals and digits, never a model name someone typed in lowercase."""
    return bool(CODE_SHAPE.fullmatch(normalize_code(text))) and not any(c.islower() for c in text)


def resolve_target(target, env=None):
    """("model", catalog entry) for a model BenchClub lists, else ("code", code) for a job's claim code."""
    entries, source = hub.fetch_subjects_index(env)
    try:
        entry = hub.resolve(target, entries)
    except HolaError:
        if looks_like_code(target):
            return "code", normalize_code(target)
        raise
    if source != "hub":
        raise HolaError("offline", "Couldn't reach BenchClub to start a counted run.",
                        "Check your connection, then run this again. `benchclub eval` runs offline but stays local.")
    return "model", entry


def engine_check(env=None, find_binary=ollama.find_binary, version_of=ollama.binary_version):
    """None when this machine's Ollama counts (or we can't tell); otherwise its version and the versions that do."""
    env = os.environ if env is None else env
    binary = find_binary(env=env)
    if not binary:
        return None
    version = version_of(binary)
    supported = hub.counted_versions(version, hub.runtime_profiles(env))
    return None if supported is None else {"version": version, "supported": supported}


def create_job(entry, suite, session_token):
    """A local job on the model's registered build; returns its claim code."""
    suite_id, _, version = suite.partition("@")
    body = {"subject": entry["id"], "suite": {"id": suite_id, "version": version}, "placement": "local"}
    if entry.get("build_digest"):
        body["build_digest"] = entry["build_digest"]
    status, reply = account._request("POST", "/v1/jobs", body=body, token=session_token)
    reply = reply if isinstance(reply, dict) else {}
    if status in (200, 201) and reply.get("claim_code"):
        return reply["claim_code"]
    code = reply.get("code")
    if status == 401:
        raise HolaError("signed_out", "Your sign-in has expired or was signed out.", SIGN_IN)
    if code == "handle_required":
        raise HolaError(code, "Finish signing up on BenchClub first: choose a handle.",
                        "Sign in on the website, pick your handle, then run this again.")
    if code == "daily_limit":
        raise HolaError(code, "You've started the most runs BenchClub takes in a day.", "Run it again tomorrow.")
    if code in ("subject_not_found", "no_registered_build"):
        raise HolaError(code, f"BenchClub can't start a counted run of {entry['name']} right now.",
                        "Pick another model from `benchclub list`.")
    if code == "suite_not_found":
        raise HolaError(code, f"BenchClub doesn't take counted runs of {suite} yet.",
                        f"Leave out --suite to run {pinned.DEFAULT_SUITE}.")
    raise HolaError("job_failed", f"BenchClub didn't start the run (HTTP {status}).", "Try again in a minute.")


def claim(code, session_token):
    """Claim the job a code stands for: (job, job_token). Only the account that made the job may claim it."""
    status, body = account._request("POST", "/runner/v1/claim", body={"code": code}, token=session_token)
    body = body if isinstance(body, dict) else {}
    if status in (200, 201) and isinstance(body.get("job"), dict) and body.get("token"):
        return body["job"], body["token"]
    if status == 401:
        raise HolaError("signed_out", "Your sign-in has expired or was signed out.", SIGN_IN)
    if status in (403, 404, 410):
        raise HolaError("bad_code", f"No job is waiting for the code {code}.",
                        "Check the code on the job page, or run a model by name: `benchclub list` shows them.")
    if status == 409:
        raise HolaError("code_taken", "That code was already claimed.",
                        "Run the model by name instead, e.g. `benchclub run qwen3.5:2b`.")
    raise HolaError("claim_failed", f"BenchClub didn't hand out the job (HTTP {status}).", "Try again in a minute.")


class Progress:
    """Passes UI events through and keeps what the run is doing, for the heartbeat to show on the website.

    Display only: nothing here is scored, and the server ignores a progress it can't read.
    """

    def __init__(self, ui):
        self.ui = ui
        self.lock = threading.Lock()
        self.changed = threading.Event()
        self.layers = {}
        self.state = {"phase": "pull", "pull": None, "speed": [], "tasks": []}

    def __call__(self, kind, data):
        self.ui(kind, data)
        with self.lock:
            if kind == "pull":
                moved = self._pull(data)
            elif kind == "event":
                moved = self._event(data)
            else:
                moved = False
        if moved:
            self.changed.set()

    def _pull(self, data):
        total, done, digest = data.get("total"), data.get("completed"), data.get("digest")
        if not (isinstance(total, int) and total > 0 and digest):
            return False
        self.layers[digest] = (min(int(done or 0), total), total)
        self.state["phase"] = "pull"
        self.state["pull"] = {"done": sum(d for d, _ in self.layers.values()),
                              "total": sum(t for _, t in self.layers.values())}
        return True

    def _event(self, e):
        kind, step, tasks = e.get("type"), e.get("kind"), self.state["tasks"]
        if kind == "task_start" and step in ("warmup", "speed"):
            self.state["phase"] = step
        elif kind == "task_done" and step == "speed" and isinstance(e.get("decode_tps"), (int, float)):
            self.state["speed"].append(round(float(e["decode_tps"]), 1))
        elif kind == "task_start" and step == "task":
            self.state["phase"] = "tasks"
            total = e.get("samples")
            tasks.append({"task": str(e.get("task")), "category": e.get("category"), "samples": [],
                          "total": total if isinstance(total, int) else None})
        elif kind == "sample_done" and tasks and e.get("task") == tasks[-1]["task"]:
            tasks[-1]["samples"].append(e.get("passed") is True)
        elif kind == "task_done" and step == "task" and tasks and e.get("status") == "unsupported":
            tasks[-1]["unsupported"] = True
        else:
            return False
        return True

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.state))


def heartbeat(job_id, token, progress=None):
    """Renew the lease, carrying what the run is doing; returns the parsed response. The server signals
    {"cancel": true} when the job is no longer active, which the caller must honor by stopping and aborting."""
    body = {"progress": progress} if progress else {}
    _status, reply = account._request("POST", f"/runner/v1/jobs/{job_id}/heartbeat", body=body, token=token)
    return reply if isinstance(reply, dict) else {}


def abort(job_id, token, reason):
    try:
        account._request("POST", f"/runner/v1/jobs/{job_id}/abort", body={"reason": reason}, token=token)
    except HolaError:
        pass


def chunks(wire, limit=CHUNK_BYTES):
    """Contiguous (seq, events) slices of the wire log, each at most `limit` bytes; one oversize event rides alone."""
    out, start, size = [], 0, 0
    for i, event in enumerate(wire):
        n = len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
        if i > start and size + n > limit:
            out.append((start, wire[start:i]))
            start, size = i, 0
        size += n
    if start < len(wire):
        out.append((start, wire[start:]))
    return out


def upload_events(job_id, token, wire):
    """Upload the wire event log as event-chunk/0.1 bodies; seq is the position of each chunk's first event."""
    for seq, events in chunks(wire):
        status, body = account._request("POST", f"/runner/v1/jobs/{job_id}/events", token=token, body={
            "schema": EVENT_CHUNK_SCHEMA, "job_id": job_id, "seq": seq, "events": events})
        if status not in (200, 201, 202, 204):
            detail = (body or {}).get("error") if isinstance(body, dict) else None
            raise HolaError("events_failed", f"BenchClub rejected the event log (HTTP {status}{f': {detail}' if detail else ''}).",
                            "Run it again to retry; chunk upload is idempotent.")


def complete(job_id, token, record):
    """POST the run record to finalize the job. The request body IS the run record (per contract), not a wrapper.
    The server may finalize synchronously (status finalized) or defer (status pending); either is returned as-is."""
    status, body = account._request("POST", f"/runner/v1/jobs/{job_id}/complete", token=token, body=record)
    body = body if isinstance(body, dict) else {}
    if status in (200, 201, 202):
        return body
    if status == 401:
        raise HolaError("signed_out", "The job token was rejected.", SIGN_IN)
    raise HolaError("complete_failed", f"BenchClub couldn't take the run (HTTP {status}).", "Run it again to retry.")


def _heartbeat_until_done(worker, job, token, interval, progress=None):
    """Join the run thread, heartbeating every `interval` while it is alive, and sooner (at most every
    PROGRESS_SECONDS) when the run's progress moved. Returns True if the server asked to cancel
    (heartbeat → {"cancel": true}), else False when the run finishes on its own.

    A transient heartbeat error is swallowed — the lease survives a few missed beats (60 s lease, 15 s beat),
    and upload_events/complete give the authoritative verdict — but an explicit cancel is honored at once.
    """
    last = time.monotonic()
    while True:
        worker.join(timeout=min(interval, PROGRESS_SECONDS) if progress else interval)
        if not worker.is_alive():
            return False
        now = time.monotonic()
        moved = progress is not None and progress.changed.is_set() and now - last >= PROGRESS_SECONDS
        if not (moved or now - last >= interval):
            continue
        last = now
        if progress is not None:
            progress.changed.clear()
        try:
            if heartbeat(job["job_id"], token, progress.snapshot() if progress else None).get("cancel") is True:
                return True
        except HolaError:
            pass


def run_job(code, *, on_step=lambda label, info=None: None, ui=bench._quiet, env=None, run_eval=bench.run_eval,
            eval_options=None):
    """Claim → run the suite (heartbeating to hold the lease) → upload events → complete. Returns the outcome."""
    session = account.saved_session()
    if session is None:
        raise HolaError("not_signed_in", "You're not signed in.", SIGN_IN)
    job, token = claim(code, session["token"])
    config, _source = hub.fetch_subject(job["subject"], env=env)
    suite = f"{job['suite']['id']}@{job['suite']['version']}"
    on_step("claimed", {"job_id": job["job_id"], "subject": job["subject"], "config": config,
                        "suite": suite, "placement": job["placement"]})

    box = {}
    progress = Progress(ui)

    def work():
        try:
            box["result"] = run_eval(config, suite=suite, job_id=job["job_id"], placement=job["placement"],
                                     ui=progress, env=env, **(eval_options or {}))
        except BaseException as exc:  # noqa: BLE001 — surfaced to the caller after the thread joins
            box["error"] = exc

    worker = threading.Thread(target=work, daemon=True)
    on_step("running", {"suite": suite})
    worker.start()
    interval = max(int(job.get("heartbeat_seconds") or 15), 1)
    try:
        cancelled = _heartbeat_until_done(worker, job, token, interval, progress)
    except BaseException:
        abort(job["job_id"], token, "runner_interrupted")
        raise
    if cancelled:
        abort(job["job_id"], token, "cancelled_by_server")
        raise HolaError("job_cancelled", "BenchClub cancelled this job while it was running, so nothing was submitted.",
                        "Run it again.")
    if "error" in box:
        abort(job["job_id"], token, "run_failed")
        raise box["error"]

    result = box["result"]
    run_dir = Path(result["run_dir"])
    record = runs.read_record(run_dir)
    if record is None:
        raise HolaError("not_found", "The run finished but its record could not be read.",
                        "Run it again; if it keeps happening, `benchclub doctor` checks your setup.")
    native = [json.loads(line) for line in (run_dir / "events.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    wire = record_mod.wire_events(native)
    on_step("uploading", {"events": len(wire), "chunks": len(chunks(wire))})
    upload_events(job["job_id"], token, wire)
    outcome = complete(job["job_id"], token, record)
    return {"job": job, "result": result, "outcome": outcome}


def _emit(value):
    print(json.dumps(value, indent=2, ensure_ascii=False), flush=True)


def cmd_run(args, out):
    from benchclub import cli  # cli imports this module, so only once both are loaded

    if account.saved_session() is None:
        raise HolaError("not_signed_in", "You're not signed in.", SIGN_IN)
    kind, target = resolve_target(args.target)
    interactive = not args.json and sys.stdin.isatty()
    progress = type(out)(sys.stderr) if args.json else out
    code = target
    if kind == "model":
        engine = engine_check()
        if engine:
            message = (f"This run won't count: BenchClub counts runs on Ollama {engine['supported']}, "
                       f"and this machine has {engine['version']}.")
            if not (getattr(args, "yes", False) or (interactive and cli.ask(
                    progress, "Run it anyway? It will be saved but not counted. [y/N] ", False, message))):
                raise HolaError("engine_not_counted", message,
                                f"Install Ollama {engine['supported']}, or pass --yes to run it anyway.", engine)
        code = create_job(target, getattr(args, "suite", None) or pinned.DEFAULT_SUITE,
                          account.saved_session()["token"])

    view = cli.EvalView({"name": "", "quant": ""}, progress.stream)

    def on_step(label, info=None):
        info = info or {}
        if args.json:
            return
        if label == "claimed":
            view.subject = info["config"]
            view.speed_suite = info["suite"] not in cli.CODING_SUITES
            progress.line(f"{info['config'].get('name')} {info['config'].get('quant')} {progress.sep} {info['suite']} "
                          f"{progress.sep} job {info['job_id'][-8:]}")
        elif label == "uploading":
            view.end_pending()
            progress.line(f"Uploading the event log ({info['events']} events){progress.ell}")

    options = {"unload": True if getattr(args, "unload", False) else None,
               "keep_model": getattr(args, "keep_model", False),
               "confirm": cli.unload_prompt(view, interactive),
               "confirm_busy": cli.busy_prompt(view, interactive)}
    try:
        done = run_job(code, on_step=on_step, ui=(lambda kind, data: None) if args.json else view,
                       eval_options=options)
    finally:
        view.end_pending()
    outcome = done["outcome"]
    if args.json:
        _emit({"ok": True, "status": outcome.get("status"), "run_id": outcome.get("run_id"),
               "counted": outcome.get("counted"), "not_counted_reason": outcome.get("not_counted_reason"),
               "url": outcome.get("url")})
    else:
        report(out, outcome, done.get("result"))
        if outcome.get("status") != "pending":
            suggest_next(out, next_models(account.saved_session()["token"]))
    return 0


def report(out, outcome, result=None):
    """The result lines, then whether it counts and why not, in words, then the link."""
    from benchclub import cli

    if result and result.get("summary") and result.get("suite") not in cli.CODING_SUITES:
        out.line()
        for line in cli.summary_lines(result, out):
            out.line(line, indent=4)
        out.line()
    url = outcome.get("url")
    if outcome.get("status") == "pending":
        out.line("Submitted. BenchClub is still checking this run; it will appear in My runs shortly.")
        if url:
            out.line(url, indent=4)
        return
    reasons = outcome.get("not_counted_reason") or []
    reasons = reasons if isinstance(reasons, list) else [str(reasons)]
    if outcome.get("counted") is False:
        out.warn("Submitted, but this run doesn't count.")
        for reason in [r for r in REASONS if r in reasons] + [r for r in reasons if r not in REASONS and r != "machine_busy"]:
            out.line(REASONS.get(reason, f"Reason: {reason}."), indent=4)
    else:
        out.good("Submitted and counted, checked by BenchClub's regrade.")
    if "machine_busy" in reasons:
        out.line(SPEED_VOID, indent=4)
    if url:
        out.line(f"See it: {url}", indent=4)


NEXT_SHOWN = 3


def next_models(token, limit=NEXT_SHOWN):
    """Registered models this machine holds that this account hasn't run, as BenchClub sees it; [] if it can't say."""
    try:
        status, body = account._request("GET", f"/v1/me/next-models?limit={limit}", token=token)
    except HolaError:
        return []
    models = body.get("models") if status == 200 and isinstance(body, dict) else None
    return [m for m in models if isinstance(m, dict) and m.get("tag")] if isinstance(models, list) else []


def suggest_next(out, models):
    """A few commands to run next, so a first run is not the last."""
    if not models:
        return
    out.line()
    out.line("Next on this machine:")
    width = max(len(m["tag"]) for m in models)
    for m in models:
        size = f" {out.sep} {m['download_bytes'] / 2**30:.1f} GB" if m.get("download_bytes") else ""
        label = " ".join(part for part in (m.get("name"), m.get("quant")) if part)
        out.line(f"benchclub run {m['tag']:<{width}}  {label}{size}", indent=4)


def add_commands(sub):
    """Registers `benchclub run` on cli.py's subparsers."""
    p = sub.add_parser("run", help="run a model (or a job's code) and submit the result to BenchClub")
    p.add_argument("target", help="a model from `benchclub list` (e.g. qwen3.5:2b), or the code on a job page")
    p.add_argument("--suite", help=f"which suite to run a model on (default {pinned.DEFAULT_SUITE})")
    p.add_argument("--yes", action="store_true", help="run even if this run won't count")
    p.add_argument("--unload", action="store_true", help="unload models your own Ollama holds in memory")
    p.add_argument("--keep-model", action="store_true", help="keep a model this run downloaded")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_run)
