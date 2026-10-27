"""A stand-in `ollama` executable: `serve` answers the endpoints a bench run uses on OLLAMA_HOST.

Knobs come from the environment the CLI passes through (FAKE_OLLAMA_*), and it writes what it saw into
FAKE_OLLAMA_STATE: env.json (its environment), requests.jsonl, serve.pid and, with FAKE_OLLAMA_RUNNER=1,
runner.pid for a child process that stands in for a model runner.
"""

import importlib.util
import json
import os
import socketserver
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent / "src" / "hola" / "engine" / "holaeval.py"
spec = importlib.util.spec_from_file_location("holaeval", ENGINE)
holaeval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(holaeval)

env = os.environ
VERSION = env.get("FAKE_OLLAMA_VERSION", "0.40.10")
DIGEST = env.get("FAKE_OLLAMA_DIGEST", "fakedigest")
PULL_ERROR = env.get("FAKE_OLLAMA_PULL_ERROR")
CAPABILITIES = env.get("FAKE_OLLAMA_CAPABILITIES", "completion,tools").split(",")
TOKEN_DELAY = float(env.get("FAKE_OLLAMA_TOKEN_DELAY", "0"))
STATE = Path(env.get("FAKE_OLLAMA_STATE", "."))
models = set(filter(None, env.get("FAKE_OLLAMA_HAS", "").split(",")))
lock = threading.Lock()


def record(path, body):
    with lock, open(STATE / "requests.jsonl", "a") as f:
        f.write(json.dumps({"path": path, "body": body}) + "\n")


def chat_chunks(body):
    prompt = body["messages"][-1]["content"]
    if body.get("tools"):
        return [], [{"function": {"name": "search_flights",
                                  "arguments": {"origin": "SFO", "destination": "NRT", "date": "2026-11-03"}}}]
    if holaeval.COUNT_PROMPT in prompt:
        return ["one", ", two"] * (body["options"]["num_predict"] // 2), None
    if "merge_intervals" in prompt:
        return [f"```python\n{holaeval.MERGE_OK}```"], None
    if "blue vault" in prompt:
        return ["7391-QX"], None
    return ["OK"], None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/version":
            return self.reply({"version": VERSION})
        if self.path == "/api/tags":
            return self.reply({"models": [{"name": m, "model": m, "digest": DIGEST, "size": 2000} for m in sorted(models)]})
        if self.path == "/api/ps":
            return self.reply({"models": [{"name": m, "model": m, "size": 2000, "size_vram": 2000} for m in sorted(models)]})
        self.reply({"error": "not found"}, 404)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_DELETE(self):
        body = self.body()
        record(self.path, body)
        models.discard(body.get("model"))
        self.reply({})

    def do_POST(self):
        body = self.body()
        record(self.path, body)
        if self.path == "/api/show":
            return self.reply({"capabilities": CAPABILITIES})
        if self.path == "/api/pull":
            self.send_response(200)
            self.end_headers()
            lines = [{"status": "pulling manifest"}]
            if PULL_ERROR:
                lines.append({"error": PULL_ERROR})
            else:
                lines += [{"status": "pulling 0a1b2c", "completed": 1 << 21, "total": 1 << 22},
                          {"status": "pulling 0a1b2c", "completed": 1 << 22, "total": 1 << 22}, {"status": "success"}]
                models.add(body["model"])
            for line in lines:
                self.wfile.write(json.dumps(line).encode() + b"\n")
            return
        if self.path == "/api/generate":
            return self.reply({"done": True})
        chunks, calls = chat_chunks(body)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        for chunk in chunks:
            time.sleep(TOKEN_DELAY)
            self.wfile.write(json.dumps({"message": {"role": "assistant", "content": chunk}, "done": False}).encode() + b"\n")
        if calls:
            self.wfile.write(json.dumps({"message": {"role": "assistant", "content": "", "tool_calls": calls},
                                         "done": False}).encode() + b"\n")
        n = max(len(chunks), 1)
        self.wfile.write(json.dumps({"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop",
                                     "eval_count": n, "eval_duration": n * 10_000_000,
                                     "prompt_eval_count": len(prompt_text(body)) // 4,
                                     "prompt_eval_duration": 20_000_000, "load_duration": 1_000_000}).encode() + b"\n")


def prompt_text(body):
    return body["messages"][-1]["content"]


def serve():
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "env.json").write_text(json.dumps(dict(env)))
    (STATE / "serve.pid").write_text(str(os.getpid()))
    if env.get("FAKE_OLLAMA_RUNNER") == "1":
        runner = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        (STATE / "runner.pid").write_text(str(runner.pid))
    host, port = env["OLLAMA_HOST"].rsplit(":", 1)
    Server((host, int(port)), Handler).serve_forever()


class Server(ThreadingHTTPServer):
    def server_bind(self):
        # The stock bind reverse-resolves the address, which takes ~35 s on GitHub's macOS runners.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


if __name__ == "__main__":
    if sys.argv[1:] == ["serve"]:
        serve()
    elif sys.argv[1:] in (["--version"], ["-v"]):
        print(f"Warning: could not connect to a running Ollama instance\nWarning: client version is {VERSION}")
    else:
        sys.exit(f"fake ollama: unsupported {sys.argv[1:]}")
