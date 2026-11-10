"""`benchclub api` against the engine's fake OpenAI-compatible API."""

import json
import subprocess
import sys
import unittest
from pathlib import Path

import support
from benchclub import machine, paths, remote, runs
from benchclub.errors import HolaError


class RemoteTest(unittest.TestCase):
    def setUp(self):
        self.box = support.Sandbox()
        self.addCleanup(self.box.close)
        self.server, self.base, self.requests = machine.engine().fake_openai()
        self.addCleanup(self.server.shutdown)

    def env(self, **extra):
        return {**self.box.env, "TEST_KEY": "sk-test", **extra}

    def test_a_run_grades_the_suite_and_stays_out_of_counted_runs(self):
        events = []
        result = remote.run_api("vendor-model", base_url=self.base, key_env="TEST_KEY", env=self.env(),
                                on_event=events.append)
        record = result["record"]
        self.assertTrue(record["reference_only"])
        self.assertEqual([(r["task"], r["passed"]) for r in record["results"]],
                         [("code-intervals", 3), ("tool-flight", 3), ("needle-8k", 3)])
        self.assertEqual(Path(result["run_dir"]).parent, remote.runs_dir(self.env()))
        self.assertEqual(runs.list_runs(paths.runs_dir(self.env())), [])
        self.assertTrue(all(auth == "Bearer sk-test" for _, _, auth in self.requests))
        self.assertEqual(events[0]["event"], "start")
        self.assertEqual(events[-1]["event"], "done")

    def test_a_missing_key_says_which_variable(self):
        with self.assertRaises(HolaError) as caught:
            remote.run_api("vendor-model", provider="anthropic", env=self.box.env)
        self.assertEqual(caught.exception.code, "api_key_missing")
        self.assertIn("ANTHROPIC_API_KEY", caught.exception.message)
        self.assertEqual(self.requests, [])

    def test_an_endpoint_is_required(self):
        with self.assertRaises(HolaError) as caught:
            remote.endpoint()
        self.assertEqual(caught.exception.code, "api_endpoint_missing")
        self.assertEqual(remote.endpoint("openrouter"), ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"))
        self.assertEqual(remote.endpoint("openrouter", "http://x/v1"), ("http://x/v1", "OPENROUTER_API_KEY"))

    def test_the_command_prints_one_json_result_without_the_key(self):
        out = subprocess.run([sys.executable, "-m", "benchclub", "api", "vendor-model", "--base-url", self.base,
                              "--api-key-env", "TEST_KEY", "--samples", "1", "--json"],
                             env={**self.env(), "PYTHONPATH": str(support.PACKAGE / "src")}, capture_output=True,
                             text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        result = json.loads(out.stdout)
        self.assertEqual((result["passed"], result["samples"], result["reference_only"]), (3, 3, True))
        self.assertNotIn("sk-test", out.stdout + out.stderr)


if __name__ == "__main__":
    unittest.main()
