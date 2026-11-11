"""Hosted models: the standard suite's graded tasks against a model behind an OpenAI-compatible API.

A hosted model has no weights to run, so this touches no Ollama. Speed isn't measured (it would be the provider's
serving, not hardware). `benchclub api` keeps its result on this machine as an API reference; the cloud worker
(cloud.py) runs the same thing for a BenchClub job and submits it.
"""

import os
import re

from benchclub import bench, paths, pinned
from benchclub.errors import HolaError
from benchclub.record import build_api_run_record, dumps

# engine → (OpenAI-compatible base URL, the environment variable its key is read from)
PROVIDERS = {
    "anthropic": ("https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"),
    "openai": ("https://api.openai.com/v1", "OPENAI_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"),
}
CUSTOM_ENGINE = "openai_compatible"
SLUG_RE = re.compile(r"[^a-z0-9.]+")


def runs_dir(env=None):
    """API references live apart from runs/, which holds only Ollama runs."""
    return paths.home(env) / "api-runs"


def endpoint(provider=None, base_url=None, key_env=None):
    """(engine, base URL, key variable) from a provider preset, an explicit base URL, or both (the URL wins)."""
    if provider is None and base_url is None:
        raise HolaError("api_endpoint_missing", "Say which API to test.",
                        f"Pass --provider ({', '.join(PROVIDERS)}) or --base-url for any OpenAI-compatible API.")
    preset_url, preset_key = PROVIDERS[provider] if provider else (None, None)
    key = key_env or preset_key
    if key is None:
        raise HolaError("api_key_env_missing", "Say which environment variable holds the API key.",
                        "Pass --api-key-env NAME with --base-url.")
    return provider or CUSTOM_ENGINE, base_url or preset_url, key


def slug(model):
    return SLUG_RE.sub("-", model.lower()).strip("-")


def run_hosted(subject, *, engine, base_url, key, job_id=None, placement="local", runs_root=None, env=None,
               ui=bench._quiet):
    """Run the standard suite on a hosted model and write run-record.json and events.jsonl into a new run dir.
    subject: {"id", "name"?, "vendor"?, "api": {"model"}, "registered"?}."""
    env = dict(env or {})
    suite = pinned.DEFAULT_SUITE
    run = bench.Run(subject, suite, runs_root or runs_dir(env))
    run.run_dir.mkdir(parents=True, exist_ok=True)
    run.emit("run_started", {"suite": suite, "subject_id": subject["id"]})
    child_env = {**env, "HOLAEVAL_API_KEY": key}
    status = "failed"
    try:
        result = bench.run_holaeval(run, None, pinned.pack_path(suite), child_env, ui,
                                    api={"base_url": base_url, "model": subject["api"]["model"]})
        status = "done"
    finally:
        run.emit("run_finished", {"status": status})
        run.write_events()
    record = build_api_run_record(run_id=run.run_id, job_id=job_id or f"local:{run.run_id}", placement=placement,
                                  bench=result, subject=subject, engine=engine, base_url=base_url,
                                  client=dict(bench.CLIENT), events=run.events)
    record_path = run.run_dir / "run-record.json"
    record_path.write_text(dumps(record), encoding="utf-8")
    return {"run_id": run.run_id, "run_dir": str(run.run_dir), "record_path": str(record_path), "record": record}


def run_api(model, *, provider=None, base_url=None, key_env=None, env=None, ui=bench._quiet):
    """`benchclub api`: an offline API reference, never submitted (its job_id is local:<run_id>)."""
    env = os.environ if env is None else env
    engine, base, key_name = endpoint(provider, base_url, key_env)
    key = env.get(key_name)
    if not key:
        raise HolaError("api_key_missing", f"{key_name} is not set.",
                        f"Export your API key as {key_name}, or name another variable with --api-key-env.")
    subject = {"id": f"{engine}-{slug(model)}", "name": model, "api": {"model": model}}
    return run_hosted(subject, engine=engine, base_url=base, key=key, env=env, ui=ui)


def submit_hosted(job, token, subject, *, engine, base_url, key, runs_root=None, env=None, ui=None,
                  record_base_url=True):
    """Run a claimed job on a hosted model, holding its lease, then upload the event log and complete it.
    Aborts the job on any failure before re-raising. Returns {"result", "outcome"}."""
    import json
    import shutil
    import threading
    from pathlib import Path

    from benchclub import record as record_mod, submit

    progress = submit.Progress(ui or (lambda _kind, _data: None))
    progress.state["phase"] = "warmup"
    box = {}

    def work():
        try:
            box["result"] = run_hosted(subject, engine=engine, base_url=base_url, key=key, job_id=job["job_id"],
                                       placement=job["placement"], runs_root=runs_root, env=env, ui=progress)
        except BaseException as exc:  # noqa: BLE001 — re-raised after the heartbeat loop
            box["error"] = exc

    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    interval = max(int(job.get("heartbeat_seconds") or 15), 1)
    try:
        cancelled = submit._heartbeat_until_done(worker, job, token, interval, progress)
    except BaseException:
        submit.abort(job["job_id"], token, "runner_interrupted")
        raise
    if cancelled:
        submit.abort(job["job_id"], token, "cancelled_by_server")
        raise HolaError("job_cancelled", "BenchClub cancelled the job while it ran.", "Run it again.")
    if "error" in box:
        submit.abort(job["job_id"], token, "run_failed")
        raise box["error"]

    result = box["result"]
    record = result["record"]
    if not record_base_url:
        record["runtime"]["provider"].pop("base_url", None)
    native = [json.loads(line) for line in
              (Path(result["run_dir"]) / "events.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    submit.upload_events(job["job_id"], token, record_mod.wire_events(native))
    outcome = submit.complete(job["job_id"], token, record)
    shutil.rmtree(result["run_dir"], ignore_errors=True)
    return {"result": result, "outcome": outcome}


def run_own_endpoint(target, *, provider=None, base_url=None, key_env=None, api_model=None, env=None, ui=None):
    """`benchclub run <model> --base-url …`: a BenchClub job on a hosted model, answered by the submitter's own
    endpoint (a local gateway, their own key). BenchClub can't see what served it, so it never counts."""
    from benchclub import account, submit

    env = os.environ if env is None else env
    session = account.saved_session()
    if session is None:
        raise HolaError("not_signed_in", "You're not signed in.", submit.SIGN_IN)
    if base_url and not (provider or key_env):
        engine, base, key_name = CUSTOM_ENGINE, base_url, None  # a local gateway that takes no key
    else:
        engine, base, key_name = endpoint(provider, base_url, key_env)
    key = env.get(key_name) if key_name else "local"
    if not key:
        raise HolaError("api_key_missing", f"{key_name} is not set.",
                        f"Export your API key as {key_name}, or name another variable with --api-key-env.")
    code = submit.normalize_code(target) if submit.looks_like_code(target) else submit.create_job(
        {"id": slug(target), "name": target}, pinned.DEFAULT_SUITE, session["token"])
    job, token = submit.claim(code, session["token"])
    model = api_model or (target if not submit.looks_like_code(target) else job["build"]["tag"])
    subject = {"id": job["subject"], "api": {"model": model}, "registered": True}
    done = submit_hosted(job, token, subject, engine=engine, base_url=base, key=key, runs_root=runs_dir(env),
                         env=env, ui=ui, record_base_url=False)
    return {"job": job, "model": model, **done}


def add_endpoint_arguments(p):
    """`benchclub run`'s flags for answering a hosted model's job through your own endpoint."""
    p.add_argument("--base-url", help="answer a hosted model's run through your own OpenAI-compatible endpoint, "
                   "e.g. http://127.0.0.1:3425/v1; it is submitted as self-reported and never counts")
    p.add_argument("--provider", choices=sorted(PROVIDERS), help="answer it through a known API with your own key")
    p.add_argument("--api-key-env", metavar="NAME", help="the environment variable that holds your endpoint's key")
    p.add_argument("--api-model", metavar="ID", help="the model as your endpoint names it, when that differs, "
                   "e.g. claude/claude-fable-5-2")


def task_results(record):
    return [r for r in record["results"] if r["kind"] == "task"]


def cmd_run_own_endpoint(args, out):
    from benchclub import submit
    from benchclub.cli import TASK_LABELS

    def ui(kind, data):
        if args.json or kind != "event" or data.get("type") != "task_done" or data.get("kind") != "task":
            return
        label = TASK_LABELS.get(data["task"], data["task"])
        mark = out.ok if data.get("passed") == data.get("samples") else out.fail
        out.line(f"{mark} {label} {data.get('passed', 0)}/{data.get('samples', 0)}")

    if not args.json:
        out.line(f"{out.step} {args.target} {out.sep} {pinned.DEFAULT_SUITE} {out.sep} through your own endpoint, "
                 "self-reported")
    done = run_own_endpoint(args.target, provider=args.provider, base_url=args.base_url, key_env=args.api_key_env,
                            api_model=args.api_model, ui=ui)
    outcome = done["outcome"]
    if args.json:
        submit._emit({"ok": True, "status": outcome.get("status"), "run_id": outcome.get("run_id"),
                      "counted": outcome.get("counted"), "not_counted_reason": outcome.get("not_counted_reason"),
                      "model": done["model"], "url": outcome.get("url")})
    else:
        submit.report(out, outcome)
    return 0


def cmd_api(args, out):
    from benchclub.cli import TASK_LABELS, emit_json

    def ui(kind, data):
        if args.json or kind != "event":
            return
        if data.get("type") == "start":
            out.line(f"{out.step} {args.model} {out.sep} {data.get('suite')} {out.sep} API reference, speed not measured")
        elif data.get("type") == "task_done" and data.get("kind") == "task":
            label = TASK_LABELS.get(data["task"], data["task"])
            mark = out.ok if data.get("passed") == data.get("samples") else out.fail
            out.line(f"{mark} {label} {data.get('passed', 0)}/{data.get('samples', 0)}")

    result = run_api(args.model, provider=args.provider, base_url=args.base_url, key_env=args.api_key_env, ui=ui)
    record = result["record"]
    tasks = task_results(record)
    passed, total = sum(r["passed"] or 0 for r in tasks), sum(r["samples_n"] or 0 for r in tasks)
    served = record["runtime"]["hardware"]["served"]
    if args.json:
        emit_json({"ok": True, "model": args.model, "passed": passed, "samples": total, "reference_only": True,
                   "served": served, "run_dir": result["run_dir"], "record_path": result["record_path"],
                   "tasks": {r["task"]: {"passed": r["passed"], "samples": r["samples_n"], "reasons": r.get("reasons")}
                             for r in tasks}})
        return 0
    out.line()
    out.line(f"{passed}/{total} passed in {record['wall_seconds']:g} s. An API reference: it stays on this machine and "
             "isn't published.")
    if served:
        out.line("Served by " + ", ".join(" via ".join(filter(None, (s.get("model"), s.get("provider")))) for s in served))
    out.line(f"Saved to {paths.display(result['record_path'])}")
    return 0


def add_commands(sub):
    p = sub.add_parser("api", help="test a hosted model through its OpenAI-compatible API (a reference, not published)")
    p.add_argument("model", help="the model as the API names it, e.g. anthropic/claude-haiku-5.5 on openrouter")
    p.add_argument("--provider", choices=sorted(PROVIDERS), help="a known API; its key comes from "
                   + ", ".join(f"{k} ({v[1]})" for k, v in PROVIDERS.items()))
    p.add_argument("--base-url", help="any other OpenAI-compatible API, e.g. https://host/v1")
    p.add_argument("--api-key-env", metavar="NAME", help="the environment variable that holds the key")
    p.add_argument("--json", action="store_true", help="print one JSON result instead of progress")
    p.set_defaults(fn=cmd_api)

