#!/usr/bin/env python3
"""Runs on a spike pod. `gpu SUBJECT` checks that Ollama runs the model on the GPU, and how fast;
`rounds SUBJECT SUITE N` runs `benchclub eval` N times. Results land in /root/results as soon as they exist."""

import json
import os
import pathlib
import shutil
import signal
import statistics
import subprocess
import sys
import time
import urllib.request

from benchclub import pinned

RESULTS = pathlib.Path("/root/results")
PORT = 11532
ROUND_TIMEOUTS = {"suite-standard@1.0": 30 * 60, "suite-coding@1.0": 3 * 60 * 60}
# Far below any GPU: a round this slow is measuring a broken setup, so the rest are skipped.
SLOWEST_DECODE_TPS = 5


def tag_of(subject):
    return next(s["ollama"]["tag"] for s in pinned.bundled_subjects() if s["id"] == subject)


def call(path, payload=None, timeout=60):
    data = None if payload is None else json.dumps(payload).encode()
    with urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data), timeout=timeout) as r:
        return json.load(r)


def write(name, data):
    tmp = RESULTS / f".{name}.tmp"
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    tmp.replace(RESULTS / name)


def read(path):
    try:
        return pathlib.Path(path).read_text().strip()
    except OSError:
        return None


class Ollama:
    """A private `ollama serve` with the bench's conditions, for the pull and the GPU check."""

    def __enter__(self):
        self.env = {**os.environ, **pinned.conditions()["ollama_env"], "OLLAMA_HOST": f"127.0.0.1:{PORT}"}
        self.log = open(RESULTS / "ollama.log", "a")
        self.proc = subprocess.Popen(["ollama", "serve"], env=self.env, stdout=self.log, stderr=self.log)
        for _ in range(60):
            try:
                call("/api/version", timeout=2)
                return self
            except OSError:
                time.sleep(0.5)
        raise TimeoutError("ollama serve did not come up")

    def __exit__(self, *_):
        self.proc.terminate()
        self.proc.wait()
        self.log.close()

    def pull(self, tag):
        started = time.time()
        subprocess.run(["ollama", "pull", tag], env=self.env, check=True, capture_output=True)
        return round(time.time() - started, 1)


def decode_tps(tag, threads=None):
    options = {"num_ctx": 16384, "num_predict": 128, "temperature": 0}
    if threads:
        options["num_thread"] = threads
    r = call("/api/generate", {"model": tag, "prompt": "Count from 1 to 100.", "stream": False, "keep_alive": "10m",
                               "options": options}, timeout=900)
    return round(r["eval_count"] / (r["eval_duration"] / 1e9), 1)


def gpu(subject):
    tag = tag_of(subject)
    out = {"subject": subject, "tag": tag, "cpus_visible": os.cpu_count(), "cpus_allowed": len(os.sched_getaffinity(0)),
           "cpu_quota": read("/sys/fs/cgroup/cpu.max"),
           "cpu_quota_v1": [read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"), read("/sys/fs/cgroup/cpu/cpu.cfs_period_us")]}
    with Ollama() as ollama:
        out["pull_seconds"] = ollama.pull(tag)
        started = time.time()
        call("/api/generate", {"model": tag, "prompt": "", "stream": False, "keep_alive": "10m"}, timeout=600)
        out["load_seconds"] = round(time.time() - started, 1)
        out["decode_tps_default_threads"] = decode_tps(tag)
        out["loaded"] = [{k: m.get(k) for k in ("name", "size", "size_vram")} for m in call("/api/ps")["models"]]
        # A new num_thread reloads the runner, so the first decode after it may be cold: two each.
        out["decode_tps_by_threads"] = {str(n or "default"): [decode_tps(tag, n), decode_tps(tag, n)] for n in (None, 32, 16, 8, 4)}
    write("gpu-check.json", out)
    print(json.dumps(out))


def gpu_samples(path):
    rows = []
    for line in pathlib.Path(path).read_text().splitlines():
        parts = [x.strip() for x in line.split(",")]
        if len(parts) == 2 and all(x.isdigit() for x in parts):
            rows.append((int(parts[0]), int(parts[1])))
    if not rows:
        return None
    return {"util_mean_pct": round(statistics.mean(r[0] for r in rows), 1), "memory_peak_mib": max(r[1] for r in rows),
            "samples": len(rows)}


def summarize(record):
    tasks, speed = {}, {}
    for r in record["results"]:
        if r["kind"] == "speed":
            speed[r["task"]] = {k: r["metrics"].get(k) for k in ("decode_tps", "cpu_offload", "model_bytes")}
        else:
            tasks[r["task"]] = {"passed": r.get("passed"), "samples": r.get("samples"), "status": r.get("status"),
                                "reasons": r.get("reasons")}
    runtime = record.get("runtime") or {}
    settings = (record.get("test_agent") or {}).get("settings") or {}
    return {"run_id": record["run_id"], "wall_seconds": record["wall_seconds"], "tasks": tasks, "speed": speed,
            "digest_registered": record["subject"].get("digest_registered"), "hardware": runtime.get("hardware"),
            "provider_version": (runtime.get("provider") or {}).get("version"),
            "sandbox": settings.get("sandbox"), "num_thread": settings.get("num_thread")}


def one_round(subject, suite, index):
    runs = pathlib.Path(os.environ["BENCHCLUB_HOME"]) / "runs"
    before = set(runs.glob("*"))
    csv = pathlib.Path(f"/tmp/gpu-{index}.csv")
    poll = None
    if shutil.which("nvidia-smi"):
        with open(csv, "w") as sink:
            poll = subprocess.Popen(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits",
                                     "-l", "5"], stdout=sink, stderr=subprocess.DEVNULL)
    out = {"subject": subject, "suite": suite, "round": index}
    started = time.time()
    proc = subprocess.Popen(["benchclub", "eval", subject, "--suite", suite, "--json", "--keep-model"], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(timeout=ROUND_TIMEOUTS[suite])
        out["exit_code"] = proc.returncode
        if proc.returncode:
            out["stdout_tail"], out["stderr_tail"] = stdout[-800:], stderr[-800:]
    except subprocess.TimeoutExpired:
        # The whole group: the CLI's engine and its private Ollama would otherwise hold the GPU.
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        out["exit_code"] = "timeout"
    if poll:
        poll.terminate()
        poll.wait()
        out["gpu"] = gpu_samples(csv)
    out["seconds"] = round(time.time() - started, 1)
    new = sorted(set(runs.glob("*")) - before)
    if new:
        shutil.copytree(new[-1], RESULTS / "runs" / f"{index:02d}-{new[-1].name}", ignore=shutil.ignore_patterns("work"))
        record = new[-1] / "run-record.json"
        if record.exists():
            out.update(summarize(json.loads(record.read_text())))
    return out


def rounds(subject, suite, count):
    progress = {"subject": subject, "suite": suite, "planned": count, "done": 0}
    with Ollama() as ollama:
        progress["pull_seconds"] = ollama.pull(tag_of(subject))
    write("progress.json", progress)
    failures = 0
    for index in range(count):
        out = one_round(subject, suite, index)
        with open(RESULTS / "rounds.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(out, ensure_ascii=False) + "\n")
        progress["done"] = index + 1
        failures = failures + 1 if out["exit_code"] != 0 else 0
        decode = ((out.get("speed") or {}).get("speed@0") or {}).get("decode_tps")
        if decode is not None and decode < SLOWEST_DECODE_TPS:
            progress["stopped"] = f"speed@0 decoded at {decode} tok/s, below {SLOWEST_DECODE_TPS}"
        elif out["exit_code"] == "timeout":
            progress["stopped"] = "a round hit its time limit"
        elif failures >= 2:
            progress["stopped"] = "two rounds in a row failed"
        write("progress.json", progress)
        if "stopped" in progress:
            break


if __name__ == "__main__":
    RESULTS.mkdir(parents=True, exist_ok=True)
    command, *rest = sys.argv[1:] or [""]
    if command == "gpu":
        gpu(*rest)
    elif command == "rounds":
        rounds(rest[0], rest[1], int(rest[2]))
    else:
        sys.exit(__doc__)
