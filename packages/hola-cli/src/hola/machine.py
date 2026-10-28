"""This machine: the engine's own hardware reading, the pre-run busy sample, and what `hola doctor` reports."""

import functools
import importlib.util
import re
import subprocess
import sys
import time
from pathlib import Path

from hola import pinned
from hola.record import js_round


@functools.lru_cache(maxsize=None)
def engine():
    """holaeval.py from the pinned copy, so the CLI describes the machine exactly as a run records it."""
    spec = importlib.util.spec_from_file_location("hola_holaeval", pinned.holaeval_path())
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def machine_info():
    return engine().machine_info()


def cpu_times():
    """(busy, total) CPU time across all cores, counted the way Node's os.cpus() counts it for the desktop."""
    if sys.platform.startswith("linux"):
        with open("/proc/stat") as f:
            user, nice, system, idle, _iowait, irq = ([int(v) for v in f.readline().split()[1:7]] + [0] * 6)[:6]
        busy = user + nice + system + irq
        return busy, busy + idle
    if sys.platform == "darwin":
        return engine().read_cpu_ticks()
    if sys.platform == "win32":
        import ctypes
        idle, kernel, user = ctypes.c_ulonglong(), ctypes.c_ulonglong(), ctypes.c_ulonglong()
        if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        return kernel.value - idle.value + user.value, kernel.value + user.value
    return None


def measure_cpu_busy(window_s=None, times=cpu_times, sleep=time.sleep):
    """Share of CPU time spent busy across all cores over a short window: measureCpuBusy in bench-runner.ts."""
    window_s = pinned.conditions()["busy_sample_ms"] / 1000 if window_s is None else window_s
    try:
        before = times()
        sleep(window_s)
        after = times()
    except (OSError, ValueError, AttributeError):
        return None
    if before is None or after is None:
        return None
    total = after[1] - before[1]
    return js_round((after[0] - before[0]) / total * 100) if total > 0 else None


def gpu_memory_gb(gpus):
    """Total memory of "<name>, <MiB> MiB" GPU entries, in GB."""
    mib = sum(int(m.group(1)) for gpu in gpus or [] if (m := re.search(r",\s*(\d+)\s*MiB$", gpu)))
    return round(mib / 1024, 1)


def memory_shortfall(subject, hw):
    """Why this machine can't hold the model, per its min_memory_gb; None when it can or we can't tell."""
    need = subject.get("min_memory_gb")
    ram = hw.get("memory_gb")
    if not isinstance(need, (int, float)) or not isinstance(ram, (int, float)):
        return None
    vram = gpu_memory_gb(hw.get("gpus"))
    if ram >= need or vram >= need:
        return None
    return {"min_memory_gb": need, "memory_gb": ram, "gpu_memory_gb": vram}


def free_memory_gb():
    """Memory the OS could hand a model right now, or None."""
    try:
        if sys.platform.startswith("linux"):
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemAvailable:"):
                    return round(int(line.split()[1]) / 2**20, 1)
        elif sys.platform == "darwin":
            out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
            page = int(re.search(r"page size of (\d+) bytes", out).group(1))
            pages = {m.group(1): int(m.group(2)) for m in re.finditer(r"^Pages ([\w ]+):\s+(\d+)\.", out, re.M)}
            free = sum(pages.get(k, 0) for k in ("free", "inactive", "speculative", "purgeable"))
            return round(free * page / 2**30, 1)
        elif sys.platform == "win32":
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong)] + [
                    (name, ctypes.c_ulonglong) for name in ("total", "avail", "page_total", "page_avail",
                                                            "virtual_total", "virtual_avail", "extended")]
            status = MemoryStatus()
            status.dwLength = ctypes.sizeof(MemoryStatus)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return round(status.avail / 2**30, 1)
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        pass
    return None


def summary(hw):
    """The machine as people say it, as the desktop and HolaHub label it: "Apple M5 Pro · 48 GB" or "RTX 4090 24 GB · 64 GB RAM"."""
    gpus = hw.get("gpus") or []
    memory = f"{hw['memory_gb']} GB" if hw.get("memory_gb") else ""
    if gpus:
        name = re.sub(r"^NVIDIA\s+(GeForce\s+)?", "", gpus[0], flags=re.I)
        name = re.sub(r",\s*(\d+)\s*MiB$", lambda m: f" {js_round(int(m.group(1)) / 1024)} GB", name, flags=re.I)
        name = re.sub(r",\s*", " ", name)
        label = " · ".join(part for part in (name, f"{memory} RAM" if memory else "") if part)
        return label + (f" (+{len(gpus) - 1} more GPU{'s' if len(gpus) > 2 else ''})" if len(gpus) > 1 else "")
    return " · ".join(part for part in (hw.get("cpu") or "Unknown machine", memory) if part)
