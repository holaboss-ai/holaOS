#!/usr/bin/env python3
"""What a container lets a sandboxed child do. Prints one JSON object; stdlib only, safe to run anywhere Linux."""

import ctypes
import errno
import json
import os
import platform
import resource
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile

CLONE_NEWNS = 0x00020000
CLONE_NEWUSER = 0x10000000
CLONE_NEWNET = 0x40000000
PR_SET_NO_NEW_PRIVS = 38
NOBODY = 65534
OUTSIDE = ("1.1.1.1", 443)


def libc():
    return ctypes.CDLL(None, use_errno=True)


def unshare(flags):
    if libc().unshare(flags) != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


def drop_to_nobody():
    os.setgroups([])
    os.setgid(NOBODY)
    os.setuid(NOBODY)


def can_connect(address=OUTSIDE, timeout=3):
    try:
        with socket.create_connection(address, timeout=timeout):
            return True
    except OSError as exc:
        return f"no: {exc}"


def attempt(fn):
    try:
        fn()
        return True
    except OSError as exc:
        return f"no: {exc.strerror}"


def in_child(fn, timeout=20):
    """Runs fn in a forked child, so namespaces and uid changes never touch this process."""
    read_end, write_end = os.pipe()
    pid = os.fork()
    if pid == 0:
        # A forked child must never return into the parent's code, whatever fails.
        try:
            os.close(read_end)
            try:
                out = fn()
            except BaseException as exc:
                out = {"failed": f"{type(exc).__name__}: {exc}"}
            os.write(write_end, json.dumps(out, default=str).encode())
        finally:
            os._exit(0)
    os.close(write_end)
    with os.fdopen(read_end) as pipe:
        ready, _, _ = select.select([pipe], [], [], timeout)
        data = pipe.read() if ready else ""
    if not ready:
        os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    if not ready:
        return {"failed": f"no answer in {timeout} s"}
    return json.loads(data) if data else {"failed": "child exited silently"}


def status_fields():
    keep = {"Uid", "Gid", "CapEff", "CapBnd", "NoNewPrivs", "Seccomp"}
    with open("/proc/self/status", encoding="utf-8") as f:
        pairs = (line.split(":", 1) for line in f if ":" in line)
        return {k: v.strip() for k, v in pairs if k in keep}


def read_text(path, limit=300):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(limit).strip()
    except OSError as exc:
        return f"unreadable: {exc.strerror}"


def run(cmd, timeout=20, **kwargs):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kwargs)
        return {"code": p.returncode, "out": p.stdout.strip()[:800], "err": p.stderr.strip()[:400]}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"failed": f"{type(exc).__name__}: {exc}"}


def identity():
    total_kb = next((int(line.split()[1]) for line in open("/proc/meminfo") if line.startswith("MemTotal")), 0)
    return {
        "status": status_fields(),
        "kernel": read_text("/proc/version"),
        "dmesg": run(["dmesg"], timeout=5).get("out", "")[:400],
        "machine": platform.machine(),
        "python": sys.version.split()[0],
        "python_path": os.path.realpath(sys.executable),
        "home": os.path.expanduser("~"),
        "home_mode": oct(os.stat(os.path.expanduser("~")).st_mode & 0o777),
        "cpus": os.cpu_count(),
        "memory_gb": round(total_kb / 2**20, 1),
        "tmp_free_gb": round(shutil.disk_usage(tempfile.gettempdir()).free / 2**30, 1),
        "max_user_namespaces": read_text("/proc/sys/user/max_user_namespaces"),
    }


def gpu():
    return {
        "nvidia_smi": run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"]),
        "devices": sorted(n for n in os.listdir("/dev") if n.startswith("nvidia")),
    }


def network_namespace():
    def plain():
        unshare(CLONE_NEWNET)
        return {"outside": can_connect(), "uid": os.getuid()}

    def with_user_namespace():
        unshare(CLONE_NEWUSER | CLONE_NEWNET)
        return {"outside": can_connect(), "uid": os.getuid()}

    return {"baseline_outside": can_connect(), "unshare_net": in_child(plain), "unshare_user_net": in_child(with_user_namespace)}


def install_network_filter():
    arch, socket_nr = {"x86_64": (0xC000003E, 41), "aarch64": (0xC00000B7, 198)}[platform.machine()]
    deny, allow = 0x00050000 | errno.EPERM, 0x7FFF0000
    load, jeq, jge, ret = 0x20, 0x15, 0x35, 0x06

    def ins(code, k=0, jt=0, jf=0):
        return struct.pack("=HBBI", code, jt, jf, k)

    program = b"".join([
        ins(load, 4), ins(jeq, arch, 1, 0), ins(ret, deny),
        ins(load, 0), ins(jge, 0x40000000, 0, 1), ins(ret, deny),
        ins(jeq, 425, 0, 1), ins(ret, deny),
        ins(jeq, socket_nr, 1, 0), ins(ret, allow),
        ins(load, 16), ins(jeq, socket.AF_UNIX, 0, 1), ins(ret, allow), ins(ret, deny),
    ])

    class Prog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]

    buffer = ctypes.create_string_buffer(program, len(program))
    prog = Prog(len(program) // 8, ctypes.cast(buffer, ctypes.c_void_p))
    if libc().prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 or libc().prctl(22, 2, ctypes.byref(prog), 0, 0) != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


def seccomp_network():
    def child():
        install_network_filter()
        left, right = socket.socketpair()
        left.close()
        right.close()
        return {"outside": can_connect(), "loopback": can_connect(("127.0.0.1", 11531)),
                "ipv6": attempt(lambda: socket.socket(socket.AF_INET6).close()), "unix_ok": True}

    return in_child(child)


def uid_drop():
    secret_dir = tempfile.mkdtemp(prefix="probe-secret-")
    os.chmod(secret_dir, 0o700)
    secret = os.path.join(secret_dir, "hidden")
    with open(secret, "w", encoding="utf-8") as f:
        f.write("hidden")
    parent = os.getpid()

    def child():
        drop_to_nobody()
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        home = os.path.expanduser("~")
        return {
            "uid": os.getuid(),
            "read_private_dir": attempt(lambda: open(secret).read()),
            "write_home": attempt(lambda: open(os.path.join(home, "probe-write"), "w").close()),
            "read_parent_environ": attempt(lambda: open(f"/proc/{parent}/environ").read()),
            "signal_parent": attempt(lambda: os.kill(parent, 0)),
        }

    out = in_child(child)
    shutil.rmtree(secret_dir, ignore_errors=True)
    return out


def full_stack():
    """The stack the engine uses: seccomp network filter, nobody, then exec Python."""
    work = tempfile.mkdtemp(prefix="probe-work-")
    os.chmod(work, 0o711)
    run_dir = os.path.join(work, "run")
    os.mkdir(run_dir)
    os.chown(run_dir, NOBODY, NOBODY)

    def preexec():
        install_network_filter()
        drop_to_nobody()
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))

    script = ("import json,os,socket\n"
              "def try_(f):\n"
              "    try:\n        f()\n        return True\n    except OSError as e:\n        return str(e)\n"
              "print(json.dumps({'uid': os.getuid(),\n"
              " 'outside': try_(lambda: socket.create_connection(('1.1.1.1', 443), timeout=3).close()),\n"
              " 'loopback': try_(lambda: socket.create_connection(('127.0.0.1', 11531), timeout=3).close()),\n"
              " 'write_run_dir': try_(lambda: open('probe-ok', 'w').close()),\n"
              " 'write_tmp': try_(lambda: open('/tmp/probe-escape', 'w').close()),\n"
              " 'write_home': try_(lambda: open(os.path.expanduser('~root/probe-escape'), 'w').close())}))\n")
    try:
        p = subprocess.run([os.path.realpath(sys.executable), "-I", "-B", "-c", script], cwd=run_dir, capture_output=True,
                           text=True, timeout=20, preexec_fn=preexec, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        return {"code": p.returncode, "out": json.loads(p.stdout) if p.stdout.startswith("{") else p.stdout[:300],
                "err": p.stderr[:300]}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"failed": f"{type(exc).__name__}: {exc}"}
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if os.path.exists("/tmp/probe-escape"):
            os.remove("/tmp/probe-escape")


def bubblewrap():
    if not shutil.which("bwrap"):
        return {"present": False}
    return {"present": True, "unshare_net": run(["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "true"])}


def main():
    print(json.dumps({
        "identity": identity(),
        "gpu": gpu(),
        "seccomp_network": seccomp_network(),
        "network_namespace": network_namespace(),
        "mount_namespace": in_child(lambda: (unshare(CLONE_NEWNS), {"ok": True})[1]),
        "uid_drop": uid_drop(),
        "full_stack": in_child(full_stack, timeout=60),
        "bubblewrap": bubblewrap(),
        "ollama": run(["ollama", "--version"]),
    }, indent=1, default=str))


if __name__ == "__main__":
    main()
