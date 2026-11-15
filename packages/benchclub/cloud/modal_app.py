"""The spike: today's CLI on a Modal GPU. It answers what the platform needs to know; it is not the platform.

    M="uvx --from modal[api-proxy-support] modal run cloud/modal_app.py"
    $M::probe                       what this container allows, and whether the GPU is there
    $M::prefetch                    pull the models into a volume, on a cheap CPU container
    $M::one --subject X --suite Y   one round, to measure it before paying for many
    $M::matrix                      every model: standard x10, coding x3
"""

import json
import os
import pathlib
import shutil
import socket
import statistics
import subprocess
import time

import modal

HERE = pathlib.Path(__file__).resolve().parent
GPU = "L40S"
CPU_CORES = 4
MEMORY_GIB = 32
CONCURRENT_ROUNDS = 6
# modal.com/pricing, 2026-10-30.
GPU_PER_SECOND = 0.000542
CORE_PER_SECOND = 0.0000131
GIB_PER_SECOND = 0.00000222
SUBJECTS = ("openbmb-minicpm5-2b", "qwen-qwen3.5-2b", "qwen-qwen3.6-35b-a3b")
STANDARD, CODING = "suite-standard@1.0", "suite-coding@1.0"
ROUND_TIMEOUTS = {STANDARD: 30 * 60, CODING: 3 * 60 * 60}

app = modal.App("kaluma-cloud-spike")
image = modal.Image.from_dockerfile(HERE / "Dockerfile", context_dir=HERE.parent, build_args={"TARGETARCH": "amd64"})
models = modal.Volume.from_name("kaluma-spike-models", create_if_missing=True)
results = modal.Volume.from_name("kaluma-spike-results", create_if_missing=True)


def rate_per_second():
    return GPU_PER_SECOND + CPU_CORES * CORE_PER_SECOND + MEMORY_GIB * GIB_PER_SECOND


def wait_for_port(port, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(1)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.5)
    raise TimeoutError(f"nothing listening on {port}")


@app.function(image=image, gpu=GPU, timeout=300)
def probe_container():
    p = subprocess.run(["python", "-I", "/opt/probe.py"], capture_output=True, text=True, timeout=200)
    return json.loads(p.stdout) if p.returncode == 0 else {"failed": p.stderr[-1000:]}


@app.function(image=image, cpu=4.0, memory=8192, volumes={"/models": models}, timeout=60 * 60)
def prefetch_model(tag):
    env = {**os.environ, "OLLAMA_HOST": "127.0.0.1:11531", "OLLAMA_NOPRUNE": "1"}
    serve = subprocess.Popen(["ollama", "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for_port(11531)
        started = time.time()
        p = subprocess.run(["ollama", "pull", tag], env=env, capture_output=True, text=True)
        if p.returncode != 0:
            return {"tag": tag, "failed": p.stderr[-600:]}
        seconds = round(time.time() - started, 1)
    finally:
        serve.terminate()
        serve.wait()
    models.commit()
    return {"tag": tag, "seconds": seconds}


def summarize_record(record):
    tasks, speed = {}, {}
    for r in record["results"]:
        if r["kind"] == "speed":
            speed[r["task"]] = {k: r["metrics"].get(k) for k in ("decode_tps", "cpu_offload", "model_bytes")}
        else:
            tasks[r["task"]] = {"passed": r.get("passed"), "samples": r.get("samples"), "status": r.get("status"),
                                "reasons": r.get("reasons")}
    return {"run_id": record["run_id"], "wall_seconds": record["wall_seconds"], "tasks": tasks, "speed": speed,
            "digest_registered": record["subject"].get("digest_registered"), "hardware": record["runtime"].get("hardware"),
            "provider_version": (record["runtime"].get("provider") or {}).get("version"),
            "sandbox": (record.get("test_agent", {}).get("settings") or {}).get("sandbox")}


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


@app.function(image=image, gpu=GPU, cpu=float(CPU_CORES), memory=MEMORY_GIB * 1024, volumes={"/models": models, "/results": results},
              timeout=max(ROUND_TIMEOUTS.values()), max_containers=CONCURRENT_ROUNDS)
def run_round(subject, suite, label, submitted):
    started = time.time()
    # Bundled configs on purpose: this measures the suite, not whether the old hub happens to be up.
    env = {**os.environ, "BENCHCLUB_HUB": "https://hub.invalid", "BENCHCLUB_API": "https://api.invalid"}
    with open("/tmp/gpu.csv", "w") as sink:
        poll = subprocess.Popen(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits", "-l", "5"],
                                stdout=sink, stderr=subprocess.DEVNULL)
    out = {"subject": subject, "suite": suite, "label": label, "queued_and_cold_seconds": round(started - submitted, 1)}
    try:
        p = subprocess.run(["benchclub", "eval", subject, "--suite", suite, "--json", "--keep-model"], env=env, capture_output=True, text=True,
                           timeout=ROUND_TIMEOUTS[suite])
        out["exit_code"] = p.returncode
        if p.returncode != 0:
            out["stdout_tail"], out["stderr_tail"] = p.stdout[-800:], p.stderr[-800:]
    except subprocess.TimeoutExpired:
        out["exit_code"] = "timeout"
    poll.terminate()
    poll.wait()
    out["seconds_in_container"] = round(time.time() - started, 1)
    out["gpu"] = gpu_samples("/tmp/gpu.csv")
    run_dirs = list(pathlib.Path(os.environ["BENCHCLUB_HOME"], "runs").glob("*"))
    if run_dirs:
        dest = pathlib.Path("/results", label, subject, suite.replace("@", "-"), run_dirs[0].name)
        shutil.copytree(run_dirs[0], dest, ignore=shutil.ignore_patterns("work"))
        results.commit()
        record = run_dirs[0] / "run-record.json"
        if record.exists():
            out.update(summarize_record(json.loads(record.read_text())))
    return out


def results_dir():
    path = HERE.parents[3] / ".scratch" / "kaluma-cloud" / "results"
    path.mkdir(parents=True, exist_ok=True)
    return path


def bundled_tags():
    subjects = json.loads((HERE.parent / "src/benchclub/engine/subjects.json").read_text())
    return {s["id"]: s["ollama"]["tag"] for s in subjects}


def record_round(r, label):
    with open(results_dir() / f"{label}.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({k: r.get(k) for k in ("subject", "suite", "exit_code", "queued_and_cold_seconds", "seconds_in_container", "gpu")}, ensure_ascii=False))
    for task, t in (r.get("tasks") or {}).items():
        print(f"    {task}: {t['passed']}/{t['samples']} {t['status']} {t['reasons'] or ''}")
    for task, s in (r.get("speed") or {}).items():
        print(f"    {task}: {s['decode_tps']} tok/s, cpu_offload={s['cpu_offload']}")
    if r.get("seconds_in_container"):
        print(f"    about ${(r['queued_and_cold_seconds'] + r['seconds_in_container']) * rate_per_second():.2f} at most, sandbox {r.get('sandbox')}")
    if r.get("exit_code") != 0:
        print("    stderr:", (r.get("stderr_tail") or "")[-400:], (r.get("stdout_tail") or "")[-400:])


@app.local_entrypoint()
def probe():
    out = probe_container.remote()
    (results_dir() / "probe-modal.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({k: out.get(k) for k in ("gpu", "seccomp_network", "uid_drop", "full_stack", "network_namespace", "bubblewrap", "ollama")}, indent=1))
    print(json.dumps(out.get("identity"), indent=1))


@app.local_entrypoint()
def prefetch(subject: str = ""):
    tags = bundled_tags()
    wanted = [subject] if subject else list(SUBJECTS)
    for r in prefetch_model.map([tags[s] for s in wanted], return_exceptions=True):
        print(r)


@app.local_entrypoint()
def one(subject: str = SUBJECTS[0], suite: str = STANDARD, label: str = "smoke"):
    record_round(run_round.remote(subject, suite, label, time.time()), label)


@app.local_entrypoint()
def matrix(standard_rounds: int = 10, coding_rounds: int = 3, label: str = "matrix", subjects: str = ""):
    wanted = subjects.split(",") if subjects else list(SUBJECTS)
    jobs = [(s, suite, label) for s in wanted for suite, n in ((STANDARD, standard_rounds), (CODING, coding_rounds)) for _ in range(n)]
    ceiling = sum(ROUND_TIMEOUTS[j[1]] for j in jobs) * rate_per_second()
    print(f"{len(jobs)} rounds, at {CONCURRENT_ROUNDS} at a time; if every round hit its timeout that is ${ceiling:.0f}.")
    now = time.time()
    for r in run_round.starmap([(*j, now) for j in jobs], order_outputs=False, return_exceptions=True):
        if isinstance(r, dict):
            record_round(r, label)
        else:
            print("round failed:", repr(r)[:400])
