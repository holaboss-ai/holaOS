"""The `hola` command end to end, as a subprocess against the fake Ollama."""

import json
import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path

import support

SRC = support.PACKAGE / "src"


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@unittest.skipIf(os.name == "nt", "the fake ollama is a shell script")
class CliTest(unittest.TestCase):
    def setUp(self):
        self.box = support.Sandbox()
        self.addCleanup(self.box.close)

    def env(self, box=None):
        return {**(box or self.box).env, "PYTHONPATH": str(SRC), "PYTHONIOENCODING": "utf-8"}

    def hola(self, *args, box=None, timeout=120):
        return subprocess.run([sys.executable, "-m", "hola", *args], env=self.env(box), capture_output=True, text=True,
                              timeout=timeout, encoding="utf-8")

    def test_eval_json_is_one_stable_document(self):
        out = self.hola("eval", "minicpm5-2b", "--json", "--ignore-memory")
        self.assertEqual(out.returncode, 0, out.stderr)
        result = json.loads(out.stdout)
        self.assertEqual(set(result), {"ok", "run_id", "run_dir", "record_path", "suite", "subject", "summary", "conditions",
                                       "publishable", "publish_blockers", "config_source", "hola"})
        self.assertEqual(result["subject"]["id"], "openbmb-minicpm5-2b")
        self.assertEqual(result["config_source"], "bundled")
        self.assertEqual(set(result["summary"]), {"decode_tps", "decode_tps_8k", "ttft_ms", "cpu_offload", "vram_bytes", "tasks"})
        self.assertFalse(result["publishable"], "the fake's digest is not a registered build")
        self.assertEqual(out.stderr, "")

        listed = json.loads(self.hola("runs", "--json").stdout)
        self.assertEqual([r["run_id"] for r in listed["runs"]], [result["run_id"]])
        self.assertIn(result["run_id"][:8], self.hola("runs").stdout)

    def test_eval_prints_each_step_and_the_numbers(self):
        out = self.hola("eval", "openbmb-minicpm5-2b", "--ignore-memory")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        text = out.stdout
        for expected in (f"Ollama 0.40.10 · private instance on 127.0.0.1:{self.box.port}", "background load",
                         "HolaHub can't be reached", "downloading MiniCPM5-2B Q4_K_M", "unverified build",
                         "warming up … done", "generation … ", "tok/s", "code ●●●  3/3", "generation   ",
                         "Saved ", "This run stays on this machine"):
            self.assertIn(expected, text)

    def test_failures_print_a_sentence_and_the_next_step(self):
        out = self.hola("eval", "no-such-model")
        self.assertEqual(out.returncode, 1)
        self.assertIn("There is no model called no-such-model", out.stdout)
        self.assertIn("hola list", out.stdout)
        missing = support.Sandbox()
        self.addCleanup(missing.close)
        missing.env["HOLA_OLLAMA_BIN"] = str(missing.dir / "nope")
        missing.env["PATH"] = str(missing.dir)
        out = self.hola("eval", "minicpm5-2b", "--json", box=missing)
        self.assertEqual(out.returncode, 1)
        self.assertEqual(json.loads(out.stdout)["error"]["code"], "ollama_missing")

    def test_list_falls_back_to_the_bundled_models_offline(self):
        listed = json.loads(self.hola("list", "--json").stdout)
        self.assertEqual(listed["source"], "bundled")
        ids = [s["id"] for s in listed["subjects"]]
        self.assertIn("qwen-qwen3.5-2b", ids)
        qwen = next(s for s in listed["subjects"] if s["id"] == "qwen-qwen3.5-2b")
        self.assertIn("qwen3.5-2b", qwen["aliases"])
        self.assertIn("hola eval qwen3.5-2b", self.hola("list").stdout)

    def test_doctor_reports_every_check(self):
        out = self.hola("doctor", "--json")
        report = json.loads(out.stdout)
        ids = [c["id"] for c in report["checks"]]
        for expected in ("python", "ollama", "models_dir", "machine", "port", "network", "holahub", "version", "engine"):
            self.assertIn(expected, ids)
        ollama_check = next(c for c in report["checks"] if c["id"] == "ollama")
        self.assertEqual(ollama_check["status"], "ok")
        self.assertIn("0.40.10", ollama_check["message"])
        self.assertTrue(all(set(c) == {"id", "status", "message", "next_step"} for c in report["checks"]))

    def interrupt_mid_run(self, send):
        box = support.Sandbox(runner=1, token_delay=0.05)
        self.addCleanup(box.close)
        proc = subprocess.Popen([sys.executable, "-m", "hola", "eval", "minicpm5-2b", "--ignore-memory"], env=self.env(box),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not any(r["path"] == "/api/chat" for r in box.requests()):
            time.sleep(0.2)
        self.assertTrue(any(r["path"] == "/api/chat" for r in box.requests()), "the run reached the model")
        serve_pid = int((box.state / "serve.pid").read_text())
        runner_pid = int((box.state / "runner.pid").read_text())
        self.assertTrue(alive(serve_pid) and alive(runner_pid))
        send(proc)
        out, _ = proc.communicate(timeout=30)
        time.sleep(0.5)
        self.assertFalse(alive(serve_pid), "no orphan ollama serve")
        self.assertFalse(alive(runner_pid), "no orphan model runner")
        self.assertFalse((Path(box.env["HOLA_HOME"]) / "state" / "ollama-bench.json").exists())
        return proc.returncode, out

    def test_ctrl_c_mid_run_stops_the_private_instance_and_its_runner(self):
        code, out = self.interrupt_mid_run(lambda proc: os.killpg(proc.pid, signal.SIGINT))
        self.assertEqual(code, 130)
        self.assertIn("Stopped. The private Ollama instance is shut down", out)

    def test_sigterm_mid_run_cleans_up_the_same_way(self):
        code, _ = self.interrupt_mid_run(lambda proc: proc.terminate())
        self.assertEqual(code, 130)


if __name__ == "__main__":
    unittest.main()
