"""Shared test setup: puts src/ on the path and locates the repo's parity fixtures."""

import http.server
import socketserver
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent


def _bind_without_fqdn(server):
    socketserver.TCPServer.server_bind(server)
    server.server_name, server.server_port = server.server_address[:2]


# HTTPServer reverse-resolves its address on bind, which takes ~35 s on GitHub's macOS runners.
http.server.HTTPServer.server_bind = _bind_without_fqdn
sys.path.insert(0, str(PACKAGE / "src"))
REPO = PACKAGE.parent.parent
PARITY = REPO / "runtime" / "api-server" / "src" / "__fixtures__" / "parity"

import json
import os
import socket
import stat
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAKE_OLLAMA = Path(__file__).resolve().parent / "fake_ollama.py"
SUBJECT = {
    "type": "model", "id": "openbmb-minicpm5-2b", "name": "MiniCPM5-2B", "vendor": "OpenBMB", "quant": "Q4_K_M",
    "download_bytes": 1561319547, "min_memory_gb": 8,
    "ollama": {"tag": "m:q4", "known_digests": ["fakedigest"]},
    "sampling": {"temperature": 0.7, "top_p": 0.8}, "suites": ["suite-standard@1.0"],
}
SMALL_MACHINE = {"cpu": "Test CPU", "memory_gb": 64}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def fake_binary(directory):
    """An executable named ollama that runs fake_ollama.py; its command line names it, as a real binary's does."""
    path = Path(directory) / "ollama"
    path.write_text(f"#!{sys.executable}\nimport runpy, sys\nsys.argv[0] = {str(FAKE_OLLAMA)!r}\n"
                    f"runpy.run_path({str(FAKE_OLLAMA)!r}, run_name='__main__')\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


class Sandbox:
    """A temp HOLA_HOME, a fake ollama binary and a free private port; env carries FAKE_OLLAMA_* knobs."""

    def __init__(self, **knobs):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.binary = fake_binary(self.dir)
        self.port = free_port()
        self.state = self.dir / "fake-state"
        self.env = {"PATH": os.environ.get("PATH", ""), "HOME": str(self.dir), "HOLA_HOME": str(self.dir / "hola"),
                    "HOLA_OLLAMA_BIN": self.binary, "HOLA_OLLAMA_PORT": str(self.port),
                    "HOLA_HUB": "http://127.0.0.1:9", "HOLA_API": "http://127.0.0.1:9",
                    "OLLAMA_HOST": f"127.0.0.1:{free_port()}", "FAKE_OLLAMA_STATE": str(self.state)}
        self.env.update({f"FAKE_OLLAMA_{k.upper()}": str(v) for k, v in knobs.items()})

    def requests(self):
        file = self.state / "requests.jsonl"
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def close(self):
        self.tmp.cleanup()


class UserOllama:
    """The user's own Ollama: /api/ps lists `loaded`, /api/generate records unloads."""

    def __init__(self, loaded):
        self.loaded = list(loaded)
        self.unloaded = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def send(self, obj):
                data = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self.send({"models": [{"name": n, "size_vram": 5_000_000_000} for n in outer.loaded]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.unloaded.append(body["model"])
                outer.loaded.remove(body["model"])
                self.send({"done": True})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
