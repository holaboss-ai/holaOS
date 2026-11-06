"""Submitting a run to the hub: claim a job by its code, run the suite, upload its event log, complete.

`benchclub run <code>` is the only way a run reaches the hub. A record without a claimable job_id is
rejected (trust rule #1), so an offline `benchclub eval` run always stays on this machine. The claim
uses the signed-in session; every call after it uses the per-job token the claim hands back.
"""

import json
import sys
import threading
from pathlib import Path

from benchclub import account, bench, hub, record as record_mod, runs
from benchclub.errors import HolaError

CHUNK_BYTES = 64 * 1024
EVENT_CHUNK_SCHEMA = "benchclub.event-chunk/0.1"
SIGN_IN = "Run `benchclub login`, then run the code again."


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
                        "Check the code on the job page, or create a new job and use its code.")
    if status == 409:
        raise HolaError("code_taken", "That code was already claimed.",
                        "Create a new job on the web and run its code.")
    raise HolaError("claim_failed", f"The hub didn't hand out the job (HTTP {status}).", "Try again in a minute.")


def heartbeat(job_id, token):
    """Renew the lease; returns the parsed response. The server signals {"cancel": true} when the job is no
    longer active, which the caller must honor by stopping and aborting."""
    _status, body = account._request("POST", f"/runner/v1/jobs/{job_id}/heartbeat", body={}, token=token)
    return body if isinstance(body, dict) else {}


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
            raise HolaError("events_failed", f"The hub rejected the event log (HTTP {status}{f': {detail}' if detail else ''}).",
                            "Run the code again to retry; chunk upload is idempotent.")


def complete(job_id, token, record):
    """POST the run record to finalize the job. The request body IS the run record (per contract), not a wrapper.
    The server may finalize synchronously (status finalized) or defer (status pending); either is returned as-is."""
    status, body = account._request("POST", f"/runner/v1/jobs/{job_id}/complete", token=token, body=record)
    body = body if isinstance(body, dict) else {}
    if status in (200, 201, 202):
        return body
    if status == 401:
        raise HolaError("signed_out", "The job token was rejected.", SIGN_IN)
    raise HolaError("complete_failed", f"The hub couldn't take the run (HTTP {status}).", "Run the code again to retry.")


def _heartbeat_until_done(worker, job, token, interval):
    """Join the run thread, heartbeating each time it is still alive after `interval`. Returns True if the
    server asked to cancel (heartbeat → {"cancel": true}), else False when the run finishes on its own.

    A transient heartbeat error is swallowed — the lease survives a few missed beats (60 s lease, 15 s beat),
    and upload_events/complete give the authoritative verdict — but an explicit cancel is honored at once.
    """
    while True:
        worker.join(timeout=interval)
        if not worker.is_alive():
            return False
        try:
            if heartbeat(job["job_id"], token).get("cancel") is True:
                return True
        except HolaError:
            pass


def run_job(code, *, on_step=lambda label, info=None: None, ui=bench._quiet, env=None, run_eval=bench.run_eval):
    """Claim → run the suite (heartbeating to hold the lease) → upload events → complete. Returns the outcome."""
    session = account.saved_session()
    if session is None:
        raise HolaError("not_signed_in", "You're not signed in.", SIGN_IN)
    job, token = claim(code, session["token"])
    on_step("claimed", {"job_id": job["job_id"], "subject": job["subject"],
                        "suite": f"{job['suite']['id']}@{job['suite']['version']}", "placement": job["placement"]})
    config, _source = hub.fetch_subject(job["subject"], env=env)
    suite = f"{job['suite']['id']}@{job['suite']['version']}"

    box = {}

    def work():
        try:
            box["result"] = run_eval(config, suite=suite, job_id=job["job_id"], placement=job["placement"], ui=ui, env=env)
        except BaseException as exc:  # noqa: BLE001 — surfaced to the caller after the thread joins
            box["error"] = exc

    worker = threading.Thread(target=work, daemon=True)
    on_step("running", {"suite": suite})
    worker.start()
    interval = max(int(job.get("heartbeat_seconds") or 15), 1)
    try:
        cancelled = _heartbeat_until_done(worker, job, token, interval)
    except BaseException:
        abort(job["job_id"], token, "runner_interrupted")
        raise
    if cancelled:
        abort(job["job_id"], token, "cancelled_by_server")
        raise HolaError("job_cancelled", "The hub cancelled this job while it was running, so nothing was submitted.",
                        "Create a new job on the web and run its code.")
    if "error" in box:
        abort(job["job_id"], token, "run_failed")
        raise box["error"]

    result = box["result"]
    run_dir = Path(result["run_dir"])
    record = runs.read_record(run_dir)
    if record is None:
        raise HolaError("not_found", "The run finished but its record could not be read.",
                        "Run the code again; if it keeps happening, `benchclub doctor` checks your setup.")
    native = [json.loads(line) for line in (run_dir / "events.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    wire = record_mod.wire_events(native)
    on_step("uploading", {"events": len(wire), "chunks": len(chunks(wire))})
    upload_events(job["job_id"], token, wire)
    outcome = complete(job["job_id"], token, record)
    return {"job": job, "result": result, "outcome": outcome}


def _emit(value):
    print(json.dumps(value, indent=2, ensure_ascii=False), flush=True)


def cmd_run(args, out):
    progress = type(out)(sys.stderr) if args.json else out

    def on_step(label, info=None):
        info = info or {}
        if args.json:
            return
        if label == "claimed":
            progress.line(f"Claimed {info['subject']} · {info['suite']} ({info['placement']}).")
        elif label == "running":
            progress.line(f"Running {info['suite']}{progress.ell} (this is the real benchmark; it takes a little while)")
        elif label == "uploading":
            progress.line(f"Uploading the event log ({info['events']} events, {info['chunks']} chunk(s)){progress.ell}")

    outcome = run_job(args.code, on_step=on_step)["outcome"]
    if args.json:
        _emit({"ok": True, "status": outcome.get("status"), "run_id": outcome.get("run_id"),
               "counted": outcome.get("counted"), "not_counted_reason": outcome.get("not_counted_reason"),
               "url": outcome.get("url")})
    else:
        _report(out, outcome)
    return 0


def _report(out, outcome):
    status = outcome.get("status")
    url = outcome.get("url")
    if status == "pending":
        out.line("Submitted. The hub is still finalizing this run; it will appear in My runs shortly.")
        if url:
            out.line(url, indent=4)
        return
    if outcome.get("counted") is False:
        reasons = outcome.get("not_counted_reason") or []
        why = ", ".join(reasons) if isinstance(reasons, list) else str(reasons)
        out.good("Submitted.")
        out.line(f"It is saved but not counted ({why or 'see the run page'}).", indent=4)
    else:
        out.good("Submitted and counted.")
    if url:
        out.line(f"See it: {url}", indent=4)


def add_commands(sub):
    """Registers `benchclub run` on cli.py's subparsers."""
    p = sub.add_parser("run", help="claim a job by its code, run the suite, and submit the result to the hub")
    p.add_argument("code", help="the claim code shown on the job page on the web")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_run)
