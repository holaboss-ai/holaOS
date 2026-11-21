"""`benchclub run-set`: a question set from BenchClub, answered by a model on this machine's own Ollama.

BenchClub hands over each question as the chat request its cloud would send; this asks the local model
with it and sends the reply back exactly as it came. BenchClub reads and judges every reply itself, so
nothing here grades or scores. The questions never touch disk; the answers go straight to BenchClub.
"""

import json
import os
import threading
import time
import urllib.error

from benchclub import __version__, account, hub, ollama
from benchclub.errors import HolaError

SIGN_IN = "Run `benchclub login`, then run this again."
ASK_TIMEOUT_S = 600
JUDGE_TIMEOUT_S = 300
JUDGE_RETRIES_S = (10, 30, 60)
HEARTBEAT_S = 15
BODY_MAX = 1024 * 1024


def _hub(method, path, body=None, token=None, timeout=account.TIMEOUT_S):
    """account._request with a longer wait: grading a short answer can take a judge a minute."""
    saved, account.TIMEOUT_S = account.TIMEOUT_S, timeout
    try:
        return account._request(method, path, body=body, token=token)
    finally:
        account.TIMEOUT_S = saved


def session_token():
    session = account.saved_session()
    if not session:
        raise HolaError("signed_out", "You're not signed in to BenchClub.", SIGN_IN)
    return session["token"]


def local_model(server, entry):
    """(name on this Ollama, digest) for the model BenchClub lists: its tag, or any local tag with the same bytes."""
    tag = entry["tag"]
    known = {str(entry.get("build_digest") or "").replace("sha256:", "")} - {""}
    models = server._tags()
    for m in models:
        if tag in (m.get("name"), m.get("model")):
            return m.get("name") or tag, m.get("digest")
    for m in models:
        if m.get("digest") in known:
            return m.get("name"), m.get("digest")
    return None, None


def ensure_model(server, entry, pull, out):
    name, digest = local_model(server, entry)
    if name:
        return name, digest
    tag = entry["tag"]
    if not pull:
        raise HolaError("model_missing", f"Your Ollama doesn't have {tag}.",
                        f"Run `ollama pull {tag}`, or run this again with --pull.")
    out.line(f"Downloading {tag}…")
    server.pull(tag)
    name, digest = local_model(server, entry)
    if not name:
        raise HolaError("model_missing", f"Ollama downloaded {tag} but doesn't list it.", "Run this again.")
    return name, digest


START_ERRORS = {
    "local_runs_off": ("Running sets on your own machine isn't open on BenchClub yet.", None),
    "set_not_found": ("BenchClub has no set by that id that you can run.",
                      "Copy the set's id from its page on BenchClub."),
    "model_not_registered": (None, "`benchclub list` shows the models you can run."),
    "model_digest_mismatch": (None, None),
    "daily_limit": (None, "Run it again tomorrow."),
    "active_limit": (None, None),
    "judge_unavailable": ("BenchClub can't grade short answers right now.", "Try again later."),
}


def start(token, body):
    status, reply = _hub("POST", "/v1/local/set-runs", body=body, token=token, timeout=120)
    reply = reply if isinstance(reply, dict) else {}
    if status == 201 and reply.get("job_id") and reply.get("token"):
        return reply
    if status == 401:
        raise HolaError("signed_out", "Your sign-in has expired or was signed out.", SIGN_IN)
    code = reply.get("code") or "start_failed"
    message, hint = START_ERRORS.get(code, (None, None))
    raise HolaError(code, message or reply.get("message") or f"BenchClub didn't start the run (HTTP {status}).",
                    hint or "Try again in a minute.")


def ask(base_url, request, timeout=ASK_TIMEOUT_S):
    """(status, body, error, seconds): the local model's reply as it came, or why there was none."""
    started = time.monotonic()
    try:
        with ollama.local_request(f"{base_url}/v1/chat/completions", request, timeout=timeout) as response:
            status, text, error = response.status, response.read(BODY_MAX).decode("utf-8", "replace"), None
    except urllib.error.HTTPError as exc:
        status, text, error = exc.code, exc.read(BODY_MAX).decode("utf-8", "replace"), None
    except (OSError, ValueError) as exc:
        status, text, error = None, "", str(getattr(exc, "reason", exc))[:300]
    return status, text, error, round(time.monotonic() - started, 1)


def send_answer(job_id, job_token, answer, sleep=None):
    """Sends one reply; a judge that failed gets it again a few times before the run gives up."""
    for wait in (*JUDGE_RETRIES_S, None):
        status, reply = _hub("POST", f"/v1/local/set-runs/{job_id}/answers", body=answer, token=job_token,
                             timeout=JUDGE_TIMEOUT_S)
        reply = reply if isinstance(reply, dict) else {}
        if status == 200:
            return reply
        if status == 401 or reply.get("code") == "job_not_active":
            raise HolaError("job_ended", "BenchClub ended this run.", "Start it again.")
        if wait is None or status not in (502, 503, 504):
            raise HolaError("answer_failed", f"BenchClub couldn't take an answer (HTTP {status}).",
                            "Run the set again.")
        (sleep or time.sleep)(wait)


def finish(job_id, job_token):
    status, reply = _hub("POST", f"/v1/local/set-runs/{job_id}/finish", token=job_token, timeout=120)
    reply = reply if isinstance(reply, dict) else {}
    if status == 200:
        return reply
    raise HolaError("finish_failed", reply.get("message") or f"BenchClub couldn't finish the run (HTTP {status}).",
                    "Run the set again.")


def abort(job_id, job_token, reason):
    try:
        _hub("POST", f"/runner/v1/jobs/{job_id}/abort", body={"step": "tasks", "reason": reason}, token=job_token)
    except HolaError:
        pass


class Lease:
    """Heartbeats in the background; `cancelled` turns true when BenchClub says the run is over."""

    def __init__(self, job_id, job_token, interval=HEARTBEAT_S):
        self.job_id, self.job_token, self.interval = job_id, job_token, interval
        self.stop = threading.Event()
        self.cancelled = False
        self.thread = threading.Thread(target=self._beat, daemon=True)

    def _beat(self):
        while not self.stop.wait(self.interval):
            try:
                _status, reply = _hub("POST", f"/runner/v1/jobs/{self.job_id}/heartbeat", body={},
                                      token=self.job_token)
            except HolaError:
                continue
            if isinstance(reply, dict) and reply.get("cancel") is True:
                self.cancelled = True
                return

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.stop.set()


def mark(result):
    if result.get("status") != "graded":
        return {"unsupported": "–", "truncated": "…", "error": "!"}.get(result.get("status"), "?")
    score = result.get("score")
    return "✓" if score == 1 else "✗" if score == 0 else f"{score:.2f}"


def run_set(set_id, model, *, version=None, pull=False, out, env=None, emit=None):
    env = os.environ if env is None else env
    token = session_token()
    entries, source = hub.fetch_subjects_index(env)
    if source != "hub":
        raise HolaError("offline", "Couldn't reach BenchClub.", "Check your connection, then run this again.")
    entry = hub.resolve(model, entries)
    server = ollama.ExternalOllama(ollama.user_base_url(env))
    engine_version = server.start()
    name, digest = ensure_model(server, entry, pull, out)
    job = start(token, {
        "set": set_id,
        **({"version": version} if version else {}),
        "model": {"tag": entry["tag"], "digest": digest},
        "engine": {"name": "ollama", "version": engine_version},
        "hardware": account.machine_report(),
        "client": {"name": "benchclub", "version": __version__},
    })
    job_id, job_token, questions = job["job_id"], job["token"], job["questions"]
    out.line(f"{job['set']['title']} v{job['set']['version']} on {job['model']['name']} ({name}), "
             f"{len(questions)} questions.")
    out.line(f"Watch it on BenchClub: {job['watch_url']}")
    stopped = "client_failed"
    try:
        with Lease(job_id, job_token) as lease:
            for i, q in enumerate(questions, 1):
                if lease.cancelled:
                    raise HolaError("job_ended", "BenchClub ended this run.", "Start it again.")
                status, text, error, seconds = ask(server.base_url, {**q["request"], "model": name})
                result = send_answer(job_id, job_token, {
                    "id": q["id"], "status": status, "body": text, "error": error, "seconds": seconds})
                out.line(f"{i:>3}/{len(questions)}  {mark(result):>4}  {q['id']}  {seconds:g}s")
                if emit:
                    emit({"event": "answer", "index": i, **result, "seconds": seconds})
            done = finish(job_id, job_token)
            stopped = None
    except KeyboardInterrupt:
        stopped = "user_stopped"
        raise
    finally:
        if stopped:
            abort(job_id, job_token, stopped)
    return done


def summary_lines(done, out):
    s = done.get("summary") or {}
    choice, short = s.get("choice") or {}, s.get("short") or {}
    if choice.get("total"):
        out.line(f"Multiple choice: {choice['right']}/{choice['total']} right")
    if short.get("total"):
        out.line(f"Short answers: {round((short.get('mean') or 0) * 100)}% of rubric points over {short['total']}")
    left = [f"{s[k]} {k}" for k in ("unsupported", "truncated", "errors") if s.get(k)]
    if left:
        out.line(f"Not scored: {', '.join(left)}")
    out.line(f"Result: {done.get('url')}")


def cmd_run_set(args, out):
    emit = (lambda value: print(json.dumps(value), flush=True)) if args.json else None
    done = run_set(args.set, args.model, version=args.version, pull=args.pull, out=out if not args.json else _Quiet(),
                   emit=emit)
    if args.json:
        print(json.dumps({"ok": True, **done}))
    else:
        summary_lines(done, out)
    return 0


class _Quiet:
    def line(self, *_args, **_kwargs):
        pass


def add_commands(sub):
    p = sub.add_parser("run-set", help="answer a BenchClub question set with a model on your own Ollama")
    p.add_argument("set", help="the set's id, from its page on BenchClub")
    p.add_argument("--model", required=True, help="a model from `benchclub list`, e.g. qwen3.5:2b")
    p.add_argument("--version", help="a version of the set; the newest when left out")
    p.add_argument("--pull", action="store_true", help="download the model into your Ollama if it isn't there")
    p.add_argument("--json", action="store_true", help="print one JSON line per answer and one for the result")
    p.set_defaults(fn=cmd_run_set)
