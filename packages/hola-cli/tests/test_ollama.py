import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import support
from hola import ollama
from hola.errors import HolaError


class OllamaHelpersTest(unittest.TestCase):
    def test_binary_candidates_cover_the_official_installs(self):
        self.assertIn("/Applications/Ollama.app/Contents/Resources/ollama", ollama.binary_candidates("darwin", {}, "/Users/u"))
        self.assertEqual(ollama.binary_candidates("win32", {"LOCALAPPDATA": "C:\\Users\\u\\AppData\\Local"}, "C:\\Users\\u")[0],
                         "C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe")
        self.assertIn("/usr/local/bin/ollama", ollama.binary_candidates("linux", {}, "/home/u"))
        self.assertEqual(ollama.find_binary(["/a", "/b"], exists=lambda f: f == "/b", env={}), "/b")
        self.assertEqual(ollama.find_binary(["/a"], exists=lambda f: False, which=lambda name: "/opt/x/ollama", env={}),
                         "/opt/x/ollama")
        self.assertIsNone(ollama.find_binary([], which=lambda name: None, env={}))

    def test_models_dir_follows_ollama_models(self):
        self.assertEqual(ollama.default_models_dir({}, "/Users/u"), str(Path("/Users/u/.ollama/models")))
        self.assertEqual(ollama.default_models_dir({"OLLAMA_MODELS": "/Volumes/x"}, "/Users/u"), "/Volumes/x")

    def test_versions_compare_like_the_desktop(self):
        self.assertEqual(ollama.compare_versions("0.12.10", "0.12.9"), 1)
        self.assertEqual(ollama.compare_versions("0.12.6", "0.12.6"), 0)
        self.assertEqual(ollama.compare_versions("0.12.6-rc1", "0.12.6"), -1)
        self.assertEqual(ollama.compare_versions("v1.0", "0.99.99"), 1)

    def test_bench_env_drops_the_users_ollama_settings_and_pins_ours(self):
        env = ollama.bench_env({"PATH": "/bin", "OLLAMA_FLASH_ATTENTION": "0", "OLLAMA_KV_CACHE_TYPE": "q8_0"}, 4321, "/m")
        self.assertEqual(env["PATH"], "/bin")
        self.assertNotIn("OLLAMA_FLASH_ATTENTION", env)
        self.assertEqual(env["OLLAMA_KV_CACHE_TYPE"], "f16")
        self.assertEqual((env["OLLAMA_HOST"], env["OLLAMA_MODELS"]), ("127.0.0.1:4321", "/m"))
        self.assertEqual(ollama.bench_env({}, 1, "/m", "http://127.0.0.1:7897")["HTTPS_PROXY"], "http://127.0.0.1:7897")
        own = ollama.bench_env({"https_proxy": "http://corp:3128"}, 1, "/m", "http://127.0.0.1:7897")
        self.assertNotIn("HTTPS_PROXY", own)

    def test_the_os_proxy_is_read_from_scutil_and_the_registry(self):
        scutil = "<dictionary> {\n  HTTPEnable : 1\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n}"
        self.assertEqual(ollama.parse_scutil_proxy(scutil), "http://127.0.0.1:7897")
        self.assertIsNone(ollama.parse_scutil_proxy(scutil.replace("HTTPSEnable : 1", "HTTPSEnable : 0")))
        reg = "\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n"
        self.assertEqual(ollama.parse_windows_proxy(reg), "http://127.0.0.1:7890")
        self.assertEqual(ollama.parse_windows_proxy(reg.replace("127.0.0.1:7890", "http=10.0.0.1:80;https=10.0.0.2:8443")),
                         "http://10.0.0.2:8443")
        self.assertIsNone(ollama.parse_windows_proxy(reg.replace("0x1", "0x0")))

    def test_the_users_server_follows_ollama_host(self):
        self.assertEqual(ollama.user_base_url({}), "http://127.0.0.1:11434")
        self.assertEqual(ollama.user_base_url({"OLLAMA_HOST": "0.0.0.0:9000"}), "http://127.0.0.1:9000")
        self.assertEqual(ollama.user_base_url({"OLLAMA_HOST": "http://box.lan:11434/"}), "http://box.lan:11434")

    def test_a_fake_ip_failure_names_the_host_not_the_signed_url(self):
        # Ollama 0.40.10 in a container behind Clash fake-ip DNS, signature shortened.
        reason = ('max retries exceeded: Get "https://dd20bb89.r2.cloudflarestorage.com/ollama/docker/registry/v2/blobs/'
                  'sha256/5d/5ddf/data?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=b966": redirect target not '
                  'allowed: dd20bb89.r2.cloudflarestorage.com resolves to non-public 198.18.0.106')
        err = ollama.pull_failure("qwen3.5:2b-q4_K_M", reason)
        self.assertEqual(err.message, "Pulling qwen3.5:2b-q4_K_M failed: the download host "
                                      "dd20bb89.r2.cloudflarestorage.com resolved to 198.18.0.106, a private address.")
        self.assertIn("export HTTPS_PROXY=", err.next_step)
        self.assertNotIn("X-Amz", err.message)

    def test_pull_failures_name_the_next_step(self):
        cases = {
            "pull model manifest: dial tcp: lookup registry.ollama.ai: no such host": "internet connection",
            "registry.ollama.ai resolves to non-public address 198.18.0.5": "fake-ip",
            "proxyconnect tcp: dial tcp 127.0.0.1:7897: connect: connection refused": "proxy",
            "pull model manifest: file does not exist": "hola list",
        }
        for reason, hint in cases.items():
            err = ollama.pull_failure("m:q4", reason)
            self.assertEqual(err.code, "pull_failed")
            self.assertIn(hint, err.next_step)
        manifest = 'pull model manifest: Get "https://registry.ollama.ai/v2/library/q/manifests/2b": proxyconnect tcp: refused'
        self.assertEqual(ollama.pull_failure("q:2b", manifest).message,
                         "Pulling q:2b failed: pull model manifest: registry.ollama.ai: proxyconnect tcp: refused.")


@unittest.skipIf(os.name == "nt", "the fake ollama is a shell script")
class InstanceTest(unittest.TestCase):
    def test_a_binary_that_exits_at_once_reports_its_last_words(self):
        with tempfile.TemporaryDirectory() as d:
            binary = Path(d, "ollama")
            binary.write_text('#!/bin/sh\necho "Error: listen tcp: address already in use" >&2\nexit 1\n')
            binary.chmod(0o755)
            instance = ollama.OllamaInstance(str(binary), Path(d, "state"), support.free_port(), env={"PATH": ""})
            with self.assertRaises(HolaError) as caught:
                instance.start()
            self.assertEqual(caught.exception.code, "start_failed")
            self.assertIn("address already in use", caught.exception.message)

    def start_elsewhere(self, box, state, stay):
        """Starts an instance from another process, which then exits (a crashed run) or stays (a live run)."""
        script = (f"import os, sys, time; sys.path.insert(0, {str(support.PACKAGE / 'src')!r}); from hola import ollama; "
                  f"i = ollama.OllamaInstance({box.binary!r}, {str(state)!r}, {box.port}, env={box.env!r}); i.start(); "
                  "print('ready', flush=True); " + ("time.sleep(600)" if stay else "os._exit(0)"))
        helper = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, text=True)
        ready = helper.stdout.readline().strip()
        helper.stdout.close()
        self.assertEqual(ready, "ready")
        return helper, json.loads((state / ollama.PID_FILE).read_text())

    def test_a_crashed_runs_instance_is_stopped_and_its_port_reused(self):
        box = support.Sandbox()
        self.addCleanup(box.close)
        state = box.dir / "state"
        helper, record = self.start_elsewhere(box, state, stay=False)
        helper.wait()
        self.assertEqual((record["binary"], record["parent_pid"]), (box.binary, helper.pid))
        self.assertTrue(ollama.pid_alive(record["pid"]))
        instance = ollama.OllamaInstance(box.binary, state, box.port, env=box.env)
        instance.start()
        self.addCleanup(instance.stop)
        self.assertTrue(instance.stopped_leftover)
        time.sleep(0.3)
        self.assertFalse(ollama.pid_alive(record["pid"]))
        self.assertEqual(json.loads((state / ollama.PID_FILE).read_text())["pid"], instance.pid)

    def test_a_live_benchmark_started_by_another_process_is_never_touched(self):
        box = support.Sandbox()
        self.addCleanup(box.close)
        state = box.dir / "state"
        helper, record = self.start_elsewhere(box, state, stay=True)
        self.addCleanup(lambda: (os.killpg(record["pid"], signal.SIGKILL), helper.kill(), helper.wait()))
        with self.assertRaises(HolaError) as caught:
            ollama.OllamaInstance(box.binary, state, box.port, env=box.env).start()
        self.assertEqual(caught.exception.code, "busy")
        self.assertIn(f"lsof -i :{box.port}", caught.exception.next_step)
        self.assertIsNotNone(ollama.server_version(f"http://127.0.0.1:{box.port}"))

    def test_a_recorded_pid_now_running_something_else_is_not_ours(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, ollama.PID_FILE).write_text(json.dumps(
                {"pid": os.getpid(), "port": 11531, "binary": "/opt/ollama/bin/ollama", "parent_pid": 1}))
            self.assertIsNone(ollama.leftover_pid(d, 11531))
            Path(d, ollama.PID_FILE).write_text(json.dumps({"pid": os.getpid(), "port": 11531}))
            self.assertIsNone(ollama.leftover_pid(d, 11531))

if __name__ == "__main__":
    unittest.main()
