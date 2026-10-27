"""The private Ollama instance a run measures on: a port of runtime/api-server/src/ollama-instance.ts.

This module starts, stops and gives evidence; holaeval `bench` invokes and meters.
"""

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from hola import pinned
from hola.errors import HolaError

OLLAMA_DOWNLOAD_URL = "https://ollama.com/download"
OLLAMA_USER_BASE_URL = "http://127.0.0.1:11434"
READY_TIMEOUT_S = 30
STOP_TIMEOUT_S = 5
PULL_IDLE_TIMEOUT_S = 300
PID_FILE = "ollama-bench.json"
LOG_TAIL_BYTES = 4000

# Loopback calls never go through the user's proxy, which on macOS urllib would otherwise read from the system.
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def local_request(url, payload=None, timeout=5, method=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"))
    req.add_header("Content-Type", "application/json")
    return _LOCAL.open(req, timeout=timeout)


def local_json(url, payload=None, timeout=5, method=None):
    with local_request(url, payload, timeout, method) as response:
        return json.loads(response.read() or b"null")


def pinned_env():
    return dict(pinned.conditions()["ollama_env"])


def default_port(env=None):
    env = os.environ if env is None else env
    override = env.get("HOLA_OLLAMA_PORT", "").strip()
    return int(override) if override.isdigit() else pinned.conditions()["private_port"]


def binary_candidates(platform=None, env=None, home=None):
    platform = sys.platform if platform is None else platform
    env = os.environ if env is None else env
    home = str(Path.home()) if home is None else str(home)
    if platform == "darwin":
        return [
            "/Applications/Ollama.app/Contents/Resources/ollama",
            os.path.join(home, "Applications/Ollama.app/Contents/Resources/ollama"),
            "/opt/homebrew/bin/ollama",
            "/usr/local/bin/ollama",
        ]
    if platform == "win32":
        local_app_data = env.get("LOCALAPPDATA") or "\\".join([home, "AppData", "Local"])
        program_files = env.get("ProgramFiles") or "C:\\Program Files"
        return ["\\".join([local_app_data, "Programs", "Ollama", "ollama.exe"]),
                "\\".join([program_files, "Ollama", "ollama.exe"])]
    return ["/usr/local/bin/ollama", "/usr/bin/ollama", "/snap/bin/ollama"]


def find_binary(candidates=None, exists=os.path.isfile, which=shutil.which, env=None):
    """The official install locations first, then PATH, which a terminal (unlike a Dock app) can rely on."""
    env = os.environ if env is None else env
    if env.get("HOLA_OLLAMA_BIN"):
        return env["HOLA_OLLAMA_BIN"] if exists(env["HOLA_OLLAMA_BIN"]) else None
    for candidate in binary_candidates() if candidates is None else candidates:
        if exists(candidate):
            return candidate
    return which("ollama")


def default_models_dir(env=None, home=None):
    env = os.environ if env is None else env
    home = Path.home() if home is None else Path(home)
    return (env.get("OLLAMA_MODELS") or "").strip() or str(home / ".ollama" / "models")


def compare_versions(a, b):
    """Dotted numeric versions; a pre-release suffix sorts before its release."""
    def parse(value):
        value = value.strip()
        value = value[1:] if value.startswith("v") else value
        core, *rest = value.split("-")
        parts = [int(m.group()) if (m := re.match(r"\d+", part)) else 0 for part in core.split(".")]
        return parts, (rest[0] if rest else None)

    (left, left_pre), (right, right_pre) = parse(a), parse(b)
    for i in range(max(len(left), len(right))):
        diff = (left[i] if i < len(left) else 0) - (right[i] if i < len(right) else 0)
        if diff:
            return 1 if diff > 0 else -1
    if left_pre == right_pre:
        return 0
    if left_pre is None:
        return 1
    if right_pre is None:
        return -1
    return -1 if left_pre < right_pre else 1


def parse_scutil_proxy(text):
    """`scutil --proxy` output → the HTTPS proxy macOS routes through, if enabled."""
    def field(name):
        m = re.search(rf"^\s*{name}\s*:\s*(\S+)", text, re.M)
        return m.group(1) if m else None
    if field("HTTPSEnable") != "1":
        return None
    host, port = field("HTTPSProxy"), field("HTTPSPort")
    return f"http://{host}{':' + port if port else ''}" if host else None


def parse_windows_proxy(text):
    """`reg query …\\Internet Settings` output → the proxy Windows routes HTTPS through, if enabled."""
    def field(name):
        m = re.search(rf"^\s*{name}\s+REG_\w+\s+(.+?)\s*$", text, re.M)
        return m.group(1) if m else None
    if not re.match(r"^0x0*1$", field("ProxyEnable") or "", re.I):
        return None
    server = field("ProxyServer")
    if not server:
        return None
    if "=" in server:
        https = next((part for part in server.split(";") if part.strip().startswith("https=")), None)
        address = https.split("=")[1].strip() if https else ""
    else:
        address = server.strip()
    if not address:
        return None
    return address if re.match(r"^[a-z]+://", address, re.I) else f"http://{address}"


def system_https_proxy(platform=None):
    """The OS-level HTTPS proxy; on Linux the environment already is the system proxy."""
    platform = sys.platform if platform is None else platform
    try:
        if platform == "darwin":
            out = subprocess.run(["scutil", "--proxy"], capture_output=True, text=True, timeout=3).stdout
            return parse_scutil_proxy(out or "")
        if platform == "win32":
            key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
            out = subprocess.run(["reg", "query", key], capture_output=True, text=True, timeout=3).stdout
            return parse_windows_proxy(out or "")
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def bench_env(base_env, port, models_dir, proxy=None):
    env = {key: value for key, value in base_env.items() if not key.startswith("OLLAMA_")}
    has_proxy = any(key.lower() == "https_proxy" for key in env)
    if proxy and not has_proxy:
        env["HTTPS_PROXY"] = proxy
    env.update(pinned_env())
    env["OLLAMA_HOST"] = f"127.0.0.1:{port}"
    env["OLLAMA_MODELS"] = models_dir
    return env


def binary_version(binary):
    """`ollama --version` without talking to any server: the client version it was built as."""
    env = dict(os.environ, OLLAMA_HOST="127.0.0.1:9")
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    found = re.findall(r"version is (\S+)", (out.stdout or "") + (out.stderr or ""))
    return found[-1] if found else None


def port_bindable(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if os.name == "posix":
            # Ollama's listener reuses a port in TIME_WAIT, so the last run's closed connections must not count.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def server_version(base_url, timeout=1):
    try:
        body = local_json(f"{base_url}/api/version", timeout=timeout)
    except (OSError, ValueError):
        return None
    version = body.get("version") if isinstance(body, dict) else None
    return version if isinstance(version, str) else None


def pid_alive(pid):
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True)
        return str(pid) in (out.stdout or "")
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def kill_tree(pid, sig=signal.SIGTERM):
    """The server and its model runners: the instance leads its own process group (a job tree on Windows)."""
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/pid", str(pid), "/T", "/F"], capture_output=True)
        return
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def pull_failure(model, reason):
    message = f"Pulling {model} failed: {reason}."
    if "resolves to non-public" in reason:
        hint = ("Your proxy resolves the download host to a private address (fake-ip mode). Turn on your proxy's "
                "system proxy, or set its DNS mode to real IP, then try again.")
    elif "proxyconnect" in reason:
        hint = "Ollama couldn't reach your proxy. Start the proxy or unset HTTPS_PROXY, then try again."
    elif re.search(r"no such host|network is unreachable|i/o timeout|connection refused|connection reset|"
                   r"TLS handshake timeout|dial tcp|server misbehaving", reason, re.I):
        hint = "This machine can't reach the Ollama registry. Check your internet connection, then run this again."
    elif re.search(r"file does not exist|manifest unknown|not found", reason, re.I):
        hint = "The Ollama registry doesn't have this tag. Run `hola list` for the current models."
    else:
        hint = "Run this again. If it keeps failing, `hola doctor` checks your setup."
    return HolaError("pull_failed", message, hint)


class OllamaInstance:
    def __init__(self, binary, state_dir, port, *, env=None, home=None, system_proxy=system_https_proxy, log_path=None):
        self.binary = binary
        self.state_dir = Path(state_dir)
        self.port = port
        self.env = os.environ if env is None else env
        self.home = home
        self.system_proxy = system_proxy
        self.log_path = Path(log_path) if log_path else self.state_dir / "ollama-serve.log"
        self.proc = None
        self.version = None

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.port}"

    @property
    def pid(self):
        return self.proc.pid if self.proc else None

    @property
    def pid_file(self):
        return self.state_dir / PID_FILE

    def start(self):
        if server_version(self.base_url) is not None:
            raise HolaError("busy", f"Another Ollama is already running on port {self.port}, probably a benchmark "
                                    "started elsewhere (holaOS or another hola eval).",
                            "Wait for it to finish, then run this again.")
        if not port_bindable(self.port):
            raise HolaError("start_failed", f"Port {self.port} is in use by another program.",
                            "Free the port, or choose another one with HOLA_OLLAMA_PORT.")
        env = bench_env(self.env, self.port, default_models_dir(self.env, self.home), self.system_proxy())
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        kwargs = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32"
                  else {"start_new_session": True})
        with open(self.log_path, "wb") as log:
            self.proc = subprocess.Popen([self.binary, "serve"], env=env, stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=log, **kwargs)
        self.pid_file.write_text(json.dumps({
            "pid": self.proc.pid, "port": self.port,
            "started_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"}))
        deadline = time.monotonic() + READY_TIMEOUT_S
        while time.monotonic() < deadline and self.proc.poll() is None:
            version = server_version(self.base_url)
            if version:
                self.version = version
                return version
            time.sleep(0.2)
        self.stop()
        tail = " ".join(self.log_tail().strip().splitlines()[-3:])
        raise HolaError("start_failed", f"Ollama did not start{': ' + tail if tail else '.'}",
                        "Run `hola doctor` to check your Ollama install.")

    def log_tail(self):
        try:
            data = self.log_path.read_bytes()[-LOG_TAIL_BYTES:]
        except OSError:
            return ""
        return data.decode("utf-8", "replace")

    def assert_min_version(self, min_version):
        if self.version and compare_versions(self.version, min_version) < 0:
            raise HolaError("ollama_too_old",
                            f"Ollama {self.version} is older than {min_version}, the minimum for this benchmark.",
                            f"Update Ollama from {OLLAMA_DOWNLOAD_URL}, then run this again.",
                            {"version": self.version, "min_version": min_version, "download_url": OLLAMA_DOWNLOAD_URL})

    def pull(self, model, on_progress=None):
        try:
            response = local_request(f"{self.base_url}/api/pull", {"model": model, "stream": True},
                                     timeout=PULL_IDLE_TIMEOUT_S)
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", "replace")
            try:
                text = json.loads(text).get("error") or text
            except (ValueError, AttributeError):
                pass
            raise pull_failure(model, f"HTTP {exc.code} {text}".strip()) from None
        except OSError as exc:
            raise pull_failure(model, str(exc)) from None
        failure = None
        succeeded = False
        with response:
            for raw in response:
                line = raw.strip()
                if not line:
                    continue
                event = json.loads(line)
                if isinstance(event.get("error"), str):
                    failure = event["error"]
                    continue
                status = str(event.get("status", ""))
                succeeded = succeeded or status == "success"
                if on_progress:
                    on_progress({"status": status,
                                 **{k: event[k] for k in ("completed", "total") if isinstance(event.get(k), int)}})
        if failure or not succeeded:
            raise pull_failure(model, failure or "the download ended early")

    def _tags(self):
        body = local_json(f"{self.base_url}/api/tags", timeout=10)
        return body.get("models") or [] if isinstance(body, dict) else []

    def digest(self, model):
        entry = next((m for m in self._tags() if m.get("name") == model or m.get("model") == model), None)
        return entry.get("digest") if entry else None

    def has_model(self, model):
        return self.digest(model) is not None

    def delete(self, model):
        with local_request(f"{self.base_url}/api/delete", {"model": model}, timeout=30, method="DELETE"):
            pass

    def evidence(self):
        return {"kind": "local", "provider": {"engine": "ollama", "version": self.version, "env": pinned_env(),
                                              "flash_attention": pinned.conditions()["flash_attention"], "managed": True}}

    def stop(self):
        proc, self.proc = self.proc, None
        if proc is not None:
            if proc.poll() is None:
                kill_tree(proc.pid)
                try:
                    proc.wait(STOP_TIMEOUT_S)
                except (subprocess.TimeoutExpired, KeyboardInterrupt):
                    kill_tree(proc.pid, getattr(signal, "SIGKILL", signal.SIGTERM))
                    proc.wait()
            if sys.platform != "win32":
                # A runner that outlived the server is still in the group.
                kill_tree(proc.pid, signal.SIGKILL)
        try:
            self.pid_file.unlink()
        except FileNotFoundError:
            pass


class ExternalOllama:
    """`--ollama-url`: someone's own server. Its conditions are unknown, so its runs stay local."""

    def __init__(self, base_url):
        self.base_url = base_url.strip().rstrip("/")
        self.base_url = self.base_url if re.match(r"^https?://", self.base_url) else "http://" + self.base_url
        self.pid = None
        self.version = None

    def start(self):
        self.version = server_version(self.base_url, timeout=5)
        if self.version is None:
            raise HolaError("start_failed", f"No Ollama answered at {self.base_url}.",
                            "Check the address, or drop --ollama-url to let hola start its own instance.")
        return self.version

    assert_min_version = OllamaInstance.assert_min_version
    pull = OllamaInstance.pull
    _tags = OllamaInstance._tags
    digest = OllamaInstance.digest
    has_model = OllamaInstance.has_model
    delete = OllamaInstance.delete

    def evidence(self):
        return {"kind": "local", "provider": {"engine": "ollama", "version": self.version, "env": {},
                                              "flash_attention": None, "managed": False}}

    def stop(self):
        pass


def cleanup_orphan(state_dir):
    """Kills a bench instance left behind by a crash, but only if it still answers as Ollama on its recorded port."""
    file = Path(state_dir) / PID_FILE
    try:
        record = json.loads(file.read_text())
    except (OSError, ValueError):
        return False
    file.unlink(missing_ok=True)
    pid, port = record.get("pid"), record.get("port")
    if not isinstance(pid, int) or not isinstance(port, int) or not pid_alive(pid):
        return False
    if server_version(f"http://127.0.0.1:{port}") is None:
        return False
    kill_tree(pid)
    deadline = time.monotonic() + STOP_TIMEOUT_S
    while time.monotonic() < deadline and server_version(f"http://127.0.0.1:{port}") is not None:
        time.sleep(0.2)
    if server_version(f"http://127.0.0.1:{port}") is not None:
        kill_tree(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
    return True


def user_base_url(env=None):
    """The user's own server: OLLAMA_HOST when they set one, else Ollama's default port."""
    env = os.environ if env is None else env
    host = (env.get("OLLAMA_HOST") or "").strip()
    if not host:
        return OLLAMA_USER_BASE_URL
    host = re.sub(r"^https?://", "", host).rstrip("/")
    name, _, port = host.rpartition(":") if ":" in host else (host, "", "11434")
    name = "127.0.0.1" if name in ("", "0.0.0.0", "localhost") else name
    return f"http://{name}:{port or '11434'}"


def user_loaded_models(base_url=OLLAMA_USER_BASE_URL):
    """Models the user's own Ollama has in memory; they compete with the bench for (V)RAM."""
    try:
        body = local_json(f"{base_url}/api/ps", timeout=1)
    except (OSError, ValueError):
        return []
    models = body.get("models") if isinstance(body, dict) else None
    return [{"name": m["name"], "size_vram": m.get("size_vram") if isinstance(m.get("size_vram"), int) else None}
            for m in models or [] if isinstance(m, dict) and isinstance(m.get("name"), str)]


def unload_user_model(name, base_url=OLLAMA_USER_BASE_URL):
    with local_request(f"{base_url}/api/generate", {"model": name, "keep_alive": 0}, timeout=30):
        pass
