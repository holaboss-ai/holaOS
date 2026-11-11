"""`benchclub cloud-worker`: BenchClub's own runner for platform jobs (placement "platform").

It claims the oldest queued platform job it can run with a runner key (not a person's session), runs it, and
submits it through the same heartbeat → events → complete endpoints a person's run uses, so the hub judges and
regrades it exactly the same way. This worker runs hosted models (builds whose engine is an API provider it has
a key for); GPU builds stay queued for a GPU worker.
"""

import json
import os
import shutil
import time

from benchclub import account, hub, paths, pinned, remote, submit
from benchclub.errors import HolaError

RUNNER_KEY_ENV = "BENCHCLUB_RUNNER_KEY"
POLL_SECONDS = 10
ERROR_BACKOFF_SECONDS = 30
KEEP_FAILED_RUNS = 20


def log(event, **fields):
    print(json.dumps({"event": event, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields},
                     ensure_ascii=False), flush=True)


def engines_available(env=None):
    """The hosted engines this worker can run: those whose API key is set."""
    env = os.environ if env is None else env
    return sorted(engine for engine, (_url, key) in remote.PROVIDERS.items() if env.get(key))


def claim_next(engines, runner_key):
    """(job, token, subject) for the oldest queued platform job on one of `engines`, or None when there is none."""
    status, body = account._request("POST", "/runner/v1/platform/claim", body={"engines": engines}, token=runner_key)
    if status == 204 or (status == 200 and isinstance(body, dict) and body.get("job") is None):
        return None
    if status == 401:
        raise HolaError("runner_key_invalid", "BenchClub refused the runner key.", f"Check {RUNNER_KEY_ENV}.")
    if status != 200 or not isinstance(body, dict):
        raise HolaError("claim_failed", f"Couldn't claim a platform job (HTTP {status}).", None)
    return body["job"], body["token"], body.get("subject") or {}


def runs_root(env=None):
    return paths.home(env) / "cloud-runs"


def run_platform_job(claimed, env=None, ui=None):
    """Run one claimed job and submit it; aborts the job on any failure before re-raising. Returns the outcome."""
    env = os.environ if env is None else env
    job, token, info = claimed
    engine, model = job["build"]["engine"], job["build"]["tag"]
    suite = f"{job['suite']['id']}@{job['suite']['version']}"
    if engine not in remote.PROVIDERS or not env.get(remote.PROVIDERS[engine][1]):
        submit.abort(job["job_id"], token, f"engine_unavailable:{engine}")
        raise HolaError("engine_unavailable", f"This worker can't run {engine} builds.")
    if suite != pinned.DEFAULT_SUITE:
        submit.abort(job["job_id"], token, f"suite_unsupported:{suite}")
        raise HolaError("suite_unsupported", f"Hosted models run {pinned.DEFAULT_SUITE} only, not {suite}.")
    base_url, key_name = remote.PROVIDERS[engine]
    subject = {"id": job["subject"], "name": info.get("name"), "vendor": info.get("vendor"), "api": {"model": model},
               "registered": True}
    done = remote.submit_hosted(job, token, subject, engine=engine, base_url=base_url, key=env[key_name],
                                runs_root=runs_root(env), env=env, ui=ui)
    return {"job": job, **done}


def prune_failed(env=None, keep=KEEP_FAILED_RUNS):
    root = runs_root(env)
    if not root.is_dir():
        return
    dirs = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in dirs[keep:]:
        shutil.rmtree(stale, ignore_errors=True)


def cmd_cloud_worker(args, _out):
    runner_key = os.environ.get(RUNNER_KEY_ENV)
    if not runner_key:
        raise HolaError("runner_key_missing", f"{RUNNER_KEY_ENV} is not set.", "The worker claims jobs with it.")
    engines = engines_available()
    if not engines:
        raise HolaError("no_engines", "No hosted-model API key is set, so there is nothing this worker can run.",
                        "Set one of " + ", ".join(key for _url, key in remote.PROVIDERS.values()) + ".")
    log("worker_ready", engines=engines, hub=hub.api_base())
    while True:
        try:
            claimed = claim_next(engines, runner_key)
        except HolaError as exc:
            log("claim_failed", code=exc.code, message=exc.message)
            if args.once:
                return 1
            time.sleep(ERROR_BACKOFF_SECONDS)
            continue
        if claimed is None:
            if args.once:
                return 0
            time.sleep(args.poll)
            continue
        job = claimed[0]
        log("job_claimed", job_id=job["job_id"], subject=job["subject"], engine=job["build"]["engine"],
            model=job["build"]["tag"])
        started = time.monotonic()
        try:
            done = run_platform_job(claimed)
            outcome = done["outcome"]
            log("job_done", job_id=job["job_id"], run_id=outcome.get("run_id"), counted=outcome.get("counted"),
                not_counted_reason=outcome.get("not_counted_reason"), seconds=round(time.monotonic() - started, 1))
        except HolaError as exc:
            log("job_failed", job_id=job["job_id"], code=exc.code, message=exc.message)
        except Exception as exc:  # noqa: BLE001 — one bad job must not stop the worker
            log("job_failed", job_id=job["job_id"], code="unexpected", message=f"{type(exc).__name__}: {exc}")
        prune_failed()
        if args.once:
            return 0


def add_commands(sub):
    p = sub.add_parser("cloud-worker", help="BenchClub's runner for platform jobs on hosted models (needs a runner key)")
    p.add_argument("--once", action="store_true", help="run at most one job, then exit")
    p.add_argument("--poll", type=float, default=POLL_SECONDS, help="seconds between checks for a job")
    p.set_defaults(fn=cmd_cloud_worker)

