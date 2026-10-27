"""The `hola` command: argparse front end, human output and --json output."""

import argparse
import ipaddress
import json
import os
import platform
import shutil
import signal
import socket
import sys
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path

from hola import __version__, bench, hub, machine, ollama, paths, pinned, runs
from hola.errors import HolaError

try:
    from hola import account
except ImportError:
    account = None

TASK_LABELS = {"code-intervals": "code", "tool-flight": "tool call", "needle-8k": "8K recall"}
SPEED_LABELS = {"speed@0": "generation", "speed@8k": "generation with 8K context"}
LOW_DISK_GB = 10
FAKE_IP_NET = ipaddress.ip_network("198.18.0.0/15")
FAKE_IP_NEXT_STEP = ollama.FAKE_IP_NEXT_STEP
EXIT_CANCELLED = 130


class Out:
    """Terminal output that degrades to ASCII where the console can't print the symbols."""

    def __init__(self, stream=None):
        self.stream = stream or sys.stdout
        self.tty = self.stream.isatty()
        try:
            "✓▸✗●○·…".encode(getattr(self.stream, "encoding", None) or "ascii")
            fancy = True
        except (UnicodeEncodeError, LookupError):
            fancy = False
        self.ok, self.step, self.fail, self.warn_mark = ("✓", "▸", "✗", "!") if fancy else ("ok", ">", "x", "!")
        self.passed, self.missed, self.sep, self.ell = ("●", "○", "·", "…") if fancy else ("+", "-", "|", "...")

    def line(self, text="", indent=2):
        print(" " * indent + text if text else "", file=self.stream, flush=True)

    def good(self, text):
        self.line(f"{self.ok} {text}")

    def warn(self, text, next_step=None):
        self.line(f"{self.warn_mark} {text}")
        if next_step:
            self.line(next_step, indent=4)

    def error(self, err):
        self.line(f"{self.fail} {err.message}")
        if err.next_step:
            self.line(err.next_step, indent=4)


def gb(n):
    return f"{n / 2**30:.1f} GB" if n else "–"


class EvalView(Out):
    """Renders a run's progress as it happens: one line per step, completed in place on a terminal."""

    def __init__(self, subject, stream=None):
        super().__init__(stream)
        self.subject = subject
        self.pending = None
        self.downloading = False
        self.last_pull = 0.0

    def begin(self, text):
        self.end_pending()
        self.pending = "  " + text
        if self.tty:
            self.stream.write(self.pending)
            self.stream.flush()

    def add(self, text):
        if self.pending is None:
            return
        self.pending += text
        if self.tty:
            self.stream.write(text)
            self.stream.flush()

    def finish(self, text=""):
        if self.pending is None:
            return
        line, self.pending = self.pending + text, None
        self.stream.write((text if self.tty else line) + "\n")
        self.stream.flush()

    def end_pending(self):
        if self.pending is not None:
            self.finish()

    def __call__(self, kind, data):
        handler = getattr(self, "on_" + kind, None)
        if handler:
            handler(data)

    def on_machine(self, d):
        load = f"background load {d['cpu_busy_pct']}%" if d["cpu_busy_pct"] is not None else "background load unknown"
        self.good(f"{d['summary']} {self.sep} {load}")
        if d["busy"]:
            self.warn(f"Other apps are using {d['cpu_busy_pct']}% of the CPU, so these numbers may read low.",
                      "The run records this. Close other apps for a clean run.")

    def on_user_models_unloaded(self, d):
        self.good(f"Unloaded {', '.join(d['models'])} from your own Ollama")

    def on_leftover_stopped(self, _d):
        self.good("Stopped a benchmark Ollama left over from an earlier run")

    def on_ollama(self, d):
        if d["managed"]:
            self.good(f"Ollama {d['version']} {self.sep} private instance on {d['base_url'].split('//')[1]}")
        else:
            self.warn(f"Ollama {d['version']} at {d['base_url']} {self.sep} your own server, so this run stays local")

    def on_pull(self, p):
        total, done = p.get("total"), p.get("completed")
        if total and done is not None and done < total and total > 1 << 20:
            if not self.downloading:
                self.downloading = True
                self.begin(f"{self.step} downloading {self.subject['name']} {self.subject['quant']} ")
            if self.tty and (done - self.last_pull > total / 200 or done == total):
                self.last_pull = done
                self.stream.write(f"\r  {self.step} downloading {self.subject['name']} {self.subject['quant']}  "
                                  f"{gb(done)} of {gb(total)}  {done * 100 // total}%   ")
                self.stream.flush()
        if p.get("status") == "success" and self.downloading:
            self.finish("" if self.tty else f"{self.ell} done")

    def on_model(self, d):
        size = f" {self.sep} {gb(d['download_bytes'])}" if d.get("download_bytes") else ""
        if d["registered"]:
            self.good(f"{d['name']} {d['quant']}{size} {self.sep} digest verified")
        else:
            self.warn(f"{d['name']} {d['quant']}{size} {self.sep} unverified build ({(d['digest'] or 'no digest')[:12]})",
                      "HolaHub hasn't registered this build, so the run will stay on this machine.")

    def on_model_kept(self, d):
        self.warn(f"Couldn't remove {d['tag']}, which this run downloaded.", f"Remove it yourself with `ollama rm {d['tag']}`.")

    def on_model_removed(self, d):
        self.good(f"Removed {d['tag']}, downloaded for this run (keep it next time with --keep-model)")

    def on_event(self, e):
        kind, task = e.get("type"), e.get("task")
        if kind == "task_start" and task == "warmup":
            self.begin(f"{self.step} warming up {self.ell}")
        elif kind == "task_done" and task == "warmup":
            self.finish(" done")
        elif kind == "task_start" and e.get("kind") == "speed":
            self.begin(f"{self.step} {SPEED_LABELS.get(task, task)} {self.ell}")
        elif kind == "task_done" and e.get("kind") == "speed":
            self.finish(f" {e['decode_tps']} tok/s" if e.get("decode_tps") is not None else " no reading")
        elif kind == "task_start" and e.get("kind") == "task":
            self.begin(f"{self.step} {TASK_LABELS.get(task, task)} ")
        elif kind == "sample_done":
            self.add(self.passed if e.get("passed") else self.missed)
        elif kind == "task_done" and e.get("kind") == "task":
            self.finish(" not supported by this model" if e.get("status") == "unsupported"
                        else f"  {e.get('passed')}/{e.get('samples')}")


def summary_lines(result, out):
    s = result["summary"]
    lines = []
    deep = f"  (8K context: {s['decode_tps_8k']})" if s.get("decode_tps_8k") is not None else ""
    lines.append(f"generation   {s['decode_tps'] if s.get('decode_tps') is not None else '–'} tok/s{deep}")
    if s.get("ttft_ms") is not None:
        lines.append(f"first token  {s['ttft_ms']:g} ms")
    tasks = [f"{TASK_LABELS.get(t, t)} " + ("not supported" if v["status"] == "unsupported" else f"{v['passed']}/{v['samples']}")
             for t, v in s["tasks"].items()]
    if tasks:
        lines.append(f" {out.sep} ".join(tasks))
    if s.get("vram_bytes"):
        lines.append(f"memory       {gb(s['vram_bytes'])}" + (f" {out.sep} partly on CPU" if s.get("cpu_offload") else " on GPU"))
    return lines


def print_eval_result(result, versions, out):
    out.line()
    for line in summary_lines(result, out):
        out.line(line, indent=4)
    out.line()
    out.line(f"Saved {paths.display(result['record_path'])}")
    if result["publishable"]:
        if account is not None:
            out.line(f"Publish it: hola publish {result['run_id'][:8]}   (sign in first: hola login)")
    else:
        out.line(f"This run stays on this machine: {'; '.join(result['publish_blockers'])}.")
    if versions and versions["behind"]:
        out.warn(f"hola {versions['latest']} is out (you have {versions['current']}).",
                 "Update with the tool you installed it with, e.g. `pipx upgrade hola-cli` or `uvx hola-cli@latest`.")


def background(fn):
    box = {}
    thread = threading.Thread(target=lambda: box.update(value=fn()), daemon=True)
    thread.start()
    return lambda: (thread.join(6), box.get("value"))[1]


def cmd_eval(args, out):
    versions = background(lambda: hub.version_status(hub.fetch_cli_policy()))
    entries, _source = hub.fetch_subjects_index()
    entry = hub.resolve(args.subject, entries)
    config, config_source = hub.fetch_subject(entry["id"])
    view = EvalView(config, out.stream)
    if not args.json and config_source == "bundled":
        view.warn("HolaHub's config for this model couldn't be loaded, so this uses the one bundled with hola.")

    def confirm(models):
        if args.json or not sys.stdin.isatty():
            return False
        names = ", ".join(f"{m['name']} ({gb(m['size_vram'])})" if m.get("size_vram") else m["name"] for m in models)
        view.warn(f"Your own Ollama has {names} in memory, which would slow the benchmark down.")
        try:
            return input("    Unload now? [y/N] ").strip().lower() in ("y", "yes")
        except EOFError:
            return False

    try:
        result = bench.run_eval(config, suite=args.suite, ollama_url=args.ollama_url, keep_model=args.keep_model,
                                unload=True if args.unload else None, ignore_memory=args.ignore_memory,
                                ui=(lambda kind, data: None) if args.json else view, confirm=confirm)
    finally:
        view.end_pending()
    status = versions()
    if args.json:
        emit_json({**result, "config_source": config_source, "hola": status})
    else:
        print_eval_result(result, status, out)
    return 0


def cmd_list(args, out):
    entries, source = hub.fetch_subjects_index()
    if args.json:
        emit_json({"ok": True, "source": source, "subjects": entries})
        return 0
    if source == "bundled":
        out.warn("HolaHub's model list couldn't be loaded; these are the models bundled with hola.")
    rows = [("Model", "Quant", "Download", "Memory", "Suites", "Run it with")]
    for e in entries:
        short = min([e["id"], *[a for a in e["aliases"] if ":" not in a]], key=len)
        rows.append((e["name"] or e["id"], e["quant"] or "", gb(e["download_bytes"]),
                     f"{e['min_memory_gb']} GB" if e.get("min_memory_gb") else "–", ", ".join(e["suites"]),
                     f"hola eval {short}"))
    table(rows, out)
    return 0


def table(rows, out):
    widths = [max(len(str(r[i])) for r in rows) for i in range(len(rows[0]))]
    for row in rows:
        out.line("  ".join(str(cell).ljust(w) for cell, w in zip(row, widths)).rstrip())


def cmd_runs(args, out):
    found = runs.list_runs()
    if args.json:
        emit_json({"ok": True, "runs": found})
        return 0
    if not found:
        out.line("No runs yet. Start one: hola eval <model>   (models: hola list)")
        return 0
    rows = [("Run", "Model", "Quant", "When", "Speed", "Published")]
    for r in found:
        when = r["started_at"] or ""
        try:
            when = datetime.fromisoformat(when.replace("Z", "+00:00")).astimezone().strftime("%b %d %H:%M")
        except ValueError:
            pass
        speed = f"{r['decode_tps']} tok/s" if r["decode_tps"] is not None else "–"
        published = (r["published"] or {}).get("url") or ("no" if not r["publish_blockers"] else "local only")
        rows.append((r["run_id"][:8], r["subject_name"] or r["subject_id"], r["quant"] or "", when, speed, published))
    table(rows, out)
    return 0


def check(checks, id, status, message, next_step=None):
    checks.append({"id": id, "status": status, "message": message, "next_step": next_step})


def fake_ip_addresses(host="registry.ollama.ai"):
    """The addresses a proxy in fake-ip mode hands out for the model registry (198.18.0.0/15), or None if unresolvable."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return None
    addresses = {info[4][0].split("%")[0] for info in infos}
    return sorted(a for a in addresses if ipaddress.ip_address(a) in FAKE_IP_NET)


def doctor_checks(env=None):
    env = os.environ if env is None else env
    checks = []
    ok_python = sys.version_info >= (3, 10)
    check(checks, "python", "ok" if ok_python else "fail", f"Python {platform.python_version()}",
          None if ok_python else "hola needs Python 3.10 or newer.")

    binary = ollama.find_binary(env=env)
    if not binary:
        check(checks, "ollama", "fail", "Ollama is not installed.", f"Install it from {ollama.OLLAMA_DOWNLOAD_URL}.")
    else:
        version = ollama.binary_version(binary)
        check(checks, "ollama", "ok" if version else "warn",
              f"Ollama {version or '(version unknown)'} at {paths.display(binary)}",
              None if version else "`ollama --version` didn't answer; reinstall Ollama if runs fail to start.")

    models_dir = Path(ollama.default_models_dir(env))
    probe = next((p for p in (models_dir, *models_dir.parents) if p.exists()), Path.home())
    free_gb = shutil.disk_usage(probe).free / 2**30
    check(checks, "models_dir", "ok" if free_gb >= LOW_DISK_GB else "warn",
          f"Models in {paths.display(models_dir)} {'' if models_dir.exists() else '(not created yet) '}· {free_gb:.0f} GB free",
          None if free_gb >= LOW_DISK_GB else "Free some disk space; a model downloads 1.5 to 24 GB.")
    system_models = Path("/usr/share/ollama/.ollama/models")
    if sys.platform.startswith("linux") and system_models.is_dir() and system_models != models_dir:
        check(checks, "models_dir_shared", "warn",
              f"Your Ollama service keeps models in {system_models}; hola's private instance uses {paths.display(models_dir)}.",
              f"To share downloads, set OLLAMA_MODELS={system_models} (your user needs write access to it).")

    hw = machine.machine_info()
    free = machine.free_memory_gb()
    gpus = hw.get("gpus") or []
    memory = f" {chr(183)} {free:g} GB free now" if free is not None else ""
    check(checks, "machine", "ok", f"{machine.summary(hw)}{memory}")
    if sys.platform.startswith("linux") and not gpus:
        check(checks, "gpu", "warn", "No GPU found (nvidia-smi and rocm-smi are absent or failed); runs will use the CPU.",
              "Install your GPU driver's tools if this machine has a GPU.")
    elif gpus:
        check(checks, "gpu", "ok", f"{len(gpus)} GPU{'s' if len(gpus) > 1 else ''}: {'; '.join(gpus)}")

    loaded = ollama.user_loaded_models(ollama.user_base_url(env))
    if loaded:
        check(checks, "user_models", "warn", f"Your own Ollama has {', '.join(m['name'] for m in loaded)} in memory.",
              "`hola eval` offers to unload them, or pass --unload.")

    port = ollama.default_port(env)
    if ollama.server_version(f"http://127.0.0.1:{port}") is not None:
        check(checks, "port", "warn", f"An Ollama is already answering on port {port}, probably another benchmark.",
              "Wait for it to finish before starting a run.")
    elif not ollama.port_bindable(port):
        check(checks, "port", "warn", f"Port {port} is in use by another program.", "Set HOLA_OLLAMA_PORT to a free port.")
    else:
        check(checks, "port", "ok", f"Port {port} is free for the private instance")

    busy = machine.measure_cpu_busy()
    if busy is not None:
        threshold = pinned.conditions()["busy_cpu_pct"]
        check(checks, "load", "ok" if busy < threshold else "warn", f"Background load {busy}%",
              None if busy < threshold else "A run started now records this and its numbers may read low. Close other apps first.")

    proxy = next((env[k] for k in ("HTTPS_PROXY", "https_proxy") if env.get(k)), None) or ollama.system_https_proxy()
    fake = fake_ip_addresses()
    if fake is None:
        check(checks, "network", "warn", "registry.ollama.ai doesn't resolve; this machine looks offline.",
              "Runs of models you already have still work. Downloads need a connection.")
    elif fake and not proxy:
        check(checks, "network", "warn", f"registry.ollama.ai resolves to {fake[0]}, a fake-ip proxy address, and no HTTPS proxy is set.",
              FAKE_IP_NEXT_STEP)
    else:
        via = f" through {proxy}" if proxy else ""
        check(checks, "network", "ok", f"Model downloads go{via or ' direct'}")

    entries, source = hub.fetch_subjects_index(env)
    check(checks, "holahub", "ok" if source == "hub" else "warn",
          f"HolaHub lists {len(entries)} models" if source == "hub"
          else f"HolaHub's model list couldn't be loaded; hola falls back to its {len(entries)} bundled models",
          None if source == "hub" else "Check your connection; publishing needs HolaHub.")
    status = hub.version_status(hub.fetch_cli_policy(env))
    if status["latest"] is None:
        check(checks, "version", "ok", f"hola {__version__}")
    elif status["can_publish"] is False:
        check(checks, "version", "fail", f"hola {__version__} is below the oldest version HolaHub accepts runs from.",
              "Update hola before you publish.")
    else:
        check(checks, "version", "warn" if status["behind"] else "ok",
              f"hola {__version__}" + (f"; {status['latest']} is out" if status["behind"] else " is current"),
              "Update with the tool you installed it with." if status["behind"] else None)

    engine = machine.engine()
    check(checks, "engine", "ok", f"Engine holaeval@{engine.HOLAEVAL_VERSION} {chr(183)} "
                                  f"sha256 {pinned.manifest()['files']['holaeval.py'][:12]}")
    return checks


def cmd_doctor(args, out):
    checks = doctor_checks()
    failed = sum(c["status"] == "fail" for c in checks)
    if args.json:
        emit_json({"ok": not failed, "checks": checks})
        return 1 if failed else 0
    marks = {"ok": out.ok, "warn": out.warn_mark, "fail": out.fail}
    for c in checks:
        out.line(f"{marks[c['status']]} {c['message']}")
        if c["next_step"]:
            out.line(c["next_step"], indent=4)
    warned = sum(c["status"] == "warn" for c in checks)
    out.line()
    out.line("Ready to run." if not failed and not warned else
             f"{failed} problem{'s' * (failed != 1)}, {warned} warning{'s' * (warned != 1)}.")
    return 1 if failed else 0


def emit_json(value):
    print(json.dumps(value, indent=2, ensure_ascii=False), flush=True)


def parser():
    ap = argparse.ArgumentParser(prog="hola", description="Benchmark a local model the way holaOS does.")
    ap.add_argument("--version", action="version", version=f"hola {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True, metavar="command")
    p = sub.add_parser("eval", help="benchmark a model and save the run")
    p.add_argument("subject", help="a model id or alias from `hola list`, e.g. minicpm5-2b")
    p.add_argument("--suite", default=pinned.DEFAULT_SUITE)
    p.add_argument("--json", action="store_true", help="print one JSON result instead of progress")
    p.add_argument("--ollama-url", help="run on your own Ollama server (the run stays local)")
    p.add_argument("--keep-model", action="store_true", help="keep a model this run downloaded")
    p.add_argument("--unload", action="store_true", help="unload models your own Ollama holds in memory")
    p.add_argument("--ignore-memory", action="store_true", help="run even if the model needs more memory than this machine has")
    p.set_defaults(fn=cmd_eval)
    for name, fn, help_text in (("list", cmd_list, "models you can test"), ("runs", cmd_runs, "runs saved on this machine"),
                                ("doctor", cmd_doctor, "check this machine's setup")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--json", action="store_true")
        p.set_defaults(fn=fn)
    if account is not None:
        account.add_commands(sub)
    return ap


def log_unexpected():
    """Appends the current traceback to hola.log and returns its path."""
    path = paths.log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as log:
            log.write(f"--- {datetime.now(timezone.utc).isoformat()} hola {__version__} {' '.join(sys.argv[1:])}\n")
            log.write(traceback.format_exc())
    except OSError:
        pass
    return path


def _interrupt(_signum, _frame):
    raise KeyboardInterrupt


def main(argv=None):
    args = parser().parse_args(argv)
    for name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), _interrupt)
    out = Out()
    try:
        return args.fn(args, out)
    except KeyboardInterrupt:
        err = HolaError("cancelled", "Stopped.")
    except HolaError as exc:
        err = exc
    except Exception as exc:
        err = HolaError("unexpected", f"Unexpected error: {type(exc).__name__}: {exc}",
                        f"Details are in {paths.display(log_unexpected())}.")
    if getattr(args, "json", False):
        emit_json({"ok": False, "error": err.to_json()})
    else:
        out.error(err)
    return EXIT_CANCELLED if err.code == "cancelled" else 1
