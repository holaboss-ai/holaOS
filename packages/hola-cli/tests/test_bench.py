"""`hola eval`'s orchestration against a fake Ollama binary: the happy path and each failure path."""

import getpass
import json
import os
import unittest
from pathlib import Path

import support
from hola import bench, ollama, paths
from hola.errors import HolaError
from hola.record import RUN_RECORD_SCHEMA


@unittest.skipIf(os.name == "nt", "the fake ollama is a shebang script, which Windows cannot exec")
class EvalTest(unittest.TestCase):
    def setUp(self):
        self.box = support.Sandbox()
        self.addCleanup(self.box.close)

    def run_eval(self, subject=None, **kwargs):
        options = {"env": self.box.env, "cpu_busy": lambda: 7, "hardware": lambda: dict(support.SMALL_MACHINE), **kwargs}
        return bench.run_eval(subject or support.SUBJECT, **options)

    def fails(self, code, subject=None, **kwargs):
        with self.assertRaises(HolaError) as caught:
            self.run_eval(subject, **kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception.message)
        return caught.exception

    def test_a_run_writes_the_desktops_run_record_with_the_cli_as_client(self):
        result = self.run_eval()
        self.assertTrue(result["ok"])
        record = json.loads(Path(result["record_path"]).read_text())
        self.assertEqual(record["schema"], RUN_RECORD_SCHEMA)
        self.assertEqual(record["run_id"], result["run_id"])
        self.assertEqual(record["runtime"]["client"]["app"], "hola-cli")
        self.assertEqual(record["runtime"]["provider"],
                         {"engine": "ollama", "version": "0.40.10", "env": ollama.pinned_env(), "flash_attention": "auto",
                          "managed": True})
        self.assertEqual(record["subject"]["version"], "fakedigest")
        self.assertTrue(record["subject"]["digest_registered"])
        self.assertEqual([r["task"] for r in record["results"]],
                         ["speed@0", "speed@8k", "code-intervals", "tool-flight", "needle-8k"])
        self.assertEqual(record["runtime"]["conditions"]["cpu_busy_pct"], 7)
        self.assertIn("others_cpu_busy_pct", record["runtime"]["conditions"])
        self.assertTrue(any(h["label"] == "first_token" for h in record["artifacts"]["highlights"]))
        self.assertEqual(record["test_agent"]["settings"]["sampling"], {"temperature": 0.7, "top_p": 0.8, "min_p": 0.0})
        self.assertTrue(result["publishable"])
        self.assertEqual(result["summary"]["tasks"]["code-intervals"], {"status": "ok", "passed": 3, "samples": 3})

        served = json.loads((self.box.state / "env.json").read_text())
        for key, value in ollama.pinned_env().items():
            self.assertEqual(served[key], value, key)
        self.assertEqual(served["OLLAMA_HOST"], f"127.0.0.1:{self.box.port}")
        self.assertIsNone(ollama.server_version(f"http://127.0.0.1:{self.box.port}"), "the instance is stopped")
        self.assertFalse((paths.state_dir(self.box.env) / ollama.PID_FILE).exists())

        run_dir = Path(result["run_dir"])
        events = [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines()]
        self.assertEqual(events[0]["type"], "run_started")
        self.assertEqual(events[-1], {**events[-1], "type": "run_finished", "status": "done"})
        self.assertEqual([e["phase"] for e in events if e["type"] == "phase"], ["starting", "pulling", "running", "finishing"])

        text = Path(result["record_path"]).read_text()
        self.assertNotIn(getpass.getuser(), text)
        self.assertNotIn(str(Path.home()), text)
        self.assertNotRegex(text, r"[\w.+-]+@[\w-]+\.[a-z]{2,}\b")

    def test_a_model_this_run_downloaded_is_removed_unless_kept(self):
        self.run_eval()
        self.assertIn("/api/delete", [r["path"] for r in self.box.requests()])

    def test_a_kept_or_already_present_model_stays(self):
        self.run_eval(keep_model=True)
        self.assertNotIn("/api/delete", [r["path"] for r in self.box.requests()])
        box = support.Sandbox(has="m:q4")
        self.addCleanup(box.close)
        bench.run_eval(support.SUBJECT, env=box.env, cpu_busy=lambda: 1, hardware=lambda: dict(support.SMALL_MACHINE))
        self.assertNotIn("/api/delete", [r["path"] for r in box.requests()])

    def test_a_model_the_user_has_under_other_casing_is_not_removed(self):
        box = support.Sandbox(has="M:Q4")
        self.addCleanup(box.close)
        bench.run_eval(support.SUBJECT, env=box.env, cpu_busy=lambda: 1, hardware=lambda: dict(support.SMALL_MACHINE))
        self.assertNotIn("/api/delete", [r["path"] for r in box.requests()])

    def test_when_presence_cant_be_checked_the_model_is_treated_as_the_users(self):
        real = ollama.OllamaInstance.has_model

        def broken(instance, model):
            raise OSError("tags unavailable")

        ollama.OllamaInstance.has_model = broken
        self.addCleanup(setattr, ollama.OllamaInstance, "has_model", real)
        self.assertTrue(self.run_eval()["ok"])
        self.assertNotIn("/api/delete", [r["path"] for r in self.box.requests()])

    def test_an_unregistered_build_still_runs_but_cannot_be_published(self):
        subject = {**support.SUBJECT, "ollama": {"tag": "m:q4", "known_digests": ["another"]}}
        result = self.run_eval(subject)
        self.assertFalse(result["subject"]["digest_registered"])
        self.assertFalse(result["publishable"])
        self.assertIn("not one HolaHub has registered", result["publish_blockers"][0])

    def test_a_pre_run_reading_is_busy_only_above_the_shared_threshold(self):
        for reading, busy in ((40, False), (41, True)):
            with self.assertRaises(HolaError):
                self.run_eval(cpu_busy=lambda reading=reading: reading, find_binary=lambda env: "/nonexistent/ollama")
            run_dir = max(Path(self.box.env["HOLA_HOME"], "runs").iterdir(), key=lambda p: p.stat().st_mtime)
            events = [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines()]
            self.assertEqual(any(e["type"] == "machine_busy" for e in events), busy, reading)

    def test_no_ollama(self):
        err = self.fails("ollama_missing", find_binary=lambda env: None)
        self.assertEqual(err.details["download_url"], "https://ollama.com/download")
        self.assertIn("Install it from https://ollama.com/download", err.next_step)

    def test_ollama_too_old_stops_before_pulling(self):
        subject = {**support.SUBJECT, "ollama": {**support.SUBJECT["ollama"], "min_version": "9.0.0"}}
        err = self.fails("ollama_too_old", subject)
        self.assertIn("older than 9.0.0", err.message)
        self.assertNotIn("/api/pull", [r["path"] for r in self.box.requests()])
        self.assertIsNone(ollama.server_version(f"http://127.0.0.1:{self.box.port}"))

    def test_not_enough_memory_stops_before_starting_ollama(self):
        subject = {**support.SUBJECT, "min_memory_gb": 32}
        err = self.fails("not_enough_memory", subject, hardware=lambda: {"cpu": "x", "memory_gb": 16, "gpus": ["GPU, 8192 MiB"]})
        self.assertEqual(err.message, "MiniCPM5-2B Q4_K_M needs 32 GB of memory or more; this machine has 16 GB and 8 GB on GPUs.")
        self.assertFalse((self.box.state / "env.json").exists())
        self.assertTrue(self.run_eval(subject, ignore_memory=True, hardware=lambda: {"memory_gb": 16})["ok"])

    def test_offline_and_fake_ip_pulls_say_what_to_do(self):
        for reason, hint in (
            ('pull model manifest: Get "https://registry.ollama.ai/v2/m/manifests/q4": dial tcp: lookup registry.ollama.ai: no such host',
             "can't reach the Ollama registry"),
            ("pull model manifest: registry.ollama.ai resolves to non-public address 198.18.0.21", "fake-ip mode"),
        ):
            box = support.Sandbox(pull_error=reason)
            self.addCleanup(box.close)
            with self.assertRaises(HolaError) as caught:
                bench.run_eval(support.SUBJECT, env=box.env, cpu_busy=lambda: 1, hardware=lambda: dict(support.SMALL_MACHINE))
            self.assertEqual(caught.exception.code, "pull_failed")
            self.assertIn(hint, caught.exception.next_step)
            self.assertIsNone(ollama.server_version(f"http://127.0.0.1:{box.port}"))

    def test_the_users_loaded_models_block_the_run_until_unloaded(self):
        user = support.UserOllama(["qwen3:8b"])
        self.addCleanup(user.close)
        err = self.fails("user_models_loaded", user_url=user.url)
        self.assertIn("qwen3:8b", err.message)
        self.assertIn("--unload", err.next_step)
        self.assertEqual(user.unloaded, [])
        asked = []
        self.assertTrue(self.run_eval(user_url=user.url, confirm=lambda models: asked.append(models) or True)["ok"])
        self.assertEqual(user.unloaded, ["qwen3:8b"])
        self.assertEqual(asked[0][0]["name"], "qwen3:8b")

    def test_a_second_benchmark_on_the_private_port_is_refused(self):
        other = support.Sandbox()
        self.addCleanup(other.close)
        instance = ollama.OllamaInstance(self.box.binary, self.box.dir / "other-state", self.box.port, env=other.env)
        instance.start()
        self.addCleanup(instance.stop)
        err = self.fails("busy")
        self.assertIn(f"port {self.box.port}", err.message)

    def test_runs_on_someone_elses_server_stay_local(self):
        instance = ollama.OllamaInstance(self.box.binary, self.box.dir / "own", support.free_port(), env=self.box.env)
        instance.start()
        self.addCleanup(instance.stop)
        result = self.run_eval(ollama_url=instance.base_url)
        record = json.loads(Path(result["record_path"]).read_text())
        self.assertFalse(record["runtime"]["provider"]["managed"])
        self.assertFalse(result["publishable"])
        self.assertIn("did not start", result["publish_blockers"][0])

    def test_an_unknown_suite_or_an_incomplete_config_is_refused_before_anything_starts(self):
        self.fails("unknown_suite", suite="suite-nope@9")
        self.fails("invalid_subject", {**support.SUBJECT, "quant": ""})


if __name__ == "__main__":
    unittest.main()
