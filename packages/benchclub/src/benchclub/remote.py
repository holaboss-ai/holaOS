"""`benchclub api`: the standard suite's graded tasks against a hosted model behind an OpenAI-compatible API.

A hosted model has no weights to run, so this touches neither Ollama nor the hub. Speed isn't measured (it would be
the provider's serving, not hardware), and the result stays on this machine as an API reference, never a counted run.
"""

import json
import os
import re
import subprocess
import sys
import threading
import time

from benchclub import paths, pinned
from benchclub.errors import HolaError

# provider → (OpenAI-compatible base URL, the environment variable its key is read from)
PROVIDERS = {
    "anthropic": ("https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"),
    "openai": ("https://api.openai.com/v1", "OPENAI_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"),
}
LABEL = "api"
STDERR_TAIL_CHARS = 4000
SLUG_RE = re.compile(r"[^a-z0-9.]+")


def runs_dir(env=None):
    """API references live apart from runs/, which holds only counted-run records."""
    return paths.home(env) / "api-runs"


def endpoint(provider=None, base_url=None, key_env=None):
    """(base URL, key variable) from a provider preset, an explicit base URL, or both (the URL wins)."""
    if provider is None and base_url is None:
        raise HolaError("api_endpoint_missing", "Say which API to test.",
                        f"Pass --provider ({', '.join(PROVIDERS)}) or --base-url for any OpenAI-compatible API.")
    preset_url, preset_key = PROVIDERS[provider] if provider else (None, None)
    key = key_env or preset_key
    if key is None:
        raise HolaError("api_key_env_missing", "Say which environment variable holds the API key.",
                        "Pass --api-key-env NAME with --base-url.")
    return base_url or preset_url, key


def run_api(model, *, provider=None, base_url=None, key_env=None, samples=None, env=None, on_event=None):
    env = os.environ if env is None else env
    base, key_name = endpoint(provider, base_url, key_env)
    key = env.get(key_name)
    if not key:
        raise HolaError("api_key_missing", f"{key_name} is not set.",
                        f"Export your API key as {key_name}, or name another variable with --api-key-env.")
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    run_dir = runs_dir(env) / f"{SLUG_RE.sub('-', model.lower()).strip('-')}-{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    args = [sys.executable, "-I", str(pinned.holaeval_path()), "bench", "--engine", "openai", "--base-url", base,
            "--model", model, "--pack", str(pinned.pack_path(pinned.DEFAULT_SUITE)), "--out", str(run_dir),
            "--label", LABEL]
    if samples:
        args += ["--samples", str(samples)]
    child_env = {**env, "HOLAEVAL_API_KEY": key, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(args, cwd=run_dir, env=child_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    stderr = []

    def drain():
        for chunk in proc.stderr:
            stderr.append(chunk)
            while sum(map(len, stderr)) > STDERR_TAIL_CHARS and len(stderr) > 1:
                stderr.pop(0)

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        for line in proc.stdout:
            line = line.strip()
            if on_event and line.startswith("{"):
                try:
                    on_event(json.loads(line))
                except ValueError:
                    pass
        code = proc.wait()
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait()
    reader.join(1)
    proc.stdout.close()
    proc.stderr.close()
    if code != 0:
        lines = "".join(stderr).strip().splitlines()
        reason = lines[-1] if lines else f"exited with code {code}"
        raise HolaError("api_run_failed", f"The API run stopped: {reason}",
                        "Check the model name and that the key is valid for this API.")
    record_path = run_dir / f"bench-{LABEL}.json"
    return {"run_dir": str(run_dir), "record_path": str(record_path),
            "record": json.loads(record_path.read_text(encoding="utf-8"))}


def cmd_api(args, out):
    from benchclub.cli import TASK_LABELS, emit_json

    def on_event(evt):
        if args.json:
            return
        if evt.get("event") == "start":
            out.line(f"{out.step} {args.model} {out.sep} {evt['suite']} {out.sep} API reference, speed not measured")
        elif evt.get("event") == "task_done" and evt.get("kind") == "task":
            label = TASK_LABELS.get(evt["task"], evt["task"])
            mark = out.ok if evt.get("passed") == evt.get("samples") else out.fail
            out.line(f"{mark} {label} {evt.get('passed', 0)}/{evt.get('samples', 0)}")

    result = run_api(args.model, provider=args.provider, base_url=args.base_url, key_env=args.api_key_env,
                     samples=args.samples, on_event=on_event)
    record = result["record"]
    tasks = [r for r in record["results"] if r["kind"] == "task"]
    passed, total = sum(r["passed"] for r in tasks), sum(r["samples"] for r in tasks)
    if args.json:
        emit_json({"ok": True, "model": args.model, "passed": passed, "samples": total, "reference_only": True,
                   "run_dir": result["run_dir"], "record_path": result["record_path"],
                   "tasks": {r["task"]: {"passed": r["passed"], "samples": r["samples"], "reasons": r["reasons"]}
                             for r in tasks}})
        return 0
    out.line()
    out.line(f"{passed}/{total} passed in {record['wall_seconds']:g} s. An API reference: it stays on this machine and "
             "isn't published.")
    out.line(f"Saved to {paths.display(result['record_path'])}")
    return 0


def add_commands(sub):
    p = sub.add_parser("api", help="test a hosted model through its OpenAI-compatible API (a reference, not published)")
    p.add_argument("model", help="the model as the API names it, e.g. claude-haiku-5-5")
    p.add_argument("--provider", choices=sorted(PROVIDERS), help="a known API; its key comes from "
                   + ", ".join(f"{k} ({v[1]})" for k, v in PROVIDERS.items()))
    p.add_argument("--base-url", help="any other OpenAI-compatible API, e.g. https://host/v1")
    p.add_argument("--api-key-env", metavar="NAME", help="the environment variable that holds the key")
    p.add_argument("--samples", type=int, help="attempts per task (default: the suite's 3)")
    p.add_argument("--json", action="store_true", help="print one JSON result instead of progress")
    p.set_defaults(fn=cmd_api)
