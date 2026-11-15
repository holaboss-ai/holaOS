#!/usr/bin/env python3
"""A stand-in for RunPod's pod API, for testing runpod_spike.py on this machine: each pod is a Docker container
from the same image. No GPU, amd64 runs emulated, and a pod's own key may delete or stop that pod.

    python3 cloud/fake_runpod.py --port 8787 &
    KALUMA_RUNPOD_API=http://127.0.0.1:8787/v1 RUNPOD_API_KEY=user-key python3 cloud/runpod_spike.py probe --skip-model
"""

import argparse
import json
import re
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USER_KEY = "user-key"
PODS = {}
LOCK = threading.Lock()
PORT = 8787


def docker(*args):
    return subprocess.run(["docker", *args], capture_output=True, text=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"{time.strftime('%H:%M:%S')} {self.caller()[:12]:12} {fmt % args}\n")

    def caller(self):
        return (self.headers.get("Authorization") or "").removeprefix("Bearer ")

    def reply(self, code, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route(self):
        m = re.fullmatch(r"/v1/pods(?:/(\w+))?(/stop)?", self.path.split("?")[0])
        if not m:
            self.reply(404, {"error": "no such path"})
            return None
        pod_id = m.group(1)
        if self.caller() != USER_KEY and not (pod_id and self.caller() == f"pod-{pod_id}"):
            self.reply(401, {"error": "unauthorized"})
            return None
        if pod_id and pod_id not in PODS:
            self.reply(404, {"error": "pod not found"})
            return None
        return pod_id, bool(m.group(2))

    def do_GET(self):
        found = self.route()
        if found:
            pod_id, _ = found
            self.reply(200, PODS[pod_id] if pod_id else list(PODS.values()))

    def do_DELETE(self):
        found = self.route()
        if found and found[0]:
            docker("rm", "-f", f"fake-runpod-{found[0]}")
            with LOCK:
                PODS.pop(found[0], None)
            self.reply(204)

    def do_POST(self):
        found = self.route()
        if not found:
            return
        pod_id, stop = found
        if stop:
            docker("stop", f"fake-runpod-{pod_id}")
            PODS[pod_id]["desiredStatus"] = "EXITED"
            self.reply(200, PODS[pod_id])
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        pod_id = secrets.token_hex(6)
        env = {**(body.get("env") or {}), "RUNPOD_POD_ID": pod_id, "RUNPOD_API_KEY": f"pod-{pod_id}",
               "KALUMA_API": f"http://host.docker.internal:{PORT}/v1"}
        cmd = ["run", "-d", "--platform", "linux/amd64", "--name", f"fake-runpod-{pod_id}", "-p", "127.0.0.1::22"]
        for key, value in env.items():
            cmd += ["-e", f"{key}={value}"]
        p = docker(*cmd, body["imageName"], *(body.get("dockerStartCmd") or []))
        if p.returncode:
            self.reply(500, {"error": p.stderr[-400:]})
            return
        port = int(docker("port", f"fake-runpod-{pod_id}", "22/tcp").stdout.strip().rsplit(":", 1)[1])
        pod = {"id": pod_id, "name": body.get("name"), "desiredStatus": "RUNNING", "costPerHr": 1.09,
               "publicIp": "127.0.0.1", "portMappings": {"22": port}, "image": body["imageName"]}
        with LOCK:
            PODS[pod_id] = pod
        self.reply(201, pod)


def main():
    global PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=PORT)
    PORT = ap.parse_args().port
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
