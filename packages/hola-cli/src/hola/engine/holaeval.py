#!/usr/bin/env python3
"""Evaluate an OpenAI-compatible model server that is already running.

Subcommands: probe, speed, run, bench, agent, tables, chart, selftest. Standard library only.
bench talks to Ollama's native API instead, because /v1 cannot set the context size.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import platform
import random
import re
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HOLAEVAL_VERSION = "1.1.0"
HERE = Path(__file__).resolve().parent
DEFAULT_PACK = HERE / "packs" / "general-v1.json"
OTHER_VENDORS = {
    "openai": ["openai", "chatgpt", "gpt-4", "gpt-5"],
    "anthropic": ["anthropic", "claude"],
    "google": ["google", "gemini", "gemma"],
    "deepseek": ["deepseek"],
    "alibaba": ["qwen", "alibaba", "通义", "阿里"],
    "meta": ["meta ai", "llama"],
    "mistral": ["mistral"],
    "moonshot": ["moonshot", "kimi"],
    "zhipu": ["zhipu", "chatglm", "智谱"],
    "minimax": ["minimax"],
    "modelbest": ["minicpm", "openbmb", "modelbest", "面壁"],
}


# ---------- HTTP ----------

def normalize_base(url):
    url = url.strip().rstrip("/")
    if not re.match(r"^https?://", url):
        url = "http://" + url
    if not re.search(r"/v\d+$", url):
        url += "/v1"
    return url


def server_root(base):
    return re.sub(r"/v\d+$", "", base)


def http_json(url, payload=None, timeout=10, method=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + os.environ.get("HOLAEVAL_API_KEY", "local"))
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def try_json(url, payload=None, timeout=3, method=None):
    try:
        return http_json(url, payload, timeout=timeout, method=method)
    except Exception:
        return None


def chat(base, payload, timeout=1800):
    return http_json(base + "/chat/completions", payload, timeout=timeout)


def stream_chat(base, payload, timeout=900):
    """Return (ttft_s, total_s, n_chunks, final_usage, final_timings, text)."""
    payload = dict(payload, stream=True, stream_options={"include_usage": True})
    req = urllib.request.Request(base + "/chat/completions", data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + os.environ.get("HOLAEVAL_API_KEY", "local"))
    started = time.perf_counter()
    first = None
    last = None
    chunks = 0
    usage = None
    timings = None
    parts = []
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if body == "[DONE]":
                break
            try:
                evt = json.loads(body)
            except json.JSONDecodeError:
                continue
            if evt.get("usage"):
                usage = evt["usage"]
            if evt.get("timings"):
                timings = evt["timings"]
            for choice in evt.get("choices") or []:
                delta = choice.get("delta") or {}
                piece = (delta.get("content") or "") + (delta.get("reasoning_content") or delta.get("reasoning") or "")
                if piece:
                    now = time.perf_counter()
                    if first is None:
                        first = now
                    last = now
                    chunks += 1
                    parts.append(piece)
    end = last or time.perf_counter()
    return (first - started if first else None), end - started, chunks, usage, timings, "".join(parts), (end - first if first else None)


# ---------- probe ----------

def detect(base):
    root = server_root(base)
    info = {"base_url": base, "engine": "openai_compatible", "engine_version": None, "models": []}
    props = try_json(root + "/props")
    ollama_ver = try_json(root + "/api/version")
    lms = try_json(root + "/api/v0/models")
    vllm_ver = try_json(root + "/version")
    sglang = try_json(root + "/get_model_info")
    models = try_json(base + "/models") or {}
    ids = [m.get("id") for m in models.get("data", []) if isinstance(m, dict) and m.get("id")]
    if isinstance(ollama_ver, dict) and "version" in ollama_ver:
        info["engine"], info["engine_version"] = "ollama", ollama_ver["version"]
        tags = try_json(root + "/api/tags") or {}
        for m in tags.get("models", []):
            entry = {"id": m.get("name"), "digest": m.get("digest"), "size_bytes": m.get("size"),
                     "quantization": (m.get("details") or {}).get("quantization_level")}
            show = try_json(root + "/api/show", {"model": m.get("name")}, timeout=5) or {}
            for k, v in (show.get("model_info") or {}).items():
                if k.endswith(".context_length"):
                    entry["context_window"] = v
            entry["supports_vision"] = "vision" in (show.get("capabilities") or [])
            info["models"].append(entry)
        running = try_json(root + "/api/ps") or {}
        info["loaded"] = [{"id": m.get("name"), "context_length": m.get("context_length")} for m in running.get("models", [])]
    elif isinstance(props, dict) and ("default_generation_settings" in props or "n_ctx" in props or "build_info" in props):
        info["engine"] = "llamacpp"
        info["engine_version"] = props.get("build_info")
        gen = props.get("default_generation_settings") or {}
        n_ctx = gen.get("n_ctx") or props.get("n_ctx")
        info["server_props"] = {k: props.get(k) for k in ("model_path", "total_slots", "chat_template_caps") if k in props}
        info["server_defaults"] = {k: (gen.get("params") or gen).get(k) for k in ("temperature", "top_p", "top_k", "min_p", "n_predict") if k in (gen.get("params") or gen)}
        for mid in ids or [Path(props.get("model_path", "model")).name]:
            info["models"].append({"id": Path(mid).stem if mid.endswith(".gguf") else mid, "context_window": n_ctx})
    elif isinstance(lms, dict) and isinstance(lms.get("data"), list):
        info["engine"] = "lmstudio"
        for m in lms["data"]:
            if m.get("type") == "embeddings":
                continue
            info["models"].append({"id": m.get("id"), "context_window": m.get("loaded_context_length") or m.get("max_context_length"),
                                   "loaded": m.get("state") == "loaded", "supports_vision": m.get("type") == "vlm",
                                   "quantization": m.get("quantization")})
    elif isinstance(sglang, dict) and sglang.get("model_path"):
        info["engine"] = "sglang"
        for mid in ids:
            info["models"].append({"id": mid})
    elif isinstance(vllm_ver, dict) and vllm_ver.get("version"):
        info["engine"], info["engine_version"] = "vllm", vllm_ver["version"]
        for m in models.get("data", []):
            info["models"].append({"id": m.get("id"), "context_window": m.get("max_model_len")})
    else:
        for mid in ids:
            info["models"].append({"id": mid})
    return info


def machine_info():
    info = {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version()}
    if sys.platform == "darwin":
        def sysctl(key):
            try:
                return subprocess.run(["sysctl", "-n", key], capture_output=True, text=True, timeout=5).stdout.strip()
            except Exception:
                return None
        info["cpu"] = sysctl("machdep.cpu.brand_string")
        info["model"] = sysctl("hw.model")
        mem = sysctl("hw.memsize")
        info["memory_gb"] = round(int(mem) / 2**30) if mem and mem.isdigit() else None
        try:
            batt = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=5).stdout
            info["power"] = "AC" if "AC Power" in batt else ("battery" if "Battery Power" in batt else None)
        except Exception:
            pass
    elif sys.platform.startswith("linux"):
        try:
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal"):
                    info["memory_gb"] = round(int(line.split()[1]) / 2**20)
            cpu = [l for l in Path("/proc/cpuinfo").read_text().splitlines() if l.startswith("model name")]
            info["cpu"] = cpu[0].split(":", 1)[1].strip() if cpu else None
        except Exception:
            pass
        if shutil.which("nvidia-smi"):
            out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True)
            info["gpus"] = [g.strip() for g in out.stdout.splitlines() if g.strip()]
    elif sys.platform == "win32":
        info.update(windows_machine_info())
    return info


def windows_machine_info():
    import ctypes
    import winreg

    info = {}
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
            info["cpu"] = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
    except OSError:
        pass

    class MemoryStatus(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    class PowerStatus(ctypes.Structure):
        _fields_ = [("ACLineStatus", ctypes.c_byte), ("BatteryFlag", ctypes.c_byte), ("BatteryLifePercent", ctypes.c_byte),
                    ("SystemStatusFlag", ctypes.c_byte), ("BatteryLifeTime", ctypes.c_ulong), ("BatteryFullLifeTime", ctypes.c_ulong)]

    try:
        mem = MemoryStatus()
        mem.dwLength = ctypes.sizeof(MemoryStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(mem)):
            info["memory_gb"] = round(mem.ullTotalPhys / 2**30)
        power = PowerStatus()
        if ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(power)):
            info["power"] = {1: "AC", 0: "battery"}.get(power.ACLineStatus)
    except (AttributeError, OSError):
        pass
    # AdapterRAM in WMI is 32-bit and caps at 4 GB; the driver's qwMemorySize is the real figure.
    gpus = []
    display_class = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, display_class) as cls:
            for i in range(winreg.QueryInfoKey(cls)[0]):
                sub = winreg.EnumKey(cls, i)
                if not sub.isdigit():
                    continue
                try:
                    with winreg.OpenKey(cls, sub) as key:
                        name = winreg.QueryValueEx(key, "DriverDesc")[0]
                        vram = None
                        for value in ("HardwareInformation.qwMemorySize", "HardwareInformation.MemorySize"):
                            try:
                                raw = winreg.QueryValueEx(key, value)[0]
                                vram = int.from_bytes(raw, "little") if isinstance(raw, bytes) else int(raw)
                                break
                            except OSError:
                                continue
                except OSError:
                    continue
                if "Microsoft Basic" in name or "Remote Display" in name:
                    continue
                gpus.append(f"{name}, {round(vram / 2**20)} MiB" if vram else name)
    except OSError:
        pass
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                                 capture_output=True, text=True, timeout=10)
            nvidia = [g.strip() for g in out.stdout.splitlines() if g.strip()]
            gpus = nvidia + [g for g in gpus if "NVIDIA" not in g]
        except (OSError, subprocess.TimeoutExpired):
            pass
    if gpus:
        info["gpus"] = gpus
    return info


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def cmd_probe(args):
    base = normalize_base(args.base_url)
    info = detect(base)
    if args.model:
        found = [m for m in info["models"] if m["id"] == args.model]
        if not found and info["models"]:
            info["warning"] = f"model {args.model!r} not listed by server; listed: {[m['id'] for m in info['models']]}"
        model = args.model
    else:
        model = info["models"][0]["id"] if info["models"] else None
    info["selected_model"] = model
    if model:
        try:
            t0 = time.perf_counter()
            resp = chat(base, {"model": model, "messages": [{"role": "user", "content": "Reply with OK."}], "max_tokens": 512, "temperature": 0}, timeout=180)
            info["smoke"] = {"ok": True, "seconds": round(time.perf_counter() - t0, 2),
                             "returns_reasoning": bool((resp["choices"][0]["message"].get("reasoning_content"))),
                             "finish_reason": resp["choices"][0].get("finish_reason")}
        except Exception as exc:
            info["smoke"] = {"ok": False, "error": repr(exc)}
    model_path = (info.get("server_props") or {}).get("model_path")
    if args.hash_model_file and model_path and Path(model_path).is_file():
        info["model_file_sha256"] = sha256_file(model_path)
    info["machine"] = machine_info()
    info["probed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "manifest.json").write_text(json.dumps(info, indent=2, ensure_ascii=False))
    print(json.dumps(info, indent=2, ensure_ascii=False))


# ---------- graders ----------

def boxed_int(text):
    hits = re.findall(r"\\boxed\{\s*([-\d,\.]+)\s*\}", text)
    if not hits:
        return None
    try:
        return int(float(hits[-1].replace(",", "")))
    except ValueError:
        return None


def code_block(text):
    blocks = re.findall(r"```(?:python|py)?\s*\n(.*?)```", text, re.S)
    return blocks[-1] if blocks else text


def run_python_tests(code, tests, timeout=10):
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "solution.py"
        path.write_text(code + "\n\n" + tests + "\nprint('ALL_PASS')\n")
        try:
            out = subprocess.run([sys.executable, "-I", str(path)], cwd=d, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return False, "tests timed out"
        if out.returncode == 0 and "ALL_PASS" in out.stdout:
            return True, None
        err = (out.stderr.strip().splitlines() or ["no output"])[-1]
        return False, f"tests failed: {err[:160]}"


def check_rules(text, rules):
    t = text.strip()
    lines = [l for l in t.splitlines() if l.strip()]
    for rule in rules:
        if "lines_exact" in rule and len(lines) != rule["lines_exact"]:
            return False, f"expected {rule['lines_exact']} lines, got {len(lines)}"
        if "each_line_startswith" in rule and not all(l.startswith(rule["each_line_startswith"]) for l in lines):
            return False, f"a line does not start with {rule['each_line_startswith']!r}"
        if "max_words" in rule and len(t.split()) >= rule["max_words"]:
            return False, f"{len(t.split())} words, limit < {rule['max_words']}"
        if "max_chars" in rule and len(t) > rule["max_chars"]:
            return False, f"{len(t)} chars, limit {rule['max_chars']}"
        if "must_include" in rule and rule["must_include"].lower() not in t.lower():
            return False, f"missing {rule['must_include']!r}"
        if "ends_with" in rule and not t.endswith(rule["ends_with"]):
            return False, f"does not end with {rule['ends_with']!r}"
        if rule.get("no_latin") and re.search(r"[A-Za-z]", t):
            return False, "contains latin letters"
        if rule.get("single_line") and "\n" in t:
            return False, "more than one line"
    return True, None


def check_json(text, spec):
    raw = text.strip()
    if spec.get("no_fence") and raw.startswith("```"):
        return False, "wrapped in a code fence"
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return False, "not valid JSON"
    if not isinstance(obj, dict):
        return False, "not a JSON object"
    if "keys_exact" in spec and set(obj) != set(spec["keys_exact"]):
        return False, f"keys {sorted(obj)} != {sorted(spec['keys_exact'])}"
    for key, n in (spec.get("array_len") or {}).items():
        if not isinstance(obj.get(key), list) or len(obj[key]) != n:
            return False, f"{key} must be an array of {n}"
    for key in spec.get("lowercase_array") or []:
        if not all(isinstance(v, str) and v == v.lower() for v in obj.get(key) or []):
            return False, f"{key} must be lowercase strings"
    return True, None


def first_tool_call(resp):
    calls = resp.get("tool_calls") or []
    if not calls:
        return None, None
    fn = calls[0].get("function") or {}
    args = fn.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {"_raw": args}
    return fn.get("name"), args or {}


def check_tool_call(resp, spec):
    name, args = first_tool_call(resp)
    if name is None:
        return False, "no tool call"
    if name != spec["name"]:
        return False, f"called {name} instead of {spec['name']}"
    for key, cond in (spec.get("args") or {}).items():
        value = args.get(key)
        sval = "" if value is None else str(value)
        if "equals" in cond and value != cond["equals"]:
            return False, f"{key}={value!r}, expected {cond['equals']!r}"
        if "equals_ci" in cond and sval.lower() != str(cond["equals_ci"]).lower():
            return False, f"{key}={value!r}, expected {cond['equals_ci']!r}"
        if "contains_ci" in cond and str(cond["contains_ci"]).lower() not in sval.lower():
            return False, f"{key}={value!r} should contain {cond['contains_ci']!r}"
        if "one_of_ci" in cond and sval.lower() not in [c.lower() for c in cond["one_of_ci"]]:
            return False, f"{key}={value!r} not in {cond['one_of_ci']}"
    return True, None


def identity_lists(own):
    own_l = [k.lower() for k in own]
    others = []
    for keywords in OTHER_VENDORS.values():
        if any(k in own_l or any(k in o or o in k for o in own_l) for k in keywords):
            continue
        others.extend(keywords)
    return own_l, others


def check_identity(text, own):
    own_l, others = identity_lists(own)
    t = text.lower()
    claimed = [k for k in others if k in t]
    if claimed:
        return False, f"claims another vendor: {claimed[0]}"
    if not any(k in t for k in own_l):
        return False, "does not name its own model/vendor"
    return True, None


def grade(task, resp, ctx):
    g = task["grader"]
    kind = g["type"]
    text = resp.get("content") or ""
    if resp.get("finish_reason") == "length" and kind not in ("tool_call", "no_tool_call") and not text.strip():
        return False, "ran out of tokens before answering"
    if kind == "boxed_int":
        got = boxed_int(text)
        return (got == g["answer"], None if got == g["answer"] else ("no \\boxed{} answer" if got is None else f"answered {got}, expected {g['answer']}"))
    if kind == "python_tests":
        return run_python_tests(code_block(text), g["tests"])
    if kind == "rules":
        return check_rules(text, g["rules"])
    if kind == "json_object":
        return check_json(text, g)
    if kind == "tool_call":
        return check_tool_call(resp, g)
    if kind == "no_tool_call":
        if resp.get("tool_calls"):
            return False, "called a tool when none was needed"
        ok = g.get("content_contains", "") in text
        return ok, None if ok else f"answer missing {g.get('content_contains')!r}"
    if kind == "contains":
        ok = g["value"] in text
        if ok:
            return True, None
        if resp.get("prompt_truncated"):
            return False, "prompt was truncated by the server context window"
        return False, f"answer missing {g['value']!r}"
    if kind == "identity":
        return check_identity(text, ctx["identity"])
    raise ValueError(f"unknown grader {kind}")


# ---------- tasks ----------

FILLER = [
    "The archive committee met on a Tuesday to review the shelving plan for the east wing.",
    "Several volunteers noted that the reading room lamps flicker when the heating turns on.",
    "A delivery of oak boards arrived late because the truck took the river road.",
    "The catalogue lists maps, letters, and ledgers from three neighbouring towns.",
    "Visitors are asked to sign the guest book and leave umbrellas by the door.",
    "An old clock in the hallway runs four minutes fast and nobody has fixed it.",
    "The gardener planted lavender along the path that leads to the side entrance.",
    "Most requests for photocopies are handled within two working days.",
]


def filler_text(approx_tokens, seed):
    rng = random.Random(seed)
    sentences = []
    while len(" ".join(sentences)) / 4.2 < approx_tokens:
        sentences.append(rng.choice(FILLER))
    return sentences


def build_messages(task):
    messages = []
    if task.get("system"):
        messages.append({"role": "system", "content": task["system"]})
    prompt = task["prompt"]
    hay = task.get("haystack")
    if hay:
        sentences = filler_text(hay["approx_tokens"], hay.get("seed", hay["approx_tokens"]))
        sentences.insert(int(len(sentences) * hay.get("depth", 0.5)), hay["needle"])
        prompt = " ".join(sentences) + "\n\n" + prompt
    messages.append({"role": "user", "content": prompt})
    return messages


def load_pack(path):
    pack = json.loads(Path(path).read_text())
    for t in pack["tasks"]:
        t.setdefault("category", "general")
    return pack


def run_one(base, model, task, sample, sampling, ctx):
    payload = {"model": model, "messages": build_messages(task), "max_tokens": task.get("max_tokens", 6000), **sampling}
    if task.get("tools"):
        payload["tools"] = task["tools"]
    if ctx["engine"] == "llamacpp":
        payload["cache_prompt"] = False
    started = time.time()
    rec = {"id": task["id"], "category": task["category"], "sample": sample}
    try:
        data = chat(base, payload)
        choice = data["choices"][0]
        msg = choice.get("message") or {}
        usage = data.get("usage") or {}
        resp = {
            "content": msg.get("content") or "",
            "reasoning": msg.get("reasoning_content") or msg.get("reasoning") or "",
            "tool_calls": msg.get("tool_calls"),
            "finish_reason": choice.get("finish_reason"),
            "usage": usage,
            "timings": data.get("timings"),
        }
        hay = task.get("haystack")
        if hay and usage.get("prompt_tokens") and usage["prompt_tokens"] < 0.7 * hay["approx_tokens"]:
            resp["prompt_truncated"] = True
        passed, reason = grade(task, resp, ctx)
        rec.update(resp, passed=bool(passed), reason=reason, error=None)
    except Exception as exc:
        rec.update(passed=False, reason="request failed", error=repr(exc))
    rec["seconds"] = round(time.time() - started, 1)
    return rec


def cmd_run(args):
    base = normalize_base(args.base_url)
    pack = load_pack(args.pack)
    info = detect(base)
    model = args.model or (info["models"][0]["id"] if info["models"] else None)
    if not model:
        sys.exit("no model: pass --model")
    ctx_window = args.context_window or next((m.get("context_window") for m in info["models"] if m["id"] == model and m.get("context_window")), None)
    identity = [s.strip() for s in (args.identity or "").split(",") if s.strip()]
    sampling = dict(pack.get("sampling") or {})
    for key in ("temperature", "top_p", "min_p"):
        if getattr(args, key) is not None:
            sampling[key] = getattr(args, key)
    samples = args.samples or pack.get("samples", 3)
    only = [s for s in (args.only or "").split(",") if s]
    tasks, skipped = [], []
    for t in pack["tasks"]:
        if only and not any(t["id"].startswith(o) or t["category"] == o for o in only):
            continue
        if t["grader"]["type"] == "identity" and not identity:
            skipped.append({"id": t["id"], "reason": "no --identity keywords given"})
            continue
        hay = t.get("haystack")
        if hay and ctx_window and hay["approx_tokens"] * 1.15 > ctx_window:
            skipped.append({"id": t["id"], "reason": f"needs ~{hay['approx_tokens']} tokens, context window is {ctx_window}"})
            continue
        if args.quick and hay and hay["approx_tokens"] > 10000:
            skipped.append({"id": t["id"], "reason": "skipped in --quick"})
            continue
        tasks.append(t)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    label = args.label
    ctx = {"engine": info["engine"], "identity": identity}
    jobs = [(t, s) for t in tasks for s in range(samples)]
    progress = open(out / f"progress-{label}.log", "a", buffering=1)
    say = lambda msg: (print(msg, flush=True), progress.write(msg + "\n"))
    say(f"START {label} model={model} engine={info['engine']} tasks={len(tasks)} samples={samples} jobs={len(jobs)} skipped={len(skipped)}")
    results = []
    started = time.time()
    lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=args.parallel) as pool, open(out / f"tasks-{label}.jsonl", "w") as f:
        futures = [pool.submit(run_one, base, model, t, s, sampling, ctx) for t, s in jobs]
        for i, fut in enumerate(futures, 1):
            rec = fut.result()
            with lock:
                results.append(rec)
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                f.flush()
            say(f"[{i}/{len(jobs)}] {rec['id']}#{rec['sample']} {'PASS' if rec['passed'] else 'FAIL'} {rec['seconds']}s"
                + (f" ({rec['reason']})" if not rec["passed"] else ""))
    summary = {"label": label, "model": model, "base_url": base, "engine": info["engine"], "pack": pack.get("id"),
               "pack_version": pack.get("version"), "sampling": sampling, "samples": samples, "identity": identity,
               "context_window": ctx_window, "skipped": skipped, "wall_seconds": round(time.time() - started, 1),
               "by_task": {}, "by_category": {}}
    for rec in results:
        t = summary["by_task"].setdefault(rec["id"], {"category": rec["category"], "passed": 0, "n": 0, "reasons": {}, "completion_tokens": []})
        t["passed"] += rec["passed"]
        t["n"] += 1
        if not rec["passed"]:
            t["reasons"][rec["reason"] or "failed"] = t["reasons"].get(rec["reason"] or "failed", 0) + 1
        ct = (rec.get("usage") or {}).get("completion_tokens")
        if ct:
            t["completion_tokens"].append(ct)
        c = summary["by_category"].setdefault(rec["category"], {"passed": 0, "n": 0})
        c["passed"] += rec["passed"]
        c["n"] += 1
    (out / f"summary-{label}.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    say(f"DONE {label} " + " ".join(f"{k}={v['passed']}/{v['n']}" for k, v in summary["by_category"].items())
        + f" wall={summary['wall_seconds']}s")


# ---------- speed ----------

COUNT_PROMPT = "Count from one to two thousand in English words, separated by commas. Do not stop early and do not explain."


def cmd_speed(args):
    base = normalize_base(args.base_url)
    info = detect(base)
    model = args.model or (info["models"][0]["id"] if info["models"] else None)
    ctx_window = args.context_window or next((m.get("context_window") for m in info["models"] if m["id"] == model and m.get("context_window")), None)
    depths = [int(d) for d in args.depths.split(",")]
    rows = []
    for depth in depths:
        if ctx_window and depth + args.gen + 256 > ctx_window:
            rows.append({"depth": depth, "skipped": f"context window {ctx_window} too small"})
            print(json.dumps(rows[-1]), flush=True)
            continue
        runs = []
        for rep in range(args.reps + 1):
            prefix = " ".join(filler_text(depth, seed=depth * 31 + rep + int(time.time()))) + "\n\n" if depth else ""
            payload = {"model": model, "messages": [{"role": "user", "content": prefix + COUNT_PROMPT}],
                       "max_tokens": args.gen, "temperature": 0}
            if info["engine"] == "llamacpp":
                payload["cache_prompt"] = False
            ttft, total, chunks, usage, timings, _, gen_s = stream_chat(base, payload)
            if rep == 0 and args.reps > 0:
                continue
            completion = (usage or {}).get("completion_tokens") or chunks
            prompt_tokens = (usage or {}).get("prompt_tokens")
            run = {"ttft_s": round(ttft, 3) if ttft else None, "completion_tokens": completion, "prompt_tokens": prompt_tokens,
                   "decode_tps": round((completion - 1) / gen_s, 1) if gen_s and completion > 1 else None,
                   "prefill_tps": round(prompt_tokens / ttft, 1) if prompt_tokens and ttft else None}
            if timings:
                run["engine_decode_tps"] = round(timings.get("predicted_per_second") or 0, 1) or None
                run["engine_prefill_tps"] = round(timings.get("prompt_per_second") or 0, 1) or None
            runs.append(run)
        row = {"depth": depth, "runs": runs}
        for key in ("ttft_s", "decode_tps", "prefill_tps", "engine_decode_tps", "engine_prefill_tps"):
            vals = [r[key] for r in runs if r.get(key)]
            if vals:
                row[key] = round(statistics.mean(vals), 3 if key == "ttft_s" else 1)
                row[key + "_sd"] = round(statistics.pstdev(vals), 3 if key == "ttft_s" else 1)
        rows.append(row)
        print(json.dumps({k: v for k, v in row.items() if k != "runs"}), flush=True)
    conc = []
    for n in [int(x) for x in (args.concurrency or "").split(",") if x]:
        payload = {"model": model, "messages": [{"role": "user", "content": COUNT_PROMPT}], "max_tokens": args.gen, "temperature": 0}
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=n) as pool:
            outs = list(pool.map(lambda _: stream_chat(base, payload), range(n)))
        wall = time.perf_counter() - t0
        total_tokens = sum(((o[3] or {}).get("completion_tokens") or o[2]) for o in outs)
        conc.append({"concurrency": n, "aggregate_tps": round(total_tokens / wall, 1), "wall_s": round(wall, 2)})
        print(json.dumps(conc[-1]), flush=True)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"speed-{args.label}.json").write_text(json.dumps(
        {"label": args.label, "model": model, "engine": info["engine"], "base_url": base, "gen_tokens": args.gen,
         "reps": args.reps, "context_window": ctx_window, "depths": rows, "concurrency": conc}, indent=2))


# ---------- bench: one-click suite on Ollama's native API ----------

DEFAULT_SUITE = HERE / "packs" / "suite-standard-1.0.json"
BENCH_KEEP_ALIVE = "30m"
RELOAD_THRESHOLD_S = 0.5
SAMPLING_OPTIONS = ("temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty")


def ollama_post(root, path, payload, timeout):
    req = urllib.request.Request(root + path, data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read() or b"{}").get("error")
        except ValueError:
            detail = None
        raise RuntimeError(f"HTTP {exc.code}: {detail or exc.reason}") from None


def ollama_chat(root, payload, on_text=None, timeout=900):
    """Stream /api/chat. Times are client-side; the *_s engine fields come from Ollama's final chunk."""
    started = time.perf_counter()
    first = last = None
    content, thinking, tool_calls = [], [], []
    final = {}
    with ollama_post(root, "/api/chat", dict(payload, stream=True), timeout) as r:
        for raw in r:
            line = raw.strip()
            if not line:
                continue
            evt = json.loads(line)
            if evt.get("error"):
                raise RuntimeError(evt["error"])
            msg = evt.get("message") or {}
            piece = msg.get("content") or ""
            thought = msg.get("thinking") or ""
            if piece or thought or msg.get("tool_calls"):
                now = time.perf_counter()
                first = first or now
                last = now
            content.append(piece)
            thinking.append(thought)
            tool_calls.extend(msg.get("tool_calls") or [])
            if on_text and (piece or thought):
                on_text(thought + piece)
            if evt.get("done"):
                final = evt
                break
    ns = lambda key: (final.get(key) or 0) / 1e9
    return {
        "ttft_s": first - started if first else None,
        "gen_s": last - first if first and last else None,
        "total_s": time.perf_counter() - started,
        "content": "".join(content),
        "thinking": "".join(thinking),
        "tool_calls": tool_calls or None,
        "done_reason": final.get("done_reason"),
        "eval_count": final.get("eval_count") or 0,
        "eval_s": ns("eval_duration"),
        "prompt_eval_count": final.get("prompt_eval_count") or 0,
        "prompt_eval_s": ns("prompt_eval_duration"),
        "load_s": ns("load_duration"),
    }


def strip_think(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    cut = text.find("<think>")
    return (text[:cut] if cut >= 0 else text).strip()


def loaded_model(root, model):
    running = try_json(root + "/api/ps") or {}
    for m in running.get("models", []):
        if m.get("name") == model or m.get("model") == model:
            size, vram = m.get("size"), m.get("size_vram")
            return {"model_bytes": size, "vram_bytes": vram,
                    "cpu_offload": bool(size and vram is not None and vram < size)}
    return {"model_bytes": None, "vram_bytes": None, "cpu_offload": None}


class Emitter:
    """JSON lines on stdout; text deltas are batched so the run view gets ~10 updates a second."""

    def __init__(self):
        self.pending = []
        self.task = None
        self.flushed_at = 0.0

    def __call__(self, event, **fields):
        self.flush()
        print(json.dumps({"event": event, "t": round(time.time(), 3), **fields}, ensure_ascii=False), flush=True)

    def text(self, delta):
        self.pending.append(delta)
        if time.perf_counter() - self.flushed_at > 0.1:
            self.flush()

    def flush(self):
        if self.pending:
            # Ollama streams one token per chunk, so n is the token count of this delta.
            print(json.dumps({"event": "text", "task": self.task, "delta": "".join(self.pending), "n": len(self.pending)},
                             ensure_ascii=False), flush=True)
            self.pending = []
        self.flushed_at = time.perf_counter()


def speed_task_id(depth):
    return "speed@0" if depth == 0 else f"speed@{depth // 1024}k"


def bench_speed(root, model, depth, cfg, base_options, extra, emit):
    task = speed_task_id(depth)
    emit.task = task
    emit("task_start", task=task, kind="speed", depth=depth)
    runs = []
    reps = cfg.get("warmup_reps", 1) + cfg["reps"]
    # filler_text estimates 4.2 chars/token; the warmup's real count rescales it so depth holds for any tokenizer.
    filler_tokens = depth
    for rep in range(reps):
        def request():
            nonce = "%08x" % random.getrandbits(32)
            prefix = " ".join(filler_text(filler_tokens, seed=f"{nonce}{depth}")) + "\n\n" if depth else ""
            payload = {"model": model, "messages": [{"role": "user", "content": f"[{nonce}] {prefix}{COUNT_PROMPT}"}],
                       "options": dict(base_options, temperature=0, num_predict=cfg["gen_tokens"]),
                       "keep_alive": BENCH_KEEP_ALIVE, **extra}
            return ollama_chat(root, payload, on_text=emit.text)
        r = request()
        if rep < cfg.get("warmup_reps", 1):
            if depth and r["prompt_eval_count"]:
                filler_tokens = round(filler_tokens * depth / r["prompt_eval_count"])
            continue
        reloaded = r["load_s"] > RELOAD_THRESHOLD_S
        if reloaded:
            r = request()
            reloaded = r["load_s"] > RELOAD_THRESHOLD_S
        n = r["eval_count"]
        runs.append({
            "ttft_ms": round(r["ttft_s"] * 1000) if r["ttft_s"] else None,
            "completion_tokens": n,
            "prompt_tokens": r["prompt_eval_count"],
            "decode_tps": round((n - 1) / r["gen_s"], 1) if r["gen_s"] and n > 1 else None,
            "engine_decode_tps": round(n / r["eval_s"], 1) if r["eval_s"] and n else None,
            "engine_prefill_tps": round(r["prompt_eval_count"] / r["prompt_eval_s"], 1) if r["prompt_eval_s"] else None,
            "load_ms": round(r["load_s"] * 1000),
            "reloaded": reloaded,
            "seconds": round(r["total_s"], 2),
        })
    metrics = {"depth": depth, "runs": runs}
    for key in ("ttft_ms", "decode_tps", "engine_decode_tps", "engine_prefill_tps"):
        vals = [run[key] for run in runs if run.get(key)]
        if vals:
            metrics[key] = round(statistics.mean(vals), 1)
            metrics[key + "_sd"] = round(statistics.pstdev(vals), 1)
    metrics.update(loaded_model(root, model))
    result = {"task": task, "kind": "speed", "status": "ok", "metrics": metrics,
              "tokens": sum(run["completion_tokens"] for run in runs), "time": round(sum(run["seconds"] for run in runs), 1)}
    emit("task_done", task=task, kind="speed", decode_tps=metrics.get("decode_tps"), ttft_ms=metrics.get("ttft_ms"))
    return result


def bench_task(root, model, task, samples, base_options, extra, capabilities, emit):
    emit.task = task["id"]
    emit("task_start", task=task["id"], kind="task", category=task["category"], samples=samples)
    if task.get("tools") and "tools" not in capabilities:
        emit("task_done", task=task["id"], kind="task", status="unsupported")
        return {"task": task["id"], "kind": "task", "category": task["category"], "status": "unsupported",
                "reason": "this Ollama model has no tools capability", "pass": None, "passed": 0, "samples": 0,
                "score": None, "tokens": 0, "time": 0}
    recs = []
    for sample in range(samples):
        payload = {"model": model, "messages": build_messages(task),
                   "options": dict(base_options, num_predict=task.get("max_tokens", 6000)),
                   "keep_alive": BENCH_KEEP_ALIVE, **extra}
        if task.get("tools"):
            payload["tools"] = task["tools"]
        try:
            r = ollama_chat(root, payload, on_text=emit.text)
            raw = r["content"]
            resp = {"content": strip_think(raw), "tool_calls": r["tool_calls"],
                    "finish_reason": "length" if r["done_reason"] == "length" else "stop",
                    "usage": {"prompt_tokens": r["prompt_eval_count"], "completion_tokens": r["eval_count"]}}
            hay = task.get("haystack")
            if hay and r["prompt_eval_count"] and r["prompt_eval_count"] < 0.7 * hay["approx_tokens"]:
                resp["prompt_truncated"] = True
            passed, reason = grade(task, resp, {"engine": "ollama", "identity": []})
            rec = {"sample": sample, "passed": bool(passed), "reason": reason, "tokens": r["eval_count"],
                   "seconds": round(r["total_s"], 2), "content": raw, "thinking": r["thinking"], "tool_calls": r["tool_calls"]}
        except Exception as exc:
            rec = {"sample": sample, "passed": False, "reason": f"request failed: {exc}", "tokens": 0, "seconds": 0}
        recs.append(rec)
        emit("sample_done", task=task["id"], sample=sample, passed=rec["passed"], reason=rec["reason"])
    passed = sum(rec["passed"] for rec in recs)
    reasons = {}
    for rec in recs:
        if not rec["passed"]:
            reasons[rec["reason"] or "failed"] = reasons.get(rec["reason"] or "failed", 0) + 1
    errored = all(rec["reason"] and rec["reason"].startswith("request failed") for rec in recs)
    result = {"task": task["id"], "kind": "task", "category": task["category"], "status": "error" if errored else "ok",
              "pass": passed == samples, "passed": passed, "samples": samples, "score": round(passed / samples, 3),
              "reasons": reasons, "tokens": sum(rec["tokens"] for rec in recs),
              "time": round(sum(rec["seconds"] for rec in recs), 1), "attempts": recs}
    emit("task_done", task=task["id"], kind="task", status=result["status"], passed=passed, samples=samples)
    return result


def cmd_bench(args):
    root = server_root(args.base_url.strip().rstrip("/"))
    pack_path = Path(args.pack)
    pack = load_pack(pack_path)
    subject = json.loads(Path(args.subject).read_text()) if args.subject else {}
    model = args.model
    emit = Emitter()
    started = time.time()
    show = http_json(root + "/api/show", {"model": model}, timeout=60)
    capabilities = show.get("capabilities") or []
    sampling = {k: v for k, v in dict(pack.get("sampling") or {}, **(subject.get("sampling") or {})).items() if k in SAMPLING_OPTIONS}
    extra = {"think": subject["think"]} if "think" in subject else {}
    base_options = {"num_ctx": pack["num_ctx"]}
    samples = args.samples or pack.get("samples", 3)
    machine = machine_info()
    emit("start", model=model, suite=f"{pack['id']}@{pack['version']}", capabilities=capabilities, machine=machine)

    emit.task = "warmup"
    emit("task_start", task="warmup", kind="warmup")
    warm = ollama_chat(root, {"model": model, "messages": [{"role": "user", "content": "Reply with OK."}],
                              "options": dict(base_options, temperature=0, num_predict=16),
                              "keep_alive": BENCH_KEEP_ALIVE, **extra})
    emit("task_done", task="warmup", kind="warmup", load_ms=round(warm["load_s"] * 1000))

    results = []
    only = [s for s in (args.only or "").split(",") if s]
    for depth in pack["speed"]["depths"]:
        if not only or speed_task_id(depth) in only:
            results.append(bench_speed(root, model, depth, pack["speed"], base_options, extra, emit))
    for task in pack["tasks"]:
        if not only or task["id"] in only:
            results.append(bench_task(root, model, task, samples, dict(base_options, **sampling), extra, capabilities, emit))

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    record = {
        "suite": {"id": pack["id"], "version": pack["version"], "sha256": sha256_file(pack_path)},
        "test_agent": {"executor": f"holaeval@{HOLAEVAL_VERSION}", "judge": f"holaeval@{HOLAEVAL_VERSION}"},
        "model": model,
        "capabilities": capabilities,
        "request": {"num_ctx": pack["num_ctx"], "sampling": sampling, "samples": samples, "keep_alive": BENCH_KEEP_ALIVE, **extra},
        "warmup_load_ms": round(warm["load_s"] * 1000),
        "machine": machine,
        "results": results,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "wall_seconds": round(time.time() - started, 1),
    }
    (out / f"bench-{args.label}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False))
    emit("done", file=str(out / f"bench-{args.label}.json"))


# ---------- agent: virtual workspace ----------

DEFAULT_AGENT_PACK = HERE / "packs" / "agent-v1.json"


class VFS:
    """In-memory workspace. Nothing here touches the real filesystem."""

    def __init__(self, files=None, root="/workspace"):
        self.root = "/" + root.strip("/")
        self.files = {}
        self.dirs = {"/"}
        self._add_dirs(self.root)
        for rel, content in (files or {}).items():
            path = self.resolve(rel)
            if rel.endswith("/") or content is None:
                self.mkdir(path, parents=True)
            else:
                self.write(path, content)
        self.initial = dict(self.files)
        self.initial_dirs = set(self.dirs)

    def resolve(self, path, cwd=None):
        path = str(path if path is not None else ".").strip() or "."
        if path == "~" or path.startswith("~/"):
            path = self.root + path[1:]
        if not path.startswith("/"):
            path = (cwd or self.root) + "/" + path
        parts = []
        for p in path.split("/"):
            if p in ("", "."):
                continue
            if p == "..":
                if parts:
                    parts.pop()
                continue
            parts.append(p)
        return "/" + "/".join(parts)

    def _add_dirs(self, path):
        while path not in ("", "/"):
            self.dirs.add(path)
            path = path.rsplit("/", 1)[0]

    @staticmethod
    def parent(path):
        return path.rsplit("/", 1)[0] or "/"

    def isdir(self, path):
        return path in self.dirs

    def isfile(self, path):
        return path in self.files

    def read(self, path):
        if path in self.files:
            return self.files[path]
        if path in self.dirs:
            raise IsADirectoryError(path)
        raise FileNotFoundError(path)

    def write(self, path, content, append=False, parents=True):
        if path in self.dirs:
            raise IsADirectoryError(path)
        if not parents and self.parent(path) not in self.dirs:
            raise FileNotFoundError(self.parent(path))
        self._add_dirs(self.parent(path))
        self.files[path] = (self.files.get(path, "") if append else "") + content

    def mkdir(self, path, parents=False):
        if path in self.files:
            raise FileExistsError(path)
        if not parents and self.parent(path) not in self.dirs:
            raise FileNotFoundError(self.parent(path))
        self._add_dirs(path)

    def listdir(self, path):
        names = {(p[len(path.rstrip("/")) + 1:], True) for p in self.dirs if p != path and self.parent(p) == path}
        names |= {(p[len(path.rstrip("/")) + 1:], False) for p in self.files if self.parent(p) == path}
        return sorted(names)

    def walk(self, path):
        prefix = path.rstrip("/") + "/"
        return sorted([(p, True) for p in self.dirs if p.startswith(prefix)] + [(p, False) for p in self.files if p.startswith(prefix)])

    def rel(self, path):
        if path == self.root:
            return "."
        return path[len(self.root) + 1:] if path.startswith(self.root + "/") else path

    def changes(self):
        out = {self.rel(p): c for p, c in self.files.items() if self.initial.get(p) != c}
        out.update({self.rel(p): None for p in self.initial if p not in self.files})
        return out

    def changed(self):
        return bool(self.changes()) or self.dirs != self.initial_dirs


# ---------- agent: bash simulator ----------

HEREDOC_RE = re.compile(r"(?<!<)<<(?!<)(-?)\s*(['\"]?)([A-Za-z_]\w*)\2")
BASH_MUTATING_RE = re.compile(r"(^|[\s;&|(])(mv|rm|cp|tee|touch|mkdir|rmdir|truncate|dd|ln|chmod|install|rename)\b"
                              r"|\bsed\s+(-\w+\s+)*-i|\bperl\s+-\w*i|>")


def bash_mutates(command):
    cleaned = re.sub(r"'[^']*'|\"[^\"]*\"", "''", command)
    cleaned = re.sub(r"\d?>&\d|&?\d?>\s*/dev/null", " ", cleaned)
    return bool(BASH_MUTATING_RE.search(cleaned))


def extract_heredocs(command):
    lines = command.split("\n")
    out, bodies = [], []
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        pending = []

        def repl(m):
            pending.append((m.group(3), m.group(1) == "-"))
            bodies.append("")
            return f" < __HEREDOC{len(bodies) - 1}__ "

        line = HEREDOC_RE.sub(repl, line)
        first = len(bodies) - len(pending)
        for k, (delim, strip_tabs) in enumerate(pending):
            body = []
            while i < len(lines) and lines[i].strip() != delim:
                body.append(lines[i].lstrip("\t") if strip_tabs else lines[i])
                i += 1
            i += 1
            bodies[first + k] = "\n".join(body) + ("\n" if body else "")
        out.append(line)
    return "\n".join(out), bodies


def bash_tokens(script):
    lexer = shlex.shlex(script, posix=True, punctuation_chars=";&|<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    tokens = []
    for tok in lexer:
        if tok and set(tok) <= set(";&|<>\n") and "\n" in tok:
            tok = tok.replace("\n", "") or ";"
        tokens.append(tok)
    return tokens


def bre_to_python(pattern):
    out, i = [], 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\" and i + 1 < len(pattern) and pattern[i + 1] in "|()+?{}":
            out.append(pattern[i + 1])
            i += 2
            continue
        out.append("\\" + ch if ch in "|()+?{}" else ch)
        if ch == "\\" and i + 1 < len(pattern):
            out.append(pattern[i + 1])
            i += 1
        i += 1
    return "".join(out)


class BashSim:
    """A tiny shell over the VFS: ls, cat, head, tail, wc, grep, find, sort, echo, printf, mkdir, touch, cd, pwd."""

    def __init__(self, vfs):
        self.vfs = vfs
        self.cwd = vfs.root

    def run(self, command):
        script, heredocs = extract_heredocs(command)
        script = re.sub(r"(?<![\w-])\d?>&\d", " ", script)
        script = re.sub(r"(?<![\w-])2>>?\s*[^\s;&|<>]+", " ", script)
        script = script.replace("&>", ">")
        if "$(" in script or "`" in script:
            return "bash: command substitution is not available in this sandbox\n", 1
        try:
            tokens = bash_tokens(script)
        except ValueError as exc:
            return f"bash: syntax error: {exc}\n", 2
        output, code, op, current = [], 0, None, []
        for tok in tokens + [";"]:
            if tok in (";", "&&", "||", ";;", "&"):
                if current:
                    if not (op == "&&" and code != 0) and not (op == "||" and code == 0):
                        out, code = self.pipeline(current, heredocs)
                        output.append(out)
                    op = tok if tok in ("&&", "||") else None
                    current = []
                continue
            current.append(tok)
        return "".join(output), code

    def pipeline(self, tokens, heredocs):
        stages, cur = [], []
        for tok in tokens:
            if tok == "|":
                stages.append(cur)
                cur = []
            else:
                cur.append(tok)
        stages.append(cur)
        stdin, errors, code, out = None, [], 0, ""
        for stage in stages:
            argv, target, append, src, err = [], None, False, None, None
            i = 0
            while i < len(stage):
                tok = stage[i]
                if tok in (">", ">>", ">|") and i + 1 < len(stage):
                    target, append = stage[i + 1], tok == ">>"
                    i += 2
                    continue
                if tok == "<" and i + 1 < len(stage):
                    m = re.fullmatch(r"__HEREDOC(\d+)__", stage[i + 1])
                    if m:
                        src = heredocs[int(m.group(1))]
                    else:
                        try:
                            src = self.vfs.read(self.vfs.resolve(stage[i + 1], self.cwd))
                        except (FileNotFoundError, IsADirectoryError):
                            err = f"bash: {stage[i + 1]}: No such file or directory\n"
                    i += 2
                    continue
                argv.append(tok)
                i += 1
            if err:
                errors.append(err)
                code, out = 1, ""
            elif not argv:
                out, code = (src or ""), 0
            else:
                out, e, code = self.exec(argv, src if src is not None else stdin)
                if e:
                    errors.append(e)
            if target is not None:
                if target != "/dev/null":
                    path = self.vfs.resolve(target, self.cwd)
                    try:
                        self.vfs.write(path, out, append=append, parents=False)
                    except (FileNotFoundError, IsADirectoryError):
                        errors.append(f"bash: {target}: No such file or directory\n")
                        code = 1
                out = ""
            stdin = out
        return out + "".join(errors), code

    def expand(self, args):
        out = []
        for a in args:
            if any(c in a for c in "*?[") and not a.startswith("-"):
                base = self.vfs.resolve(".", self.cwd)
                pattern = self.vfs.resolve(a, self.cwd)
                hits = sorted(p for p, _ in self.vfs.walk("/") if fnmatch_path(p, pattern))
                if hits:
                    out += [p[len(base) + 1:] if not a.startswith("/") and p.startswith(base + "/") else p for p in hits]
                    continue
            out.append(a)
        return out

    def _read_inputs(self, files, stdin, cmd):
        if not files:
            return [(None, stdin or "")], ""
        items, errs = [], ""
        for f in files:
            if f == "-":
                items.append((None, stdin or ""))
                continue
            try:
                items.append((f, self.vfs.read(self.vfs.resolve(f, self.cwd))))
            except IsADirectoryError:
                errs += f"{cmd}: {f}: Is a directory\n"
            except FileNotFoundError:
                errs += f"{cmd}: {f}: No such file or directory\n"
        return items, errs

    def exec(self, argv, stdin):
        cmd, args = argv[0], argv[1:]
        handler = getattr(self, "cmd_" + cmd.replace("-", "_"), None) if re.fullmatch(r"[a-z]+", cmd) else None
        if cmd in (":", "true"):
            return "", "", 0
        if cmd == "false":
            return "", "", 1
        if handler is None:
            return "", f"bash: {cmd}: command not available in this sandbox\n", 127
        return handler(args, stdin)

    def cmd_pwd(self, args, stdin):
        return self.cwd + "\n", "", 0

    def cmd_cd(self, args, stdin):
        path = self.vfs.resolve(args[0] if args else self.vfs.root, self.cwd)
        if not self.vfs.isdir(path):
            return "", f"bash: cd: {args[0]}: No such file or directory\n", 1
        self.cwd = path
        return "", "", 0

    def cmd_echo(self, args, stdin):
        newline, escapes = True, False
        while args and re.fullmatch(r"-[neE]+", args[0]):
            newline = newline and "n" not in args[0]
            escapes = escapes or "e" in args[0]
            args = args[1:]
        text = " ".join(args)
        if escapes:
            text = text.replace("\\n", "\n").replace("\\t", "\t")
        return text + ("\n" if newline else ""), "", 0

    def cmd_printf(self, args, stdin):
        if not args:
            return "", "printf: usage: printf format [arguments]\n", 2
        fmt = args[0].replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\")
        rest = args[1:]
        slots = len(re.findall(r"%[sd]", fmt))
        if not slots or not rest:
            return re.sub(r"%[sd]", "", fmt).replace("%%", "%"), "", 0
        out = []
        for i in range(0, len(rest), slots):
            chunk = iter(rest[i:i + slots])
            out.append(re.sub(r"%[sd]", lambda _: next(chunk, ""), fmt).replace("%%", "%"))
        return "".join(out), "", 0

    def cmd_cat(self, args, stdin):
        number = "-n" in args
        items, errs = self._read_inputs(self.expand([a for a in args if not a.startswith("-") or a == "-"]), stdin, "cat")
        text = "".join(c for _, c in items)
        if number:
            text = "".join(f"{i:>6}\t{line}\n" for i, line in enumerate(text.splitlines(), 1))
        return text, errs, 1 if errs else 0

    def _head_tail(self, args, stdin, cmd):
        n, files, i, from_start = 10, [], 0, False
        while i < len(args):
            a = args[i]
            if a == "-n" and i + 1 < len(args):
                a = "-n" + args[i + 1]
                i += 1
            if re.fullmatch(r"-n?\+?\d+", a):
                n = int(re.sub(r"\D", "", a))
                from_start = "+" in a
            elif not a.startswith("-") or a == "-":
                files.append(a)
            i += 1
        items, errs = self._read_inputs(self.expand(files), stdin, cmd)
        out = []
        for name, content in items:
            lines = content.splitlines(keepends=True)
            if len(items) > 1:
                out.append(f"==> {name} <==\n")
            out.append("".join(lines[:n] if cmd == "head" else lines[max(n - 1, 0):] if from_start else lines[-n:] if n else []))
        return "".join(out), errs, 1 if errs else 0

    def cmd_head(self, args, stdin):
        return self._head_tail(args, stdin, "head")

    def cmd_tail(self, args, stdin):
        return self._head_tail(args, stdin, "tail")

    def cmd_wc(self, args, stdin):
        flags = "".join(a[1:] for a in args if a.startswith("-") and a != "-")
        modes = [m for m in "lwc" if m in flags] or ["l", "w", "c"]
        items, errs = self._read_inputs(self.expand([a for a in args if not a.startswith("-") or a == "-"]), stdin, "wc")
        rows, total = [], [0, 0, 0]
        for name, content in items:
            counts = [content.count("\n"), len(content.split()), len(content.encode())]
            total = [a + b for a, b in zip(total, counts)]
            vals = [counts["lwc".index(m)] for m in modes]
            rows.append(" ".join(str(v) for v in vals) + (f" {name}" if name else ""))
        if len(items) > 1:
            rows.append(" ".join(str(total["lwc".index(m)]) for m in modes) + " total")
        return "\n".join(rows) + "\n", errs, 1 if errs else 0

    def cmd_grep(self, args, stdin):
        flags, pattern, files, i = set(), None, [], 0
        while i < len(args):
            a = args[i]
            if a == "-e" and i + 1 < len(args):
                pattern = args[i + 1]
                i += 2
                continue
            if a in ("-A", "-B", "-C", "-m"):
                i += 2
                continue
            if a.startswith("--"):
                flags.add({"--recursive": "r", "--ignore-case": "i", "--count": "c", "--line-number": "n"}.get(a, ""))
            elif a.startswith("-") and len(a) > 1:
                flags |= set(a[1:])
            elif pattern is None:
                pattern = a
            else:
                files.append(a)
            i += 1
        if pattern is None:
            return "", "usage: grep [-icnrlvEFw] pattern [file ...]\n", 2
        if "F" in flags:
            regex = re.escape(pattern)
        elif "E" in flags:
            regex = pattern
        else:
            regex = bre_to_python(pattern)
        if "w" in flags:
            regex = rf"\b(?:{regex})\b"
        try:
            rx = re.compile(regex, re.I if "i" in flags else 0)
        except re.error:
            rx = re.compile(re.escape(pattern), re.I if "i" in flags else 0)
        recursive = bool(flags & {"r", "R"})
        files = self.expand(files) or (["."] if recursive else [])
        targets, errs = [], ""
        for f in files:
            path = self.vfs.resolve(f, self.cwd)
            if self.vfs.isdir(path):
                if not recursive:
                    errs += f"grep: {f}: Is a directory\n"
                    continue
                for p, is_dir in self.vfs.walk(path):
                    if not is_dir:
                        shown = p[len(path.rstrip("/")) + 1:]
                        targets.append(((f.rstrip("/") + "/" + shown) if f not in (".", "./") else shown, self.vfs.files[p]))
            elif self.vfs.isfile(path):
                targets.append((f, self.vfs.files[path]))
            else:
                errs += f"grep: {f}: No such file or directory\n"
        if not files:
            targets = [(None, stdin or "")]
        show_name = (len(targets) > 1 or recursive) and "h" not in flags
        out, matched = [], False
        for name, content in targets:
            hits = [(n, line) for n, line in enumerate(content.splitlines(), 1) if bool(rx.search(line)) != ("v" in flags)]
            matched = matched or bool(hits)
            if "l" in flags:
                if hits:
                    out.append(f"{name}\n")
            elif "c" in flags:
                out.append((f"{name}:" if show_name else "") + f"{len(hits)}\n")
            else:
                for n, line in hits:
                    out.append((f"{name}:" if show_name else "") + (f"{n}:" if "n" in flags else "") + line + "\n")
        return "".join(out), errs, 0 if matched else (2 if errs else 1)

    def cmd_ls(self, args, stdin):
        flags = "".join(a[1:] for a in args if a.startswith("-"))
        paths = self.expand([a for a in args if not a.startswith("-")]) or ["."]
        loose, out, errs = [], [], ""
        for p in paths:
            path = self.vfs.resolve(p, self.cwd)
            if self.vfs.isfile(path):
                loose.append((p, False))
            elif self.vfs.isdir(path):
                out.append((p, [(n, d) for n, d in self.vfs.listdir(path)]))
            else:
                errs += f"ls: {p}: No such file or directory\n"
        if loose:
            out.insert(0, (None, loose))
        groups = []
        for header, entries in out:
            text = [f"{header}:\n"] if len(out) > 1 and header is not None else []
            for name, is_dir in entries:
                if "l" in flags:
                    full = self.vfs.resolve(name if header is None else header + "/" + name, self.cwd)
                    size = 64 if is_dir else len(self.vfs.files.get(full, "").encode())
                    text.append(f"{'d' if is_dir else '-'}rw-r--r--  1 user  staff  {size:>6}  {name}\n")
                else:
                    text.append(name + ("/" if is_dir and "F" in flags else "") + "\n")
            groups.append("".join(text))
        return "\n".join(groups), errs, 1 if errs else 0

    def cmd_find(self, args, stdin):
        starts, i, ftype, name, iname, maxdepth = [], 0, None, None, None, None
        while i < len(args) and not args[i].startswith("-"):
            starts.append(args[i])
            i += 1
        while i < len(args):
            a = args[i]
            val = args[i + 1] if i + 1 < len(args) else ""
            if a == "-type":
                ftype = val
            elif a == "-name":
                name = val
            elif a == "-iname":
                iname = val
            elif a in ("-maxdepth", "-depth") and val.isdigit():
                maxdepth = int(val)
            elif a in ("-print", "-print0"):
                i += 1
                continue
            else:
                return "", f"find: {a}: unsupported option in this sandbox\n", 1
            i += 2
        out, errs = [], ""
        for s in starts or ["."]:
            path = self.vfs.resolve(s, self.cwd)
            if not self.vfs.isdir(path) and not self.vfs.isfile(path):
                errs += f"find: {s}: No such file or directory\n"
                continue
            entries = [(path, self.vfs.isdir(path))] + (self.vfs.walk(path) if self.vfs.isdir(path) else [])
            for p, is_dir in entries:
                depth = 0 if p == path else p[len(path.rstrip("/")) + 1:].count("/") + 1
                base = p.rsplit("/", 1)[-1]
                if maxdepth is not None and depth > maxdepth:
                    continue
                if ftype and (ftype == "f") == is_dir:
                    continue
                if name and not fnmatch.fnmatchcase(base, name):
                    continue
                if iname and not fnmatch.fnmatch(base.lower(), iname.lower()):
                    continue
                out.append(s.rstrip("/") + p[len(path):] if p != path else s)
        return "".join(o + "\n" for o in out), errs, 1 if errs else 0

    def cmd_sort(self, args, stdin):
        flags = "".join(a[1:] for a in args if a.startswith("-"))
        items, errs = self._read_inputs(self.expand([a for a in args if not a.startswith("-")]), stdin, "sort")
        lines = "".join(c for _, c in items).splitlines()
        key = (lambda s: float(re.match(r"\s*(-?\d+(\.\d+)?)", s).group(1)) if re.match(r"\s*-?\d", s) else 0.0) if "n" in flags else None
        lines = sorted(lines, key=key, reverse="r" in flags)
        return "".join(line + "\n" for line in lines), errs, 1 if errs else 0

    def cmd_mkdir(self, args, stdin):
        parents = any(a.startswith("-") and "p" in a for a in args)
        errs = ""
        for d in [a for a in args if not a.startswith("-")]:
            path = self.vfs.resolve(d, self.cwd)
            if self.vfs.isdir(path):
                if not parents:
                    errs += f"mkdir: {d}: File exists\n"
                continue
            try:
                self.vfs.mkdir(path, parents=parents)
            except (FileNotFoundError, FileExistsError):
                errs += f"mkdir: {d}: No such file or directory\n"
        return "", errs, 1 if errs else 0

    def cmd_touch(self, args, stdin):
        errs = ""
        for f in [a for a in args if not a.startswith("-")]:
            path = self.vfs.resolve(f, self.cwd)
            if not self.vfs.isfile(path):
                try:
                    self.vfs.write(path, "", parents=False)
                except (FileNotFoundError, IsADirectoryError):
                    errs += f"touch: {f}: No such file or directory\n"
        return "", errs, 1 if errs else 0


def fnmatch_path(path, pattern):
    return fnmatch.fnmatchcase(path, pattern) and path.count("/") == pattern.count("/")


# ---------- agent: tools ----------

def _int_arg(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def tool_read(vfs, a):
    path = a.get("path")
    if not isinstance(path, str) or not path.strip():
        return "Error: path is required.", True
    p = vfs.resolve(path)
    if vfs.isdir(p):
        entries = vfs.listdir(p)
        return "\n".join(f"{i}. {n}{'/' if d else ''}" for i, (n, d) in enumerate(entries, 1)) or "(empty directory)", False
    if not vfs.isfile(p):
        return f"Error: File not found: {path}", True
    lines = vfs.files[p].split("\n")
    start = max(_int_arg(a.get("offset"), 1) or 1, 1) - 1
    limit = _int_arg(a.get("limit"))
    chunk = lines[start:start + limit] if limit else lines[start:]
    return "\n".join(chunk), False


def tool_write(vfs, a):
    path, content = a.get("path"), a.get("content")
    if not isinstance(path, str) or not isinstance(content, str):
        return "Error: path and content are required.", True
    vfs.write(vfs.resolve(path), content)
    return f"Successfully wrote {len(content.encode())} bytes to {path}", False


def tool_edit(vfs, a):
    path, edits = a.get("path"), a.get("edits")
    if isinstance(edits, str):
        try:
            edits = json.loads(edits)
        except json.JSONDecodeError:
            edits = None
    if not isinstance(path, str) or not isinstance(edits, list) or not edits:
        return "Error: Edit tool input is invalid. edits must contain at least one replacement.", True
    p = vfs.resolve(path)
    if not vfs.isfile(p):
        return f"Error: Could not edit file: {path}. File not found.", True
    original = vfs.files[p]
    spans = []
    for i, e in enumerate(edits):
        if not isinstance(e, dict) or not isinstance(e.get("oldText"), str) or not isinstance(e.get("newText"), str) or not e["oldText"]:
            return f"Error: Edit tool input is invalid. edits[{i}] needs non-empty oldText and newText.", True
        count = original.count(e["oldText"])
        if count != 1:
            why = "was not found in the file" if count == 0 else f"matches {count} places; include more context so it is unique"
            return f"Error: Could not edit file: {path}. edits[{i}].oldText {why}.", True
        start = original.index(e["oldText"])
        spans.append((start, start + len(e["oldText"]), e["newText"], i))
    spans.sort()
    for prev, cur in zip(spans, spans[1:]):
        if cur[0] < prev[1]:
            return f"Error: edits[{prev[3]}] and edits[{cur[3]}] overlap in {path}. Merge them into one edit.", True
    out, pos = [], 0
    for start, end, new, _ in spans:
        out.append(original[pos:start] + new)
        pos = end
    vfs.write(p, "".join(out) + original[pos:])
    return f"Successfully replaced {len(spans)} block(s) in {path}.", False


def tool_ls(vfs, a):
    path = a.get("path") or "."
    p = vfs.resolve(path)
    if vfs.isfile(p):
        return p.rsplit("/", 1)[-1], False
    if not vfs.isdir(p):
        return f"Error: Path not found: {path}", True
    limit = _int_arg(a.get("limit"), 500) or 500
    entries = [n + ("/" if d else "") for n, d in vfs.listdir(p)][:limit]
    return "\n".join(entries) or "(empty directory)", False


def _scope_paths(vfs, scope):
    scope = re.sub(r":\d+(-\d+)?$", "", str(scope or "."))
    p = vfs.resolve(scope)
    if vfs.isfile(p):
        return [p]
    if vfs.isdir(p):
        return [q for q, d in vfs.walk(p) if not d]
    pattern = vfs.resolve(scope)
    return [q for q in vfs.files if fnmatch.fnmatchcase(q, pattern) or fnmatch.fnmatchcase(q.rsplit("/", 1)[-1], scope)]


def tool_search(vfs, a):
    pattern = a.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        return "Error: pattern is required.", True
    flags = re.I if a.get("i") else 0
    try:
        rx = re.compile(pattern, flags)
    except re.error:
        rx = re.compile(re.escape(pattern), flags)
    scopes = a.get("paths") if isinstance(a.get("paths"), list) and a.get("paths") else [a.get("path") or "."]
    files = sorted({f for s in scopes for f in _scope_paths(vfs, s)})
    out = []
    for f in files:
        hits = [(n, line) for n, line in enumerate(vfs.files[f].split("\n"), 1) if rx.search(line)]
        if hits:
            out.append(vfs.rel(f))
            out += [f"  {n}: {line[:500]}" for n, line in hits]
    return "\n".join(out) or "No matches found.", False


def tool_find(vfs, a):
    entries = a.get("paths") if isinstance(a.get("paths"), list) and a.get("paths") else [a.get("pattern") or "."]
    base = vfs.resolve(a.get("path") or ".")
    found = set()
    for e in entries:
        e = str(e)
        if any(c in e for c in "*?["):
            pattern = vfs.resolve(e, base)
            for q, d in vfs.walk(base):
                if fnmatch.fnmatchcase(q, pattern) or ("/" not in e and fnmatch.fnmatchcase(q.rsplit("/", 1)[-1], e)):
                    found.add(vfs.rel(q) + ("/" if d else ""))
        else:
            p = vfs.resolve(e, base)
            if vfs.isfile(p):
                found.add(vfs.rel(p))
            elif vfs.isdir(p):
                found |= {vfs.rel(q) + ("/" if d else "") for q, d in vfs.walk(p)}
    limit = max(1, min(_int_arg(a.get("limit"), 200) or 200, 200))
    return "\n".join(sorted(found)[:limit]) or "No files found.", False


def tool_bash(vfs, a):
    command = a.get("command")
    if not isinstance(command, str) or not command.strip():
        return "Error: command is required.", True
    out, code = BashSim(vfs).run(command)
    text = out if out else "(no output)"
    if code:
        text = text.rstrip("\n") + f"\n\nCommand exited with code {code}"
    return text, bool(code)


def tool_search_web(vfs, a):
    query = a.get("query")
    if not isinstance(query, str) or not query.strip():
        return "Error: query is required.", True
    results = getattr(vfs, "web_results", None) or [
        {"title": f"{query} ({kind})", "url": f"https://example.com/{kind}", "snippet": f"Simulated search result for: {query}."}
        for kind in ("overview", "news", "reference")]
    return json.dumps({"query": query, "results": results}), False


AGENT_TOOL_IMPL = {
    "read": tool_read, "write": tool_write, "edit": tool_edit, "ls": tool_ls, "list": tool_ls,
    "search": tool_search, "grep": tool_search, "find": tool_find, "bash": tool_bash,
    "search_web": tool_search_web, "web_search": tool_search_web,
    "ask_user_question": lambda vfs, a: ("The user did not answer.", False),
}


def execute_tool(vfs, name, args, available):
    if name not in available:
        return f"Error: Tool {name} not found.", True
    impl = AGENT_TOOL_IMPL.get(name)
    if impl is None:
        return json.dumps({"ok": True, "results": []}), False
    try:
        return impl(vfs, args)
    except Exception as exc:
        return f"Error: {exc!r}", True


# ---------- agent: loop and grading ----------

TEXT_TOOL_CALL_RE = re.compile(r"<tool_call>|</tool_call>|<function[=\s>]|\[TOOL_CALLS\]|<\|tool_call|<\|python_tag\|>|<tool_use>|<invoke\b")


def looks_like_text_tool_call(text, tool_names):
    if not text:
        return False
    if TEXT_TOOL_CALL_RE.search(text):
        return True
    named = re.findall(r'"(?:name|tool|tool_name|function)"\s*:\s*"([\w.-]+)"', text)
    return any(n in tool_names for n in named) and bool(re.search(r'"(?:arguments|parameters|args|input)"\s*:', text))


def parse_tool_args(raw):
    if isinstance(raw, dict):
        return raw, False
    if raw in (None, ""):
        return {}, False
    try:
        val = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None, True
    return (val, False) if isinstance(val, dict) else (None, True)


def numbers_in(text):
    return [n.replace(",", "") for n in re.findall(r"(?<![\w.])-?\d[\d,]*(?:\.\d+)?(?![\w])", text or "")]


def check_agent_grader(g, rec, vfs):
    calls = rec["tool_calls"]
    names = [c["name"] for c in calls]
    final = rec.get("final_answer") or ""
    if g.get("no_tool_calls") and calls:
        return f"called a tool when none was needed ({names[0]})"
    if "tools_used_any" in g and not any(c["name"] in g["tools_used_any"] and not c["error"] for c in calls):
        return "answered without using " + "/".join(g["tools_used_any"])
    for n in g.get("tools_not_used") or []:
        if n in names:
            return f"used {n}"
    if g.get("no_mutation"):
        for c in calls:
            cargs = c.get("arguments") if isinstance(c.get("arguments"), dict) else {}
            if c["name"] in ("edit", "write") or (c["name"] == "bash" and bash_mutates(str(cargs.get("command", "")))):
                return f"tried to change files without asking ({c['name']})"
        if vfs.changed():
            return "changed files without asking"
    if g.get("asks_user") and "ask_user_question" not in names:
        return "asked in plain text instead of ask_user_question" if "?" in final else "did not ask the user"
    spec = g.get("tool_call")
    if spec:
        matching = [c for c in calls if c["name"] == spec["name"]]
        if not matching:
            return f"never called {spec['name']}"
        values = [str((c.get("arguments") or {}).get(spec["arg"], "") if isinstance(c.get("arguments"), dict) else "") for c in matching]
        if not any(any(k.lower() in v.lower() for k in spec.get("contains_any_ci", [""])) for v in values):
            return f"{spec['name']} {spec['arg']}={values[0]!r} is not relevant"
    spec = g.get("file_json")
    if spec:
        path = vfs.resolve(spec["path"])
        if not vfs.isfile(path):
            return f"{spec['path']} missing"
        try:
            obj = json.loads(vfs.files[path])
        except json.JSONDecodeError:
            return f"{spec['path']} is no longer valid JSON"
        if obj != spec["equals"]:
            if not isinstance(obj, dict):
                return f"{spec['path']} is not a JSON object"
            for k, v in spec["equals"].items():
                if k not in obj:
                    return f"{k} was removed"
                if obj[k] != v:
                    return f"{k}={obj[k]!r}, expected {v!r}"
            return f"unexpected keys {sorted(set(obj) - set(spec['equals']))}"
    spec = g.get("file_bullets")
    if spec:
        path = vfs.resolve(spec["path"])
        if not vfs.isfile(path):
            return f"{spec['path']} not created"
        bullets = [ln.strip() for ln in vfs.files[path].splitlines() if re.match(r"\s*[-*+]\s", ln)]
        for item in spec["items"]:
            if not any(item in b for b in bullets):
                return f"{spec['path']} has no bullet for {item}"
        for item in spec.get("exclude") or []:
            if any(item in b for b in bullets):
                return f"{spec['path']} lists {item}"
    if "answer_contains" in g and g["answer_contains"].lower() not in final.lower():
        return f"answer missing {g['answer_contains']!r}"
    for bad in g.get("answer_excludes") or []:
        if bad.lower() in final.lower():
            return f"answer also mentions {bad!r}"
    if "answer_number" in g:
        nums = numbers_in(final)
        if not nums:
            return "no number in answer"
        if not any(n == str(g["answer_number"]) or (n.replace(".", "", 1).isdigit() and float(n) == g["answer_number"]) for n in nums):
            return f"answered {', '.join(nums[:3])}, expected {g['answer_number']}"
    spec = g.get("answer_json_array")
    if spec:
        raw = final.strip()
        if spec.get("no_fence") and raw.startswith("```"):
            return "wrapped in a code fence"
        try:
            arr = json.loads(raw)
        except json.JSONDecodeError:
            return "not valid JSON" if raw.startswith("[") else "not only a JSON array"
        if not isinstance(arr, list) or not all(isinstance(x, str) for x in arr):
            return "not a JSON array of strings"
        got = sorted(x.rstrip("/").rsplit("/", 1)[-1] for x in arr) if spec.get("basename") else sorted(arr)
        if got != sorted(spec["items"]):
            return f"names {sorted(arr)} != {sorted(spec['items'])}"
    return None


def grade_agent(task, rec, vfs, max_turns):
    if rec.get("error"):
        context = re.search(r"context|n_ctx|too long|maximum.*length", rec["error"], re.I)
        return False, "request failed: context window exceeded" if context else "request failed"
    reason = check_agent_grader(task["grader"], rec, vfs)
    if reason is None and rec.get("final_answer") is not None:
        return True, None
    if rec.get("text_tool_call"):
        return False, "tool call written as text"
    if rec.get("final_answer") is None:
        return False, f"no final answer within {max_turns} turns" + (" (work was correct)" if reason is None else "")
    if not rec["final_answer"].strip() and rec.get("finish_reason") == "length":
        return False, "ran out of tokens before answering"
    return False, reason


def load_agent_pack(path):
    pack = json.loads(Path(path).read_text())
    for t in pack["tasks"]:
        t.setdefault("category", "general")
        t.setdefault("vfs", {})
    return pack


def load_agent_condition(pack_path, pack, name):
    spec = pack["conditions"][name]
    root = Path(pack_path).resolve().parent
    system = (root / spec["system"]).read_text().rstrip("\n")
    tools = json.loads((root / spec["tools"]).read_text())
    return {"name": name, "system": system, "tools": tools, "user_suffix": spec.get("user_suffix", ""),
            "tool_names": [t["function"]["name"] for t in tools], "approx_tokens": spec.get("approx_tokens") or {}}


def estimate_request_tokens(cond, tasks):
    longest = max((len(t["prompt"]) for t in tasks), default=0)
    chars = len(cond["system"]) + len(json.dumps(cond["tools"])) + len(cond.get("user_suffix", "")) + longest
    return int(chars / 3.5)


def plan_conditions(conds, tasks, ctx_window):
    active, skipped = [], []
    for name, cond in conds.items():
        est = estimate_request_tokens(cond, tasks)
        if ctx_window and est > 0.9 * ctx_window:
            skipped.append({"condition": name, "reason": f"estimated request ~{est} tokens exceeds 90% of the {ctx_window}-token context window"})
        else:
            active.append(name)
    return active, skipped


def message_text(content):
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


def agent_chat(base, payload):
    try:
        return chat(base, payload)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"HTTP {exc.code}: {body}") from None


def run_agent_task(send, model, task, sample, cond, sampling, engine, max_turns, max_tokens, vfs_base, workspace):
    vfs = VFS({**(vfs_base or {}), **task["vfs"]}, root=workspace)
    vfs.web_results = task.get("web_results")
    messages = [{"role": "system", "content": cond["system"]},
                {"role": "user", "content": task["prompt"] + cond.get("user_suffix", "")}]
    rec = {"id": task["id"], "category": task["category"], "sample": sample, "condition": cond["name"], "turns": 0,
           "tool_calls": [], "final_answer": None, "finish_reason": None, "text_tool_call": False, "prompt_tokens": None,
           "first_response_s": None, "completion_tokens": 0, "error": None, "trace": []}
    started = time.time()
    try:
        for turn in range(max_turns):
            payload = {"model": model, "messages": messages, "tools": cond["tools"], "max_tokens": task.get("max_tokens", max_tokens), **sampling}
            if engine == "llamacpp":
                payload["cache_prompt"] = False
            t0 = time.perf_counter()
            data = send(payload)
            elapsed = time.perf_counter() - t0
            rec["turns"] += 1
            choice = data["choices"][0]
            msg = choice.get("message") or {}
            usage = data.get("usage") or {}
            if turn == 0:
                rec["prompt_tokens"] = usage.get("prompt_tokens")
                rec["first_response_s"] = round(elapsed, 2)
            rec["completion_tokens"] += usage.get("completion_tokens") or 0
            rec["finish_reason"] = choice.get("finish_reason")
            content = message_text(msg.get("content"))
            reasoning_key = next((k for k in ("reasoning_content", "reasoning") if msg.get(k)), None)
            calls = msg.get("tool_calls") or []
            rec["trace"].append({"content": content[:4000], "reasoning": (msg[reasoning_key][:2000] if reasoning_key else ""),
                                 "finish_reason": choice.get("finish_reason"), "seconds": round(elapsed, 2),
                                 "tool_calls": [(c.get("function") or {}).get("name") for c in calls]})
            if not calls:
                rec["final_answer"] = content
                break
            assistant = {"role": "assistant", "content": content or None, "tool_calls": []}
            if reasoning_key:
                assistant[reasoning_key] = msg[reasoning_key]
            results = []
            for i, call in enumerate(calls):
                fn = call.get("function") or {}
                name = fn.get("name") or ""
                args, bad = parse_tool_args(fn.get("arguments"))
                cid = call.get("id") or f"call_{turn}_{i}"
                raw = fn.get("arguments") if isinstance(fn.get("arguments"), str) else json.dumps(fn.get("arguments"))
                assistant["tool_calls"].append({"id": cid, "type": "function",
                                                "function": {"name": name, "arguments": raw if bad else json.dumps(args, ensure_ascii=False)}})
                if bad:
                    result, is_err = "Error: tool arguments are not valid JSON.", True
                else:
                    result, is_err = execute_tool(vfs, name, args, cond["tool_names"])
                rec["tool_calls"].append({"turn": turn + 1, "name": name, "arguments": raw if bad else args, "error": is_err, "result": result[:1000]})
                results.append({"role": "tool", "tool_call_id": cid, "content": result})
            messages.append(assistant)
            messages.extend(results)
    except Exception as exc:
        rec["error"] = repr(exc)
    rec["text_tool_call"] = looks_like_text_tool_call(rec["final_answer"], cond["tool_names"])
    rec["files_changed"] = {k: (v[:2000] if isinstance(v, str) else v) for k, v in vfs.changes().items()}
    rec["passed"], rec["reason"] = grade_agent(task, rec, vfs, max_turns)
    rec["passed"] = bool(rec["passed"])
    rec["seconds"] = round(time.time() - started, 1)
    return rec


def summarize_agent(records, conds, active):
    out = {}
    for name in active:
        recs = [r for r in records if r["condition"] == name]
        c = {"passed": sum(r["passed"] for r in recs), "n": len(recs), "by_task": {}}
        for r in recs:
            t = c["by_task"].setdefault(r["id"], {"category": r["category"], "passed": 0, "n": 0, "reasons": {}})
            t["passed"] += r["passed"]
            t["n"] += 1
            if not r["passed"]:
                t["reasons"][r["reason"] or "failed"] = t["reasons"].get(r["reason"] or "failed", 0) + 1
        pts = [r["prompt_tokens"] for r in recs if r.get("prompt_tokens")]
        frs = [r["first_response_s"] for r in recs if r.get("first_response_s") is not None]
        cond = conds[name]
        c.update(prompt_tokens_avg=round(statistics.mean(pts)) if pts else None,
                 first_response_s_avg=round(statistics.mean(frs), 2) if frs else None,
                 turns_avg=round(statistics.mean([r["turns"] for r in recs]), 2) if recs else None,
                 text_tool_calls=sum(1 for r in recs if r.get("text_tool_call")),
                 tool_count=len(cond["tools"]),
                 system_prompt_tokens_est=cond["approx_tokens"].get("system") or round(len(cond["system"]) / 3.5),
                 tools_tokens_est=cond["approx_tokens"].get("tools") or round(len(json.dumps(cond["tools"])) / 3.5))
        out[name] = c
    return out


def cmd_agent(args):
    base = normalize_base(args.base_url)
    pack_path = Path(args.pack)
    pack = load_agent_pack(pack_path)
    info = detect(base)
    model = args.model or (info["models"][0]["id"] if info["models"] else None)
    if not model:
        sys.exit("no model: pass --model")
    ctx_window = args.context_window or next((m.get("context_window") for m in info["models"] if m["id"] == model and m.get("context_window")), None)
    sampling = dict(pack.get("sampling") or {})
    for key in ("temperature", "top_p", "min_p"):
        if getattr(args, key) is not None:
            sampling[key] = getattr(args, key)
    samples = args.samples or pack.get("samples", 3)
    max_turns = args.max_turns or pack.get("max_turns", 6)
    names = [c.strip() for c in args.conditions.split(",") if c.strip()]
    unknown = [n for n in names if n not in pack["conditions"]]
    if unknown:
        sys.exit(f"unknown condition(s) {unknown}; pack has {list(pack['conditions'])}")
    conds = {n: load_agent_condition(pack_path, pack, n) for n in names}
    only = [s for s in (args.only or "").split(",") if s]
    tasks = [t for t in pack["tasks"] if not only or any(t["id"].startswith(o) or t["category"] == o for o in only)]
    active, skipped = plan_conditions(conds, tasks, ctx_window)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    label = args.label
    jobs = [(t, s, c) for t in tasks for s in range(samples) for c in active]
    progress = open(out / f"progress-{label}.log", "a", buffering=1)
    say = lambda msg: (print(msg, flush=True), progress.write(msg + "\n"))
    say(f"START {label} agent model={model} engine={info['engine']} tasks={len(tasks)} samples={samples} "
        f"conditions={','.join(active) or '-'} jobs={len(jobs)} skipped={len(skipped)}")
    for sk in skipped:
        say(f"SKIP {label} {sk['condition']}: {sk['reason']}")
    max_tokens = pack.get("max_tokens", 6000)
    workspace = pack.get("workspace", "/workspace")
    results = []
    started = time.time()
    with ThreadPoolExecutor(max_workers=args.parallel) as pool, open(out / f"agent-tasks-{label}.jsonl", "w") as f:
        futures = [pool.submit(run_agent_task, lambda payload: agent_chat(base, payload), model, t, s, conds[c], sampling, info["engine"], max_turns, max_tokens,
                               pack.get("vfs_base"), workspace) for t, s, c in jobs]
        for i, fut in enumerate(futures, 1):
            rec = fut.result()
            results.append(rec)
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            say(f"[{i}/{len(jobs)}] {rec['id']}#{rec['sample']}/{rec['condition']} {'PASS' if rec['passed'] else 'FAIL'} {rec['seconds']}s"
                + (f" ({rec['reason']})" if not rec["passed"] else ""))
    summary = {"label": label, "model": model, "engine": info["engine"], "base_url": base, "pack": pack.get("id"),
               "pack_version": pack.get("version"), "sampling": sampling, "samples": samples, "max_turns": max_turns,
               "context_window": ctx_window, "wall_seconds": round(time.time() - started, 1), "skipped": skipped,
               "conditions": summarize_agent(results, conds, active)}
    (out / f"agent-summary-{label}.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    say(f"DONE {label} agent " + " ".join(f"{k}={v['passed']}/{v['n']}" for k, v in summary["conditions"].items())
        + f" wall={summary['wall_seconds']}s")


# ---------- tables ----------

def agent_tables(d):
    agents = {}
    for p in sorted(d.glob("agent-summary-*.json")):
        s = json.loads(p.read_text())
        agents[s["label"]] = s
    if not agents:
        return []
    fmt = lambda v: f"{v:,}" if isinstance(v, int) else ("-" if v is None else str(v))
    out = ["### Agent fitness (holaOS agent loop, passed / task runs)", "",
           "| Run | Condition | Tools | Success | Avg prompt tokens (first request) | Avg first response | Avg turns |",
           "|---|---|---|---|---|---|---|"]
    cols = []
    for lab, s in agents.items():
        for cname, c in s["conditions"].items():
            cols.append((lab, cname, c))
            pct = round(100 * c["passed"] / c["n"]) if c["n"] else 0
            first = f"{c['first_response_s_avg']} s" if c.get("first_response_s_avg") is not None else "-"
            out.append(f"| {lab} | {cname} | {c['tool_count']} | {c['passed']}/{c['n']} ({pct}%) | {fmt(c.get('prompt_tokens_avg'))} | {first} | {fmt(c.get('turns_avg'))} |")
        for sk in s.get("skipped") or []:
            out.append(f"| {lab} | {sk['condition']} | | skipped: {sk['reason']} | | | |")
    if cols:
        out += ["", "| Task | Category | " + " | ".join(f"{lab} {cname}" for lab, cname, _ in cols) + " | Failure reasons |",
                "|---|---|" + "---|" * len(cols) + "---|"]
        tids = []
        for _, _, c in cols:
            tids += [t for t in c["by_task"] if t not in tids]
        for tid in tids:
            cat = next(c["by_task"][tid]["category"] for _, _, c in cols if tid in c["by_task"])
            reasons = [f"{lab} {cname}: {r} ×{n}" for lab, cname, c in cols for r, n in (c["by_task"].get(tid, {}).get("reasons") or {}).items()]
            cells = [f"{c['by_task'][tid]['passed']}/{c['by_task'][tid]['n']}" if tid in c["by_task"] else "-" for _, _, c in cols]
            out.append(f"| {tid} | {cat} | " + " | ".join(cells) + " | " + "; ".join(reasons) + " |")
    out.append("")
    return out


def cmd_tables(args):
    d = Path(args.dir)
    out = []
    speeds = sorted(d.glob("speed-*.json"))
    if speeds:
        out += ["### Speed (streaming over HTTP, temperature 0)", "",
                "| Run | Context depth | Time to first token | Prefill tok/s | Decode tok/s |", "|---|---|---|---|---|"]
        for p in speeds:
            s = json.loads(p.read_text())
            for row in s["depths"]:
                if row.get("skipped"):
                    out.append(f"| {s['label']} | {row['depth']} | skipped: {row['skipped']} | | |")
                    continue
                dec = row.get("engine_decode_tps") or row.get("decode_tps")
                pre = row.get("engine_prefill_tps") or row.get("prefill_tps")
                out.append(f"| {s['label']} | {row['depth']} | {row.get('ttft_s', '-')} s | {pre or '-'} | {dec or '-'} |")
            for c in s.get("concurrency") or []:
                out.append(f"| {s['label']} | {c['concurrency']} parallel requests | | | {c['aggregate_tps']} (aggregate) |")
        out.append("")
    summaries = {json.loads(p.read_text())["label"]: json.loads(p.read_text()) for p in sorted(d.glob("summary-*.json"))}
    if summaries:
        labels = list(summaries)
        out += ["### Capability spot check (passed / samples)", "", "| Category | " + " | ".join(labels) + " |", "|---|" + "---|" * len(labels)]
        cats = []
        for s in summaries.values():
            cats += [c for c in s["by_category"] if c not in cats]
        for c in cats:
            out.append(f"| {c} | " + " | ".join(
                f"{s['by_category'][c]['passed']}/{s['by_category'][c]['n']}" if c in s["by_category"] else "-" for s in summaries.values()) + " |")
        out += ["", "### Per task", "", "| Task | Category | " + " | ".join(labels) + " | Failure reasons |", "|---|---|" + "---|" * len(labels) + "---|"]
        tids = []
        for s in summaries.values():
            tids += [t for t in s["by_task"] if t not in tids]
        for tid in tids:
            cat = next(s["by_task"][tid]["category"] for s in summaries.values() if tid in s["by_task"])
            reasons = []
            for lab, s in summaries.items():
                for r, n in (s["by_task"].get(tid, {}).get("reasons") or {}).items():
                    reasons.append(f"{lab}: {r} ×{n}")
            out.append(f"| {tid} | {cat} | " + " | ".join(
                f"{s['by_task'][tid]['passed']}/{s['by_task'][tid]['n']}" if tid in s["by_task"] else "-" for s in summaries.values())
                + " | " + ("; ".join(reasons) or "") + " |")
        lens = {lab: [n for t in s["by_task"].values() for n in t.get("completion_tokens", [])] for lab, s in summaries.items()}
        if any(lens.values()):
            out += ["", "| Answer length (tokens) | " + " | ".join(labels) + " |", "|---|" + "---|" * len(labels),
                    "| median | " + " | ".join(str(int(statistics.median(v))) if v else "-" for v in lens.values()) + " |",
                    "| max | " + " | ".join(str(max(v)) if v else "-" for v in lens.values()) + " |"]
        skipped = {lab: s["skipped"] for lab, s in summaries.items() if s.get("skipped")}
        if skipped:
            out += ["", "Skipped: " + "; ".join(f"{lab}: {x['id']} ({x['reason']})" for lab, xs in skipped.items() for x in xs)]
        out.append("")
    out += agent_tables(d)
    text = "\n".join(out) + "\n"
    (d / "tables.md").write_text(text)
    print(text)


# ---------- chart ----------

SURFACE, INK, INK2, MUTED, GRID, BAR = "#fcfcfb", "#0b0b0b", "#52514e", "#8a8984", "#e6e5e0", "#2a78d6"


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def nice_ticks(vmax, count=4):
    raw = vmax / count
    mag = 10 ** len(str(int(raw))) / 10 if raw >= 1 else 1
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    return [step * i for i in range(int(-(-vmax // step)) + 1)]


def bar_svg(title, subtitle, rows, unit, footnote, vmax=None):
    row_h, top, left, right, w = 64, 150, 300, 1080, 1200
    plot_bottom = top + row_h * len(rows)
    h = plot_bottom + 120
    ticks = nice_ticks(vmax or max(v for _, v in rows) * 1.08)
    vmax = ticks[-1]
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w * 2}" height="{h * 2}" viewBox="0 0 {w} {h}" font-family="Helvetica, Arial, PingFang SC, sans-serif">',
             f'<rect width="{w}" height="{h}" fill="{SURFACE}"/>',
             f'<text x="40" y="58" font-size="30" font-weight="700" fill="{INK}">{esc(title)}</text>',
             f'<text x="40" y="96" font-size="18" fill="{INK2}">{esc(subtitle)}</text>']
    for tick in ticks:
        x = left + (right - left) * tick / vmax
        parts.append(f'<line x1="{x:.1f}" y1="{top - 10}" x2="{x:.1f}" y2="{plot_bottom}" stroke="{GRID}" stroke-width="1"/>')
        parts.append(f'<text x="{x:.1f}" y="{plot_bottom + 24}" font-size="14" fill="{MUTED}" text-anchor="middle">{tick:g}</text>')
    for i, (label, value) in enumerate(rows):
        y = top + row_h * i
        bw = (right - left) * value / vmax
        parts.append(f'<text x="{left - 16}" y="{y + 30}" font-size="19" fill="{INK}" text-anchor="end">{esc(label)}</text>')
        parts.append(f'<rect x="{left}" y="{y + 6}" width="{bw:.1f}" height="36" rx="4" fill="{BAR}"/>')
        parts.append(f'<text x="{left + bw + 10:.1f}" y="{y + 31}" font-size="20" font-weight="700" fill="{INK}">{value:g}</text>')
    parts.append(f'<text x="{(left + right) / 2}" y="{plot_bottom + 54}" font-size="15" fill="{INK2}" text-anchor="middle">{esc(unit)}</text>')
    parts.append(f'<text x="40" y="{h - 20}" font-size="13" fill="{MUTED}">{esc(footnote)}</text>')
    parts.append("</svg>")
    return "\n".join(parts)


SERIES = ["#2a78d6", "#eb6834"]


def clip(s, n):
    s = str(s)
    return s if len(s) <= n else s[:n - 1] + "…"


def grouped_bar_svg(title, subtitle, groups, series, unit, footnote):
    """groups: [(label, {series: (value, detail) or None})]; values are percentages."""
    bar_h, bar_gap, group_gap, top, left, right, w = 30, 6, 30, 176, 340, 1040, 1200
    group_h = len(series) * bar_h + (len(series) - 1) * bar_gap
    plot_bottom = top + len(groups) * (group_h + group_gap) - group_gap
    h = plot_bottom + 120
    ticks = nice_ticks(100)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w * 2}" height="{h * 2}" viewBox="0 0 {w} {h}" font-family="Helvetica, Arial, PingFang SC, sans-serif">',
             f'<rect width="{w}" height="{h}" fill="{SURFACE}"/>',
             f'<text x="40" y="58" font-size="30" font-weight="700" fill="{INK}">{esc(title)}</text>',
             f'<text x="40" y="96" font-size="18" fill="{INK2}">{esc(subtitle)}</text>']
    x = 40
    for i, (name, desc) in enumerate(series):
        legend = f"{name} · {desc}" if desc else name
        parts.append(f'<rect x="{x}" y="120" width="14" height="14" rx="3" fill="{SERIES[i % len(SERIES)]}"/>')
        parts.append(f'<text x="{x + 22}" y="132" font-size="15" fill="{INK2}">{esc(legend)}</text>')
        x += 60 + 7.6 * len(legend)
    for tick in ticks:
        tx = left + (right - left) * tick / 100
        parts.append(f'<line x1="{tx:.1f}" y1="{top - 10}" x2="{tx:.1f}" y2="{plot_bottom + 6}" stroke="{GRID}" stroke-width="1"/>')
        parts.append(f'<text x="{tx:.1f}" y="{plot_bottom + 28}" font-size="14" fill="{MUTED}" text-anchor="middle">{tick:g}</text>')
    for gi, (label, values) in enumerate(groups):
        gy = top + gi * (group_h + group_gap)
        parts.append(f'<text x="40" y="{gy + group_h / 2 + 7:.1f}" font-size="19" font-weight="700" fill="{INK}">{esc(clip(label, 22))}</text>')
        for si, (name, _) in enumerate(series):
            y = gy + si * (bar_h + bar_gap)
            parts.append(f'<text x="{left - 14}" y="{y + 21}" font-size="15" fill="{INK2}" text-anchor="end">{esc(name)}</text>')
            cell = values.get(name)
            if cell is None:
                parts.append(f'<text x="{left + 10}" y="{y + 21}" font-size="15" fill="{MUTED}">skipped</text>')
                continue
            value, detail = cell
            bw = (right - left) * value / 100
            if bw > 0:
                parts.append(f'<rect x="{left}" y="{y}" width="{bw:.1f}" height="{bar_h}" rx="4" fill="{SERIES[si % len(SERIES)]}"/>')
            vx = left + bw + 10
            parts.append(f'<text x="{vx:.1f}" y="{y + 22}" font-size="19" font-weight="700" fill="{INK}">{value:g}%</text>')
            parts.append(f'<text x="{vx + 10.6 * len(f"{value:g}") + 26:.1f}" y="{y + 22}" font-size="15" fill="{MUTED}">{esc(detail)}</text>')
    parts.append(f'<text x="{(left + right) / 2}" y="{plot_bottom + 58}" font-size="15" fill="{INK2}" text-anchor="middle">{esc(unit)}</text>')
    parts.append(f'<text x="40" y="{h - 20}" font-size="13" fill="{MUTED}">{esc(footnote)}</text>')
    parts.append("</svg>")
    return "\n".join(parts)


def svg_to_png(svg_path, png_path):
    if sys.platform == "darwin" and shutil.which("sips"):
        r = subprocess.run(["sips", "-s", "format", "png", str(svg_path), "--out", str(png_path)], capture_output=True)
        if r.returncode == 0 and Path(png_path).exists():
            return "sips"
    if shutil.which("rsvg-convert"):
        r = subprocess.run(["rsvg-convert", "-o", str(png_path), str(svg_path)], capture_output=True)
        if r.returncode == 0:
            return "rsvg-convert"
    try:
        import cairosvg  # type: ignore

        cairosvg.svg2png(url=str(svg_path), write_to=str(png_path))
        return "cairosvg"
    except Exception:
        return None


def agent_chart_data(d):
    groups, series = [], []
    for p in sorted(d.glob("agent-summary-*.json")):
        s = json.loads(p.read_text())
        values = {}
        for cname, c in s["conditions"].items():
            series += [cname] if cname not in series else []
            values[cname] = (round(100 * c["passed"] / c["n"]) if c["n"] else 0, f"{c['passed']}/{c['n']}")
        for sk in s.get("skipped") or []:
            series += [sk["condition"]] if sk["condition"] not in series else []
        groups.append((s["label"], values))
    order = {"full": 0, "lean": 1}
    series.sort(key=lambda n: order.get(n, 2))
    return groups, series


def cmd_chart(args):
    d = Path(args.dir)
    rows = []
    if args.kind == "agent":
        groups, names = agent_chart_data(d)
        if not groups:
            sys.exit("no data for chart")
        desc = {"full": "real holaOS prompt and 30 tools", "lean": "short prompt, 8 core tools"}
        foot = args.footnote or f"agent-v1 pack · simulated workspace · program-graded · {time.strftime('%Y-%m-%d')}"
        svg = grouped_bar_svg(args.title, args.subtitle or "Agent task success: full holaOS request vs lean request", groups,
                              [(n, desc.get(n, "")) for n in names], "success rate, % of task runs", foot)
        svg_path = d / "agent.svg"
        svg_path.write_text(svg)
        converter = svg_to_png(svg_path, d / "agent.png")
        print(json.dumps({"svg": str(svg_path), "png": str(d / "agent.png") if converter else None, "converter": converter}))
        return
    if args.kind == "speed":
        for p in sorted(d.glob("speed-*.json")):
            s = json.loads(p.read_text())
            for row in s["depths"]:
                v = row.get("engine_decode_tps") or row.get("decode_tps")
                if v:
                    rows.append((f"{s['label']} · {row['depth'] // 1024}K ctx" if row["depth"] else f"{s['label']} · empty ctx", v))
        unit, default_sub = "decode speed, tokens / second (higher is faster)", "Decode speed by context depth"
    else:
        for p in sorted(d.glob("summary-*.json")):
            s = json.loads(p.read_text())
            for c, v in s["by_category"].items():
                rows.append((f"{s['label']} · {c}", round(100 * v["passed"] / v["n"]) if v["n"] else 0))
        unit, default_sub = "pass rate, % of samples", "Capability spot check"
    if not rows:
        sys.exit("no data for chart")
    manifest = d / "manifest.json"
    foot = args.footnote
    if not foot and manifest.exists():
        m = json.loads(manifest.read_text())
        mach = m.get("machine") or {}
        foot = f"{m.get('engine')} {m.get('engine_version') or ''} · {mach.get('cpu') or mach.get('machine')} · {mach.get('memory_gb') or '?'} GB · {time.strftime('%Y-%m-%d')}"
    svg = bar_svg(args.title, args.subtitle or default_sub, rows, unit, foot or "", vmax=100 if args.kind == "capability" else None)
    svg_path = d / f"{args.kind}.svg"
    svg_path.write_text(svg)
    converter = svg_to_png(svg_path, d / f"{args.kind}.png")
    print(json.dumps({"svg": str(svg_path), "png": str(d / f'{args.kind}.png') if converter else None, "converter": converter}))


# ---------- selftest ----------

def cmd_selftest(_args):
    assert boxed_int("so \\boxed{1,170}") == 1170
    assert boxed_int("no answer") is None
    assert run_python_tests("def f(x):\n    return x+1", "assert f(1)==2")[0]
    assert not run_python_tests("def f(x):\n    return x", "assert f(1)==2")[0]
    assert check_rules("- a\n- b\n- c", [{"lines_exact": 3}, {"each_line_startswith": "- "}])[0]
    assert not check_rules("Intro\n- a\n- b", [{"lines_exact": 3}, {"each_line_startswith": "- "}])[0]
    assert check_rules("可以离线运行的助手", [{"max_chars": 30}, {"must_include": "离线"}, {"no_latin": True}])[0]
    assert check_json('{"title":"x","tags":["a","b","c","d"]}', {"keys_exact": ["title", "tags"], "array_len": {"tags": 4}, "lowercase_array": ["tags"], "no_fence": True})[0]
    assert not check_json('```json\n{}\n```', {"no_fence": True})[0]
    call = {"tool_calls": [{"function": {"name": "search_flights", "arguments": '{"origin":"SFO","destination":"Tokyo","date":"2026-11-03"}'}}]}
    ok, reason = check_tool_call(call, {"name": "search_flights", "args": {"destination": {"one_of_ci": ["TYO", "NRT", "HND"]}}})
    assert not ok and "Tokyo" in reason
    assert check_identity("I am MiniCPM, developed by ModelBest.", ["MiniCPM", "ModelBest", "OpenBMB", "面壁"])[0]
    assert not check_identity("I am an AI assistant created by OpenAI.", ["MiniCPM", "ModelBest"])[0]
    assert check_identity("I am Qwen, created by Alibaba Cloud.", ["Qwen", "Alibaba"])[0]
    pack = load_pack(DEFAULT_PACK)
    ids = [t["id"] for t in pack["tasks"]]
    assert len(ids) == len(set(ids))
    for t in pack["tasks"]:
        assert "prompt" in t and "grader" in t, t["id"]
    assert normalize_base("localhost:8080") == "http://localhost:8080/v1"
    assert normalize_base("http://127.0.0.1:11434/v1/") == "http://127.0.0.1:11434/v1"
    agent_ids = selftest_agent()
    bench_ids = selftest_bench()
    print(f"selftest ok ({len(ids)} tasks in {pack['id']}, {len(agent_ids)} agent tasks, {len(bench_ids)} bench results)")


MERGE_OK = ("def merge_intervals(intervals):\n    out = []\n    for s, e in sorted(intervals):\n"
            "        if out and s <= out[-1][1]:\n            out[-1][1] = max(out[-1][1], e)\n"
            "        else:\n            out.append([s, e])\n    return out\n")


def fake_ollama(capabilities, model="m:q4", port=0, version="0.12.6"):
    """Minimal Ollama: version, tags, pull, show, ps and streaming chat. Returns (server, root, requests)."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    requests = []

    def script(prompt, body):
        if body.get("tools"):
            return [], [{"function": {"name": "search_flights", "arguments": {"origin": "SFO", "destination": "NRT", "date": "2026-11-03"}}}]
        if COUNT_PROMPT in prompt:
            return ["one", ", two"] * (body["options"]["num_predict"] // 2), None
        if "merge_intervals" in prompt:
            return ["<think>```python\ndef merge_intervals(x):\n    return x\n```</think>", f"```python\n{MERGE_OK}```"], None
        if "blue vault" in prompt:
            return ["<think>maybe 0000-AA</think>", "7391-QX"], None
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
                return self.reply({"version": version})
            if self.path == "/api/tags":
                return self.reply({"models": [{"name": model, "model": model, "digest": "fakedigest"}]})
            if self.path == "/api/ps":
                return self.reply({"models": [{"name": model, "model": model, "size": 2000, "size_vram": 1500}]})
            self.reply({"error": "not found"}, 404)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body))
            if self.path == "/api/show":
                return self.reply({"capabilities": capabilities})
            if self.path == "/api/pull":
                self.send_response(200)
                self.end_headers()
                for line in ({"status": "pulling manifest"}, {"status": "downloading", "completed": 1, "total": 1}, {"status": "success"}):
                    self.wfile.write(json.dumps(line).encode() + b"\n")
                return
            if body.get("tools") and "tools" not in capabilities:
                return self.reply({"error": f"{model} does not support tools"}, 400)
            prompt = body["messages"][-1]["content"]
            chunks, calls = script(prompt, body)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            for chunk in chunks:
                self.wfile.write(json.dumps({"message": {"role": "assistant", "content": chunk}, "done": False}).encode() + b"\n")
            if calls:
                self.wfile.write(json.dumps({"message": {"role": "assistant", "content": "", "tool_calls": calls}, "done": False}).encode() + b"\n")
            n = max(len(chunks), 1)
            self.wfile.write(json.dumps({"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop",
                                         "eval_count": n, "eval_duration": n * 10_000_000, "prompt_eval_count": len(prompt) // 4,
                                         "prompt_eval_duration": 20_000_000, "load_duration": 1_000_000}).encode() + b"\n")

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}", requests


def selftest_bench():
    import contextlib
    import io

    assert strip_think("<think>a</think>\nB") == "B" and strip_think("A<think>unfinished") == "A"
    assert speed_task_id(0) == "speed@0" and speed_task_id(8192) == "speed@8k"
    suite = load_pack(DEFAULT_SUITE)
    general = {t["id"]: t for t in load_pack(DEFAULT_PACK)["tasks"]}
    assert all(t == general[t["id"]] for t in suite["tasks"]), "suite tasks must stay identical to general-v1"

    def bench(capabilities, **overrides):
        server, root, requests = fake_ollama(capabilities)
        with tempfile.TemporaryDirectory() as d:
            ns = argparse.Namespace(base_url=root, model="m:q4", pack=str(DEFAULT_SUITE), subject=None, out=d,
                                    label="t", samples=None, only="")
            for key, value in overrides.items():
                setattr(ns, key, value)
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf):
                    cmd_bench(ns)
            finally:
                server.shutdown()
            record = json.loads((Path(d) / "bench-t.json").read_text())
        events = [json.loads(line) for line in buf.getvalue().splitlines()]
        return record, events, requests

    record, events, requests = bench(["completion", "tools"])
    by_task = {r["task"]: r for r in record["results"]}
    assert list(by_task) == ["speed@0", "speed@8k", "code-intervals", "tool-flight", "needle-8k"], list(by_task)
    for tid in ("code-intervals", "tool-flight", "needle-8k"):
        assert (by_task[tid]["passed"], by_task[tid]["samples"], by_task[tid]["pass"]) == (3, 3, True), (tid, by_task[tid]["reasons"])
    speed = by_task["speed@0"]["metrics"]
    assert len(speed["runs"]) == 3 and speed["decode_tps"] and speed["cpu_offload"] is True and speed["vram_bytes"] == 1500
    deep = [run["prompt_tokens"] for run in by_task["speed@8k"]["metrics"]["runs"]]
    assert all(abs(n - 8192) < 0.05 * 8192 for n in deep), f"8k depth not calibrated: {deep}"
    chats = [body for path, body in requests if path == "/api/chat"]
    assert all(body["options"]["num_ctx"] == suite["num_ctx"] and body["keep_alive"] == BENCH_KEEP_ALIVE for body in chats)
    count = [body for body in chats if COUNT_PROMPT in body["messages"][-1]["content"]]
    assert len(count) == 8 and all(b["options"]["temperature"] == 0 and b["options"]["num_predict"] == 256 for b in count)
    assert len({b["messages"][-1]["content"] for b in count}) == 8, "speed prompts must differ so Ollama cannot reuse its prompt cache"
    graded = [body for body in chats if body not in count and body["options"].get("num_predict") != 16]
    assert len(graded) == 9 and all(b["options"]["temperature"] == suite["sampling"]["temperature"] for b in graded)
    assert record["suite"]["id"] == "suite-standard" and len(record["suite"]["sha256"]) == 64
    kinds = [e["event"] for e in events]
    assert kinds[0] == "start" and kinds[-1] == "done" and "text" in kinds and kinds.count("sample_done") == 9
    assert sum(e["n"] for e in events if e["event"] == "text" and e["task"] == "speed@0") == 4 * 256

    record, _, requests = bench(["completion"], only="tool-flight")
    assert record["results"][0]["status"] == "unsupported" and record["results"][0]["pass"] is None
    assert not any(body.get("tools") for path, body in requests if path == "/api/chat")
    return list(by_task)


def scripted_model(steps):
    """Fake chat endpoint: each step is a list of (tool, args) calls or a final string."""
    steps = list(steps)

    def send(payload):
        step = steps.pop(0) if steps else "out of script"
        usage = {"prompt_tokens": len(json.dumps(payload["messages"])) // 4, "completion_tokens": 5}
        if isinstance(step, str):
            msg = {"role": "assistant", "content": step}
        else:
            msg = {"role": "assistant", "content": "", "tool_calls": [
                {"id": f"c{i}", "type": "function", "function": {"name": n, "arguments": a if isinstance(a, str) else json.dumps(a)}}
                for i, (n, a) in enumerate(step)]}
        return {"choices": [{"message": msg, "finish_reason": "stop" if isinstance(step, str) else "tool_calls"}], "usage": usage}

    return send


def selftest_agent():
    vfs = VFS({"a/b.txt": "one\ntwo\nthree\n", "a/c.md": "# C\n", "empty/": None})
    assert vfs.isdir("/workspace/a") and vfs.isdir("/workspace/empty") and vfs.isfile("/workspace/a/b.txt")
    assert vfs.resolve("a/../a/./b.txt") == "/workspace/a/b.txt" and vfs.resolve("/etc/x") == "/etc/x"
    assert vfs.listdir("/workspace") == [("a", True), ("empty", True)]
    assert tool_read(vfs, {"path": "a/b.txt", "offset": 2, "limit": 1}) == ("two", False)
    assert tool_read(vfs, {"path": "nope.txt"})[1]
    assert tool_ls(vfs, {"path": "a"})[0] == "b.txt\nc.md"
    assert tool_edit(vfs, {"path": "a/b.txt", "edits": [{"oldText": "two", "newText": "2"}]})[1] is False
    assert vfs.files["/workspace/a/b.txt"] == "one\n2\nthree\n" and vfs.changes() == {"a/b.txt": "one\n2\nthree\n"}
    assert "not found in the file" in tool_edit(vfs, {"path": "a/b.txt", "edits": [{"oldText": "zzz", "newText": "x"}]})[0]
    assert "invalid" in tool_edit(vfs, {"path": "a/b.txt", "old_string": "one", "new_string": "1"})[0]
    assert "File not found" in tool_edit(vfs, {"path": "new.md", "edits": [{"oldText": "a", "newText": "b"}]})[0]
    assert tool_search(vfs, {"pattern": "thr", "path": "a"})[0] == "a/b.txt\n  3: three"
    assert tool_find(vfs, {"paths": ["*.md"]})[0] == "a/c.md"
    assert json.loads(tool_search_web(vfs, {"query": "rust release"})[0])["query"] == "rust release"
    assert execute_tool(vfs, "cronjobs", {}, ["cronjobs"]) == ('{"ok": true, "results": []}', False)
    assert execute_tool(vfs, "write", {"path": "x", "content": "y"}, ["read"])[1]

    sh = lambda cmd: BashSim(vfs).run(cmd)
    assert sh("ls a") == ("b.txt\nc.md\n", 0)
    assert sh("wc -l a/b.txt") == ("3 a/b.txt\n", 0)
    assert sh("cat a/b.txt | wc -l") == ("3\n", 0)
    assert sh("head -n 1 a/b.txt") == ("one\n", 0)
    assert sh("grep -c e a/b.txt") == ("2\n", 0)
    assert sh("grep -rn three .") == ("a/b.txt:3:three\n", 0)
    assert sh("ls a/*.md") == ("a/c.md\n", 0)
    assert sh("ls a/b.txt a/c.md") == ("a/b.txt\na/c.md\n", 0)
    assert sh("tail -n +2 a/b.txt|wc -l") == ("2\n", 0)
    assert sh("mkdir -p x/y && echo hi > x/y/z.txt && cat x/y/z.txt") == ("hi\n", 0)
    assert sh("echo more >> x/y/z.txt; cat x/y/z.txt") == ("hi\nmore\n", 0)
    assert sh("cat > notes.md <<'EOF'\n- a.md\n- b.md\nEOF\nwc -l notes.md") == ("2 notes.md\n", 0)
    assert sh("printf '%s\\n' one two > p.txt && cat p.txt") == ("one\ntwo\n", 0)
    assert sh("find a -type f -name '*.txt'") == ("a/b.txt\n", 0)
    out, code = sh("python3 -c 'print(1)'")
    assert code == 127 and "command not available in this sandbox" in out
    out, code = sh("cat missing.txt && echo never")
    assert code == 1 and "never" not in out
    assert sh("false || echo fallback") == ("fallback\n", 0)
    assert sh("cat nope.txt 2>/dev/null; ls a") == ("cat: nope.txt: No such file or directory\nb.txt\nc.md\n", 0)
    assert sh("cat -A a/c.md") == ("# C\n", 0)
    assert "command not available" in sh("rm a/b.txt")[0] and vfs.isfile("/workspace/a/b.txt")
    assert sh("echo x > nodir/f.txt")[1] == 1
    assert bash_mutates("mv a b") and bash_mutates("echo x > f") and bash_mutates("sed -i '' s/a/b/ f")
    assert not bash_mutates("ls -la 2>/dev/null") and not bash_mutates("grep 'a > b' f") and not bash_mutates("cat f 2>&1")

    tools = ["read", "bash"]
    assert looks_like_text_tool_call('<tool_call>{"name": "read", "arguments": {}}</tool_call>', tools)
    assert looks_like_text_tool_call('```json\n{"name": "bash", "arguments": {"command": "ls"}}\n```', tools)
    assert not looks_like_text_tool_call("The port is 6432.", tools)

    pack = load_agent_pack(DEFAULT_AGENT_PACK)
    full = load_agent_condition(DEFAULT_AGENT_PACK, pack, "full")
    lean = load_agent_condition(DEFAULT_AGENT_PACK, pack, "lean")
    assert len(lean["tools"]) == 8 and all(t in full["tools"] for t in lean["tools"])
    assert pack["conditions"]["full"]["tool_count"] == len(full["tools"])
    for text in (full["system"], json.dumps(full["tools"])):
        assert not re.search(r"/Users/|/private/|/home/\w", text)
    active, skipped = plan_conditions({"full": full, "lean": lean}, pack["tasks"], 8192)
    assert active == ["lean"] and skipped[0]["condition"] == "full" and "8192" in skipped[0]["reason"]
    assert plan_conditions({"full": full, "lean": lean}, pack["tasks"], None) == (["full", "lean"], [])
    assert plan_conditions({"full": full, "lean": lean}, pack["tasks"], 32768)[0] == ["full", "lean"]

    heredoc = "cat > notes/INDEX.md <<'EOF'\n- 2026-03-02-meeting.md\n- budget.csv\n- ideas.md\n- reading-list.md\nEOF"
    ask = ("ask_user_question", {"question": {"prompt": "Which report?", "options": [{"label": "q1"}, {"label": "q2"}]}})
    fenced = '```json\n["hero.png", "icon-192.png", "screenshot-home.png"]\n```'
    cases = {
        "read-config": ([[("read", {"path": "config/app.yaml"})], "6432"], [
            (["6432"], "answered without using read/bash/search"),
            ([[("read", {"path": "config/app.yaml"})], "6432 (the server uses 8080)"], "answer also mentions '8080'"),
            (['<tool_call>{"name": "read", "arguments": {"path": "config/app.yaml"}}</tool_call>'], "tool call written as text"),
            ([[("read", "{not json")], "6432"], "answered without using read/bash/search")]),
        "edit-json": ([[("edit", {"path": "settings.json", "edits": [{"oldText": '"max_items": 50', "newText": '"max_items": 200'}]})], "Done."], [
            ([[("edit", {"path": "settings.json", "old_string": "50", "new_string": "200"})], "Done."], "max_items=50, expected 200"),
            ([[("bash", {"command": "echo '{\"max_items\": 200}' > settings.json"})], "Done."], "theme was removed")]),
        "count-csv": ([[("bash", {"command": "wc -l data/orders.csv"})], "37"], [
            ([[("bash", {"command": "wc -l data/orders.csv"})], "38"], "answered 38, expected 37")]),
        "index-notes": ([[("bash", {"command": heredoc})], "Created notes/INDEX.md."], [
            ([[("bash", {"command": "echo '- ideas.md' > notes/INDEX.md"})], "Done."], "notes/INDEX.md has no bullet for 2026-03-02-meeting.md"),
            ([[("write", {"path": "notes/INDEX.md", "content": "- ideas.md\n"})], "Done."], "notes/INDEX.md not created")]),
        "web-lookup": ([[("memory_retrieve", {"query": "rust"})], [("search_web", {"query": "latest stable Rust release"})], "I could not confirm it."], [
            (["Rust 1.80."], "never called search_web")]),
        "no-tool-math": (["391"], [
            ([[("memory_retrieve", {"query": "17*23"})], "391"], "called a tool when none was needed (memory_retrieve)")]),
        "ambiguous-rename": ([[("ls", {"path": "reports"})], [ask], "Which report should I rename?"], [
            ([[("bash", {"command": "mv reports/q1-summary.md reports/final.md"})], "Renamed."], "tried to change files without asking (bash)"),
            (["Which report do you mean?"], "asked in plain text instead of ask_user_question")]),
        "json-filenames": ([[("ls", {"path": "assets"})], '["hero.png", "icon-192.png", "screenshot-home.png"]'], [
            ([[("ls", {"path": "assets"})], fenced], "wrapped in a code fence"),
            ([[("ls", {"path": "assets"})], 'Here: ["hero.png"]'], "not only a JSON array"),
            ([[("ls", {"path": "assets"})], '["assets/hero.png"]'], "names ['assets/hero.png'] != ['hero.png', 'icon-192.png', 'screenshot-home.png']")]),
    }
    assert set(cases) == {t["id"] for t in pack["tasks"]}
    run = lambda task, steps, turns=6: run_agent_task(scripted_model(steps), "m", task, 0, full, {}, "llamacpp", turns, 100,
                                                      pack.get("vfs_base"), pack["workspace"])
    for task in pack["tasks"]:
        good, bad = cases[task["id"]]
        rec = run(task, good)
        assert rec["passed"], (task["id"], rec["reason"], rec["tool_calls"])
        for steps, reason in bad:
            rec = run(task, steps)
            assert not rec["passed"] and rec["reason"] == reason, (task["id"], rec["reason"], reason)
    loop = run(pack["tasks"][0], [[("ls", {})]] * 6)
    assert loop["reason"] == "no final answer within 6 turns" and loop["turns"] == 6
    notes = next(t for t in pack["tasks"] if t["id"] == "index-notes")
    assert run(notes, [[("bash", {"command": heredoc})]] * 6)["reason"] == "no final answer within 6 turns (work was correct)"
    files = next(t for t in pack["tasks"] if t["id"] == "json-filenames")
    assert run(files, [[("ls", {"path": "assets"})], '["assets/hero.png", "assets/icon-192.png", "assets/screenshot-home.png"]'])["passed"]
    web = next(t for t in pack["tasks"] if t["id"] == "web-lookup")
    rec = run(web, [[("search_web", {"query": "rust stable"})], "Rust 1.92.0"])
    assert rec["passed"] and "1.92.0" in rec["tool_calls"][0]["result"]

    def overflow(payload):
        raise RuntimeError("HTTP 400: the request exceeds the available context size")

    rec = run_agent_task(overflow, "m", pack["tasks"][0], 0, full, {}, "llamacpp", 6, 100, None, pack["workspace"])
    assert rec["reason"] == "request failed: context window exceeded"
    return list(cases)


def main():
    ap = argparse.ArgumentParser(prog="holaeval")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe")
    p.add_argument("--base-url", required=True)
    p.add_argument("--model")
    p.add_argument("--out")
    p.add_argument("--hash-model-file", action="store_true")
    p.set_defaults(fn=cmd_probe)
    p = sub.add_parser("run")
    p.add_argument("--base-url", required=True)
    p.add_argument("--model")
    p.add_argument("--pack", default=str(DEFAULT_PACK))
    p.add_argument("--out", required=True)
    p.add_argument("--label", default="main")
    p.add_argument("--samples", type=int)
    p.add_argument("--parallel", type=int, default=1)
    p.add_argument("--only", default="")
    p.add_argument("--identity", default="")
    p.add_argument("--context-window", type=int)
    p.add_argument("--quick", action="store_true")
    p.add_argument("--temperature", type=float)
    p.add_argument("--top-p", dest="top_p", type=float)
    p.add_argument("--min-p", dest="min_p", type=float)
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser("speed")
    p.add_argument("--base-url", required=True)
    p.add_argument("--model")
    p.add_argument("--out", required=True)
    p.add_argument("--label", default="main")
    p.add_argument("--depths", default="0,8192,32768")
    p.add_argument("--gen", type=int, default=256)
    p.add_argument("--reps", type=int, default=3)
    p.add_argument("--concurrency", default="")
    p.add_argument("--context-window", type=int)
    p.set_defaults(fn=cmd_speed)
    p = sub.add_parser("bench")
    p.add_argument("--base-url", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--pack", default=str(DEFAULT_SUITE))
    p.add_argument("--subject")
    p.add_argument("--out", required=True)
    p.add_argument("--label", default="main")
    p.add_argument("--samples", type=int)
    p.add_argument("--only", default="")
    p.set_defaults(fn=cmd_bench)
    p = sub.add_parser("agent")
    p.add_argument("--base-url", required=True)
    p.add_argument("--model")
    p.add_argument("--pack", default=str(DEFAULT_AGENT_PACK))
    p.add_argument("--out", required=True)
    p.add_argument("--label", default="main")
    p.add_argument("--conditions", default="full,lean")
    p.add_argument("--samples", type=int)
    p.add_argument("--max-turns", dest="max_turns", type=int)
    p.add_argument("--parallel", type=int, default=1)
    p.add_argument("--only", default="")
    p.add_argument("--context-window", type=int)
    p.add_argument("--temperature", type=float)
    p.add_argument("--top-p", dest="top_p", type=float)
    p.add_argument("--min-p", dest="min_p", type=float)
    p.set_defaults(fn=cmd_agent)
    p = sub.add_parser("tables")
    p.add_argument("--dir", required=True)
    p.set_defaults(fn=cmd_tables)
    p = sub.add_parser("chart")
    p.add_argument("--dir", required=True)
    p.add_argument("--kind", choices=["speed", "capability", "agent"], default="speed")
    p.add_argument("--title", required=True)
    p.add_argument("--subtitle")
    p.add_argument("--footnote")
    p.set_defaults(fn=cmd_chart)
    p = sub.add_parser("selftest")
    p.set_defaults(fn=cmd_selftest)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
