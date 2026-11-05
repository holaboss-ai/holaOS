#!/usr/bin/env python3
"""The cloud spike on RunPod: one pod per job, today's CLI copied onto it, and no pod left billing.

    python3 cloud/runpod_spike.py probe [--skip-model]          GPU, sandbox and self-delete check on one 48 GB GPU
    python3 cloud/runpod_spike.py run SUBJECT SUITE [-n N]      N rounds on one pod
    python3 cloud/runpod_spike.py matrix --yes                  three models: standard x10 and coding x3
    python3 cloud/runpod_spike.py sweep [--all]                 delete spike pods past their deadline, or all of them

A pod bills until it is deleted. Four layers see to that:
  1. this script deletes its pods on every way out, Ctrl-C and a closed terminal included;
  2. each pod deletes itself at a deadline fixed at creation, even if this machine sleeps or dies;
  3. every command first deletes spike pods past their deadline;
  4. the account holds only a small prepaid balance.

When no listed GPU is free, a create is refused at no cost; --wait keeps asking once a minute.
The key comes from $RUNPOD_API_KEY or ~/.runpod-key. KALUMA_RUNPOD_API points this at cloud/fake_runpod.py.
"""

import argparse
import concurrent.futures
import contextlib
import functools
import json
import os
import pathlib
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
PACKAGE = HERE.parent
RESULTS = PACKAGE.parents[2] / ".scratch" / "kaluma-cloud" / "results" / "runpod"
API = os.environ.get("KALUMA_RUNPOD_API", "https://rest.runpod.io/v1").rstrip("/")
IMAGE = "runpod/base:1.5.0-ubuntu2404"
# 48 GB cards under the price ceiling, in order of preference.
GPUS = ("NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation", "NVIDIA L40", "NVIDIA RTX A6000", "NVIDIA A40")
MAX_PRICE_PER_HOUR = 1.5
PREFIX = "kaluma-spike-"
SETUP_MINUTES = 25
PROBE_MINUTES = 30
ROUND_MINUTES = {"suite-standard@1.0": 30, "suite-coding@1.0": 180}
SUBJECTS = ("openbmb-minicpm5-2b", "qwen-qwen3.5-2b", "qwen-qwen3.6-35b-a3b")
MATRIX = {"suite-standard@1.0": 10, "suite-coding@1.0": 3}
PAYLOAD = ("src", "pyproject.toml", "README.md", "cloud/probe.py", "cloud/pod_setup.sh", "cloud/pod_rounds.py")
ENV = "source /opt/kaluma-env.sh"

# The pod's start command. The image's own /start.sh starts sshd when PUBLIC_KEY is set; the loop is layer 2.
START = r'''mkdir -p /root/.ssh && echo "$KALUMA_SSH_KEY" >> /root/.ssh/authorized_keys
export PUBLIC_KEY="${PUBLIC_KEY:-$KALUMA_SSH_KEY}"
( while [ "$(date +%s)" -lt "$KALUMA_DEADLINE" ]; do sleep 15; done
  for call in "-X DELETE $KALUMA_API/pods/$RUNPOD_POD_ID" "-X POST $KALUMA_API/pods/$RUNPOD_POD_ID/stop"; do
    curl -fsS -m 30 -H "Authorization: Bearer $RUNPOD_API_KEY" $call >> /var/log/kaluma-watchdog.log 2>&1 && break
  done ) &
exec /start.sh'''

RENT = {"gpus": GPUS, "cloud": "ANY", "wait": 0}
LIVE = set()
LOCK = threading.Lock()
# The system proxy would swallow requests to a fake API on this machine.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({} if "://127.0.0.1" in API else None))


def log(job, text):
    with LOCK:
        print(f"{time.strftime('%H:%M:%S')} [{job}] {text}", flush=True)


@functools.lru_cache(maxsize=None)
def api_key():
    key = os.environ.get("RUNPOD_API_KEY", "").strip()
    path = pathlib.Path.home() / ".runpod-key"
    if not key and path.exists():
        key = path.read_text().strip()
    if not key:
        sys.exit("No RunPod key. Put it in ~/.runpod-key (chmod 600) or $RUNPOD_API_KEY.")
    return key


def api(method, path, body=None, missing_ok=False):
    data = None if body is None else json.dumps(body).encode()
    # Runpod's Cloudflare answers 403 (error 1010) to urllib's default User-Agent.
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json",
                                          "User-Agent": "kaluma-spike/0.1"})
    try:
        with OPENER.open(req, timeout=60) as r:
            raw = r.read()
    except urllib.error.HTTPError as exc:
        if missing_ok and exc.code == 404:
            return None
        detail = exc.read()[:300].decode(errors="replace")
        raise RuntimeError(f"RunPod {method} {path}: HTTP {exc.code} {detail}") from None
    return json.loads(raw) if raw.strip() else {}


def deadline_of(name):
    try:
        return int(str(name).rsplit("-", 1)[1])
    except (IndexError, ValueError):
        return 0


def gone(pod_id):
    pod = api("GET", f"/pods/{pod_id}", missing_ok=True)
    return pod is None or pod.get("desiredStatus") == "TERMINATED"


def delete(pod_id, job="cleanup"):
    for attempt in range(5):
        try:
            api("DELETE", f"/pods/{pod_id}", missing_ok=True)
            with LOCK:
                LIVE.discard(pod_id)
            log(job, f"deleted pod {pod_id}")
            return True
        except (RuntimeError, OSError) as exc:
            log(job, f"deleting {pod_id} failed ({exc}); retrying")
            time.sleep(5 * (attempt + 1))
    log(job, f"COULD NOT DELETE {pod_id}. It deletes itself at its deadline; delete it in the RunPod console to stop it sooner.")
    return False


def delete_live():
    with LOCK:
        live = list(LIVE)
    for pod_id in live:
        delete(pod_id)


def sweep(everything=False):
    """Deletes spike pods past their deadline (all of them with everything); returns the ones left running."""
    pods = api("GET", "/pods") or []
    if isinstance(pods, dict):
        pods = pods.get("pods") or pods.get("data") or []
    ours = [p for p in pods if str(p.get("name", "")).startswith(PREFIX) and p.get("desiredStatus") != "TERMINATED"]
    now = time.time()
    doomed = [p for p in ours if everything or deadline_of(p["name"]) < now]
    for p in doomed:
        delete(p["id"], "sweep")
    return [p for p in ours if p not in doomed]


class Pod:
    """One pod for one job, reached over SSH with a throwaway key that never leaves a temp directory."""

    def __init__(self, job, minutes):
        self.job, self.minutes = job, minutes
        self.keydir = pathlib.Path(tempfile.mkdtemp(prefix="kaluma-ssh-"))
        self.id = None
        self.price = 0.0
        self.times = {}

    def start(self):
        key = self.keydir / "id"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "kaluma-spike", "-f", str(key)], check=True)
        public = (self.keydir / "id.pub").read_text().strip()
        pod = self.create(public)
        self.created = time.time()
        self.id = pod["id"]
        with LOCK:
            LIVE.add(self.id)
        self.price = float(pod.get("costPerHr") or 0)
        self.gpu = (pod.get("gpu") or {}).get("id") or (pod.get("machine") or {}).get("gpuTypeId") or "?"
        log(self.job, f"pod {self.id}: {self.gpu}, {self.cloud}, ${self.price}/h; "
                      f"deadline {time.strftime('%H:%M', time.localtime(self.deadline))}")
        if self.price > MAX_PRICE_PER_HOUR:
            raise RuntimeError(f"${self.price}/h is above the ${MAX_PRICE_PER_HOUR}/h ceiling")
        ip, port = self.wait_for_address()
        self.times["to_address_s"] = round(time.time() - self.created)
        self.ssh = ["ssh", "-F", "/dev/null", "-i", str(key), "-p", str(port), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                    "-o", "StrictHostKeyChecking=accept-new",
                    "-o", f"UserKnownHostsFile={self.keydir / 'known_hosts'}", "-o", "ConnectTimeout=15",
                    "-o", "ServerAliveInterval=30", "-o", "LogLevel=ERROR", f"root@{ip}"]
        self.wait_for_ssh()
        self.times["to_ssh_s"] = round(time.time() - self.created)

    def create(self, public):
        clouds = ("SECURE", "COMMUNITY") if RENT["cloud"] == "ANY" else (RENT["cloud"],)
        end = time.time() + RENT["wait"] * 60
        while True:
            for cloud in clouds:
                self.deadline = int(time.time() + self.minutes * 60)
                body = {
                    "name": f"{PREFIX}{self.job}-{self.deadline}", "imageName": IMAGE, "gpuCount": 1,
                    "gpuTypeIds": list(RENT["gpus"]), "gpuTypePriority": "custom", "cloudType": cloud,
                    "containerDiskInGb": 100, "volumeInGb": 0, "minVCPUPerGPU": 8, "minRAMPerGPU": 32,
                    "ports": ["22/tcp"], "dockerStartCmd": ["bash", "-c", START],
                    # Our key goes in twice: PUBLIC_KEY makes /start.sh run sshd even if RunPod overrides it with account keys.
                    "env": {"PUBLIC_KEY": public, "KALUMA_SSH_KEY": public, "KALUMA_DEADLINE": str(self.deadline), "KALUMA_API": API}}
                if cloud == "COMMUNITY":
                    body["supportPublicIp"] = True
                try:
                    pod = api("POST", "/pods", body)
                except RuntimeError as exc:
                    if "no instances" not in str(exc).lower():
                        raise
                    continue
                self.cloud = cloud
                return pod
            if time.time() >= end:
                raise RuntimeError(f"no free GPU among {', '.join(RENT['gpus'])} in {'/'.join(clouds)} after {RENT['wait']} min")
            log(self.job, "no listed GPU is free; asking again in a minute")
            time.sleep(60)

    def wait_for_address(self, timeout=20 * 60):
        end = time.time() + timeout
        while time.time() < end:
            pod = api("GET", f"/pods/{self.id}", missing_ok=True)
            if pod is None or pod.get("desiredStatus") == "TERMINATED":
                raise RuntimeError("the pod went away while starting")
            port = (pod.get("portMappings") or {}).get("22")
            if pod.get("publicIp") and port:
                return pod["publicIp"], int(port)
            time.sleep(5)
        raise TimeoutError(f"no public address after {timeout // 60} minutes")

    def sh(self, command, timeout=600, check=True, attempts=1):
        """ssh exits 255 when the connection fails. Retry only commands that are safe to run twice."""
        for attempt in range(1, attempts + 1):
            p = subprocess.run([*self.ssh, command], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
            if p.returncode != 255 or attempt == attempts:
                break
            log(self.job, f"SSH connection failed ({p.stderr.strip()[-200:] or 'no message'}); trying again")
            time.sleep(10 * attempt)
        if check and p.returncode:
            raise RuntimeError(f"`{command[:80]}` exited {p.returncode}: {(p.stderr or p.stdout)[-600:]}")
        return p

    def wait_for_ssh(self, timeout=10 * 60):
        end = time.time() + timeout
        while time.time() < end:
            try:
                # /start.sh writes the pod's environment after sshd is up; the remote steps read it.
                if self.sh("test -f /etc/rp_environment", timeout=30, check=False).returncode == 0:
                    return
            except subprocess.TimeoutExpired:
                pass
            time.sleep(5)
        raise TimeoutError(f"SSH not ready after {timeout // 60} minutes")

    def setup(self):
        local = subprocess.Popen(["tar", "-czf", "-", "--exclude", "__pycache__", *PAYLOAD], cwd=PACKAGE, stdout=subprocess.PIPE,
                                 env={**os.environ, "COPYFILE_DISABLE": "1"})
        p = subprocess.run([*self.ssh, "mkdir -p /opt/benchclub && tar -xzf - --no-same-owner -C /opt/benchclub"],
                           stdin=local.stdout, capture_output=True, text=True, timeout=600)
        local.stdout.close()
        if local.wait() or p.returncode:
            raise RuntimeError(f"copying the CLI failed: {p.stderr[-400:]}")
        started = time.time()
        out = self.sh("bash /opt/benchclub/cloud/pod_setup.sh", timeout=20 * 60).stdout.strip().splitlines()
        self.times["setup_s"] = round(time.time() - started)
        log(self.job, out[-1] if out else "set up")

    def pull(self, dest):
        dest.mkdir(parents=True, exist_ok=True)
        remote = subprocess.Popen([*self.ssh, "tar -czf - -C /root/results ."], stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        subprocess.run(["tar", "-xzf", "-", "-C", str(dest)], stdin=remote.stdout, capture_output=True, timeout=600)
        remote.stdout.close()
        remote.wait()

    def follow(self, command, dest):
        """Runs command on the pod in the background and pulls results every minute, so a dropped SSH loses nothing."""
        script = f"{ENV}; {command} > /root/results/run.log 2>&1; echo $? > /root/results/exit_code"
        # The marker keeps a retried start from launching the rounds twice when the first one did get through.
        self.sh(f"if mkdir /root/results/.started 2>/dev/null; then nohup bash -c {shlex.quote(script)} "
                "< /dev/null > /dev/null 2>&1 & fi", attempts=3)
        seen = 0
        while time.time() < self.deadline - 120:
            time.sleep(60)
            self.pull(dest)
            rounds = dest / "rounds.jsonl"
            lines = rounds.read_text().splitlines() if rounds.exists() else []
            for line in lines[seen:]:
                try:
                    r = json.loads(line)
                except ValueError:
                    break
                report_round(self.job, r)
                seen += 1
            if (dest / "exit_code").exists():
                stopped = json.loads((dest / "progress.json").read_text()).get("stopped") if (dest / "progress.json").exists() else None
                log(self.job, f"finished, exit {(dest / 'exit_code').read_text().strip()}" + (f"; stopped early: {stopped}" if stopped else ""))
                return
        log(self.job, "the pod's deadline is near; keeping what has arrived")
        self.pull(dest)

    def try_self_delete(self):
        """Layer 2 works only if the pod's own key may delete the pod. This finds out, and ends the pod if it can."""
        script = ('sleep 3; source /etc/rp_environment; curl -fsS -m 30 -X DELETE -H "Authorization: Bearer $RUNPOD_API_KEY" '
                  '"$KALUMA_API/pods/$RUNPOD_POD_ID" > /tmp/self-delete.log 2>&1; echo "exit $?" >> /tmp/self-delete.log')
        self.sh(f"nohup bash -c {shlex.quote(script)} < /dev/null > /dev/null 2>&1 &")
        end = time.time() + 120
        while time.time() < end:
            time.sleep(5)
            if gone(self.id):
                with LOCK:
                    LIVE.discard(self.id)
                return "deleted itself"
        why = self.sh("cat /tmp/self-delete.log", timeout=30, check=False).stdout.strip()
        return f"could not delete itself ({why[-300:] or 'no log'})"


@contextlib.contextmanager
def pod(job, minutes):
    p = Pod(job, minutes)
    try:
        p.start()
        yield p
    finally:
        if p.id:
            hours = (time.time() - p.created) / 3600
            log(job, f"pod lived {hours * 60:.0f} min, about ${p.price * hours:.2f}")
            delete(p.id, job)
        shutil.rmtree(p.keydir, ignore_errors=True)


def report_round(job, r):
    log(job, f"round {r.get('round')}: exit {r.get('exit_code')}, {r.get('seconds')} s, gpu {r.get('gpu')}")
    log(job, f"    num_thread {r.get('num_thread')}, sandbox {r.get('sandbox')}")
    for task, t in (r.get("tasks") or {}).items():
        log(job, f"    {task}: {t['passed']}/{t['samples']} {t['status']} {t['reasons'] or ''}")
    for task, s in (r.get("speed") or {}).items():
        log(job, f"    {task}: {s['decode_tps']} tok/s, cpu_offload={s['cpu_offload']}")
    if r.get("exit_code") != 0:
        log(job, f"    {(r.get('stderr_tail') or '')[-300:]} {(r.get('stdout_tail') or '')[-300:]}")


def load(path):
    return json.loads(path.read_text()) if path.exists() else None


def cmd_probe(args):
    dest = RESULTS / f"probe-{time.strftime('%Y%m%d-%H%M%S')}"
    with pod("probe", args.minutes) as p:
        p.setup()
        p.sh(f"{ENV}; python3 -I /opt/benchclub/cloud/probe.py > /root/results/probe.json", timeout=300)
        if not args.skip_model:
            p.sh(f"{ENV}; python3 /opt/benchclub/cloud/pod_rounds.py gpu {SUBJECTS[0]}", timeout=20 * 60)
        p.pull(dest)
        self_delete = p.try_self_delete() if args.self_delete else "not tested"
        summary = {"times": p.times, "self_delete": self_delete, "price_per_hour": p.price, "gpu": p.gpu, "cloud": p.cloud}
    (dest / "summary.json").write_text(json.dumps(summary, indent=1))
    probe, check = load(dest / "probe.json") or {}, load(dest / "gpu-check.json")
    identity = probe.get("identity") or {}
    rows = [("GPU", (probe.get("gpu") or {}).get("nvidia_smi")), ("kernel", identity.get("kernel", "")[:90]),
            ("capabilities", identity.get("status")), ("seccomp network filter", probe.get("seccomp_network")),
            ("uid drop", probe.get("uid_drop")), ("full sandbox stack", probe.get("full_stack")),
            ("network namespace", probe.get("network_namespace"))]
    if check:
        rows += [("model in memory", check["loaded"]), ("decode, default threads", f"{check['decode_tps_default_threads']} tok/s"),
                 ("pull / load", f"{check['pull_seconds']} s / {check['load_seconds']} s"),
                 ("CPUs visible / allowed / quota", f"{check['cpus_visible']} / {check.get('cpus_allowed')} / "
                                                     f"{check['cpu_quota']} {check.get('cpu_quota_v1')}"),
                 ("decode by num_thread, tok/s", check.get("decode_tps_by_threads"))]
    rows += [("timings", p.times), ("self-delete", self_delete), ("results", dest)]
    for name, value in rows:
        log("probe", f"{name}: {value}")


def run_job(subject, suite, rounds):
    job = f"{subject}-{suite.split('@')[0].removeprefix('suite-')}"
    dest = RESULTS / f"{job}-{time.strftime('%Y%m%d-%H%M%S')}"
    with pod(job, SETUP_MINUTES + rounds * ROUND_MINUTES[suite]) as p:
        p.setup()
        p.follow(f"python3 /opt/benchclub/cloud/pod_rounds.py rounds {subject} {suite} {rounds}", dest)
    log(job, f"results in {dest}")


def ceiling(jobs):
    return sum(SETUP_MINUTES + n * ROUND_MINUTES[suite] for _, suite, n in jobs) / 60 * MAX_PRICE_PER_HOUR


def cmd_run(args):
    log("run", f"if every round hits its time limit this costs at most ${ceiling([(args.subject, args.suite, args.rounds)]):.2f}")
    run_job(args.subject, args.suite, args.rounds)


def cmd_matrix(args):
    subjects = args.subjects.split(",") if args.subjects else SUBJECTS
    jobs = [(s, suite, n) for s in subjects for suite, n in MATRIX.items()]
    log("matrix", f"{len(jobs)} pods at once; if every round hit its time limit: ${ceiling(jobs):.0f}")
    if not args.yes:
        sys.exit("Add --yes to start.")
    # Not a `with` block: on Ctrl-C it would wait hours for the workers before their pods could be deleted.
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs))
    futures = {pool.submit(run_job, *job): job for job in jobs}
    for future in concurrent.futures.as_completed(futures):
        if future.exception():
            log("matrix", f"{futures[future][:2]} failed: {future.exception()}")
    pool.shutdown()


def cmd_sweep(args):
    left = sweep(everything=args.all)
    log("sweep", f"{len(left)} spike pod(s) still within their deadline: {[p['name'] for p in left]}")


def interrupt(_signum, _frame):
    raise KeyboardInterrupt


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    rent = argparse.ArgumentParser(add_help=False)
    rent.add_argument("--gpus", default=",".join(GPUS), help="acceptable GPU types, comma-separated, preferred first")
    rent.add_argument("--cloud", choices=("SECURE", "COMMUNITY", "ANY"), default="ANY", help="ANY tries Secure first")
    rent.add_argument("--wait", type=int, default=60, help="minutes to keep asking while no listed GPU is free")
    p = sub.add_parser("probe", parents=[rent])
    p.add_argument("--skip-model", action="store_true", help="skip the model pull and GPU speed check")
    p.add_argument("--minutes", type=int, default=PROBE_MINUTES, help="the pod's deadline")
    p.add_argument("--self-delete", action="store_true", help="also test whether the pod's own key can delete it")
    p.set_defaults(func=cmd_probe)
    p = sub.add_parser("run", parents=[rent])
    p.add_argument("subject", choices=SUBJECTS)
    p.add_argument("suite", choices=tuple(ROUND_MINUTES))
    p.add_argument("-n", "--rounds", type=int, default=1)
    p.set_defaults(func=cmd_run)
    p = sub.add_parser("matrix", parents=[rent])
    p.add_argument("--yes", action="store_true")
    p.add_argument("--subjects", default="", help="comma-separated; all three by default")
    p.set_defaults(func=cmd_matrix)
    p = sub.add_parser("sweep")
    p.add_argument("--all", action="store_true", help="delete every spike pod, not only those past their deadline")
    p.set_defaults(func=cmd_sweep)
    args = ap.parse_args()
    if args.command != "sweep":
        RENT.update(gpus=tuple(g.strip() for g in args.gpus.split(",") if g.strip()), cloud=args.cloud, wait=args.wait)

    # SIGINT is left ignored when Python starts in the background; a SIGHUP ignored by nohup stays ignored.
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        if sig != signal.SIGHUP or signal.getsignal(sig) != signal.SIG_IGN:
            signal.signal(sig, interrupt)
    if sys.platform == "darwin" and shutil.which("caffeinate"):
        subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
    try:
        if args.command != "sweep":
            left = sweep()
            if left:
                log("sweep", f"{len(left)} other spike pod(s) running: {[p['name'] for p in left]}")
        args.func(args)
    except KeyboardInterrupt:
        log("main", "stopping: deleting every pod this run made")
        delete_live()
        os._exit(130)
    finally:
        delete_live()


if __name__ == "__main__":
    main()
