"""One benchmark run, in the desktop's order: a port of BenchRunner.execute in runtime/api-server/src/bench-runner.ts."""

import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from hola import __version__, machine, ollama, paths, pinned, runs
from hola.errors import HolaError
from hola.record import (SubjectError, bench_highlights, build_run_record, dumps, min_ollama_version,
                         parse_bench_subject)

BENCH_LABEL = "main"
STDERR_TAIL_CHARS = 4000
CLIENT = {"app": "hola-cli", "version": __version__}


class Run:
    def __init__(self, subject, suite, runs_root):
        self.run_id = str(uuid.uuid4())
        self.run_dir = Path(runs_root) / self.run_id
        self.subject = subject
        self.suite = suite
        self.events = []

    def emit(self, event_type, fields=None):
        """The desktop's event shape, so events.jsonl and the highlights come out the same."""
        event = {**(fields or {}), "seq": len(self.events) + 1, "at": int(time.time() * 1000), "type": event_type}
        self.events.append(event)
        return event

    def write_events(self):
        lines = "".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n" for e in self.events)
        (self.run_dir / "events.jsonl").write_text(lines, encoding="utf-8")


def _quiet(_kind, _data):
    pass


def run_eval(subject_raw, *, suite=pinned.DEFAULT_SUITE, ollama_url=None, keep_model=False, unload=None,
             ignore_memory=False, ui=_quiet, confirm=lambda models: False, env=None, runs_root=None, state_dir=None,
             find_binary=ollama.find_binary, port=None, user_url=None, cpu_busy=machine.measure_cpu_busy,
             hardware=machine.machine_info):
    """Runs the suite and saves the Run Record; returns the result `hola eval --json` prints."""
    env = dict(os.environ if env is None else env)
    try:
        subject = parse_bench_subject(subject_raw)
    except SubjectError as exc:
        raise HolaError("invalid_subject", f"This model's config is incomplete: {exc}.",
                        "Run `hola list` and pick a model from there.") from None
    if suite not in pinned.SUPPORTED_SUITES:
        raise HolaError("unknown_suite", f"hola {__version__} runs {', '.join(pinned.SUPPORTED_SUITES)} only, not {suite}.",
                        "Leave out --suite to run the standard suite.")
    pack_path = pinned.pack_path(suite)
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    run = Run(subject, suite, runs_root or paths.runs_dir(env))
    run.run_dir.mkdir(parents=True, exist_ok=True)
    (run.run_dir / "subject.json").write_text(dumps(subject), encoding="utf-8")
    run.emit("run_started", {"suite": suite, "subject_id": subject["id"]})
    tag = subject["ollama"]["tag"]
    threshold = pinned.conditions()["busy_cpu_pct"]
    instance = None
    status = "running"
    try:
        binary = None
        if not ollama_url:
            binary = find_binary(env=env)
            if not binary:
                raise HolaError("ollama_missing", "Ollama is not installed.",
                                f"Install it from {ollama.OLLAMA_DOWNLOAD_URL}, then run this again.",
                                {"download_url": ollama.OLLAMA_DOWNLOAD_URL})
        hw = hardware()
        short = machine.memory_shortfall(subject, hw)
        if short and not ignore_memory:
            gpu = f" and {short['gpu_memory_gb']:g} GB on GPUs" if short["gpu_memory_gb"] else ""
            raise HolaError("not_enough_memory",
                            f"{subject['name']} {subject['quant']} needs {short['min_memory_gb']} GB of memory or more; "
                            f"this machine has {short['memory_gb']} GB{gpu}.",
                            "Pick a smaller model from `hola list`, or run it anyway with --ignore-memory.", short)

        if not ollama_url:
            user_url = user_url or ollama.user_base_url(env)
            loaded = ollama.user_loaded_models(user_url)
            if loaded:
                if not (unload if unload is not None else confirm(loaded)):
                    names = ", ".join(m["name"] for m in loaded)
                    raise HolaError("user_models_loaded",
                                    f"Your own Ollama has models in memory ({names}). They would slow the benchmark down.",
                                    "Run again with --unload to unload them first.", {"models": loaded})
                for model in loaded:
                    try:
                        ollama.unload_user_model(model["name"], user_url)
                    except OSError as exc:
                        raise HolaError("user_models_loaded", f"Couldn't unload {model['name']} from your own Ollama: {exc}.",
                                        f"Unload it yourself with `ollama stop {model['name']}`, then run this again.",
                                        {"models": loaded}) from None
                run.emit("user_models_unloaded", {"models": [m["name"] for m in loaded]})
                ui("user_models_unloaded", {"models": [m["name"] for m in loaded]})

        cpu = cpu_busy()
        if cpu is not None and cpu >= threshold:
            run.emit("machine_busy", {"cpu_busy_pct": cpu})
        ui("machine", {"summary": machine.summary(hw), "cpu_busy_pct": cpu,
                       "busy": cpu is not None and cpu >= threshold})

        if ollama_url:
            instance = ollama.ExternalOllama(ollama_url)
        else:
            state = Path(state_dir) if state_dir else paths.state_dir(env)
            ollama.cleanup_orphan(state)
            instance = ollama.OllamaInstance(binary, state, port or ollama.default_port(env), env=env,
                                             log_path=run.run_dir / "ollama.log")
        run.emit("phase", {"phase": "starting"})
        version = instance.start()
        run.emit("engine_ready", {"engine": "ollama", "version": version})
        ui("ollama", {"version": version, "base_url": instance.base_url, "managed": not ollama_url})
        floor = min_ollama_version(pack.get("min_ollama_version"), subject, ollama.compare_versions)
        if floor:
            instance.assert_min_version(floor)

        run.emit("phase", {"phase": "pulling"})
        had_model = instance.has_model(tag)

        def on_pull(progress):
            run.emit("pull_progress", dict(progress))
            ui("pull", progress)

        instance.pull(tag, on_pull)
        digest = instance.digest(tag)
        registered = digest is not None and digest in (subject["ollama"].get("known_digests") or [])
        ui("model", {"name": subject["name"], "quant": subject["quant"], "tag": tag, "digest": digest,
                     "registered": registered, "download_bytes": subject.get("download_bytes")})

        run.emit("phase", {"phase": "running"})
        bench = run_holaeval(run, instance, pack_path, env, ui)

        run.emit("phase", {"phase": "finishing"})
        record = build_run_record(
            run_id=run.run_id, bench=bench, subject=subject, digest=digest, evidence=instance.evidence(),
            client=dict(CLIENT), artifacts={"recording": None, "cards": [], "highlights": bench_highlights(run.events)},
            conditions={"cpu_busy_pct": cpu})
        record_path = run.run_dir / "run-record.json"
        record_path.write_text(dumps(record), encoding="utf-8")
        if not had_model and not keep_model:
            instance.delete(tag)
            run.emit("model_removed", {"tag": tag})
            ui("model_removed", {"tag": tag})
        status = "done"
        summary = runs.summarize(run.run_dir, record)
        return {"ok": True, "run_id": run.run_id, "run_dir": str(run.run_dir), "record_path": str(record_path),
                "suite": suite, "subject": {"id": subject["id"], "name": subject["name"], "quant": subject["quant"],
                                            "tag": tag, "digest": digest, "digest_registered": registered},
                "summary": {k: summary[k] for k in ("decode_tps", "decode_tps_8k", "ttft_ms", "cpu_offload",
                                                     "vram_bytes", "tasks")},
                "conditions": record["runtime"]["conditions"], "publishable": not summary["publish_blockers"],
                "publish_blockers": summary["publish_blockers"]}
    except KeyboardInterrupt:
        status = "cancelled"
        raise HolaError("cancelled", "Stopped. The private Ollama instance is shut down and the run was not saved.",
                        None, {"run_id": run.run_id}) from None
    except HolaError as exc:
        status = "failed"
        exc.details.setdefault("run_id", run.run_id)
        raise
    finally:
        if instance is not None:
            instance.stop()
        run.emit("run_finished", {"status": status})
        run.write_events()


def _loopback_no_proxy(env):
    entries = [e for e in (env.get("NO_PROXY") or env.get("no_proxy") or "").split(",") if e.strip()]
    value = ",".join(dict.fromkeys([*entries, "127.0.0.1", "localhost"]))
    return {"NO_PROXY": value, "no_proxy": value}


def run_holaeval(run, instance, pack_path, env, ui):
    """`holaeval.py bench` with the desktop's arguments; its event lines become this run's events."""
    args = [sys.executable, "-I", str(pinned.holaeval_path()), "bench", "--base-url", instance.base_url,
            "--model", run.subject["ollama"]["tag"], "--pack", str(pack_path), "--subject",
            str(run.run_dir / "subject.json"), "--out", str(run.run_dir), "--label", BENCH_LABEL]
    if instance.pid:
        args += ["--ollama-pid", str(instance.pid)]
    child_env = {**env, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", **_loopback_no_proxy(env)}
    proc = subprocess.Popen(args, cwd=run.run_dir, env=child_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
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
            if not line.startswith("{"):
                continue
            try:
                fields = json.loads(line)
            except ValueError:
                continue
            event_type = fields.pop("event", None)
            fields.pop("t", None)
            if isinstance(event_type, str):
                ui("event", run.emit(event_type, fields))
        code = proc.wait()
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
    reader.join(1)
    proc.stdout.close()
    proc.stderr.close()
    if code != 0:
        lines = "".join(stderr).strip().splitlines()
        raise HolaError("bench_failed", f"The benchmark stopped: {lines[-1] if lines else f'exited with code {code}'}",
                        f"The run's files are in {paths.display(run.run_dir)}. Run it again; if it keeps failing, "
                        "`hola doctor` checks your setup.")
    return json.loads((run.run_dir / f"bench-{BENCH_LABEL}.json").read_text(encoding="utf-8"))
