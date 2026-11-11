"""`benchclub api` against the engine's fake OpenAI-compatible API."""

import json
import subprocess
import sys
import unittest

import support
from benchclub import machine, paths, record as record_mod, remote, runs
from benchclub.errors import HolaError


class RemoteTest(unittest.TestCase):
    def setUp(self):
        self.box = support.Sandbox()
        self.addCleanup(self.box.close)
        self.server, self.base, self.requests = machine.engine().fake_openai()
        self.addCleanup(self.server.shutdown)

    def env(self, **extra):
        return {**self.box.env, "TEST_KEY": "sk-test", **extra}

    def test_a_run_writes_a_hosted_run_record_kept_apart_from_counted_runs(self):
        result = remote.run_api("vendor-model", base_url=self.base, key_env="TEST_KEY", env=self.env())
        record = result["record"]
        self.assertEqual(record["schema"], record_mod.RUN_RECORD_SCHEMA)
        self.assertEqual(record["job_id"], f"local:{record['run_id']}")
        self.assertEqual(record["runtime"]["backend"], "api")
        self.assertEqual(record["runtime"]["profile"], "openai_compatible-1.0")
        self.assertEqual(record["subject"]["tag"], "vendor-model")
        self.assertEqual(record["subject"]["version"],
                         "sha256:" + record_mod.api_build_digest("openai_compatible", "vendor-model"))
        self.assertEqual(record["runtime"]["hardware"]["served"],
                         [{"model": "vendor-model-20261101", "provider": "FakeCloud"}])
        self.assertEqual([(r["task"], r["passed"], r["samples_n"]) for r in record["results"]],
                         [("code-intervals", 3, 3), ("tool-flight", 3, 3), ("needle-8k", 3, 3)])
        self.assertTrue(all(s["events"]["from_seq"] <= s["events"]["to_seq"]
                            for r in record["results"] for s in r["samples"]))
        self.assertEqual(paths.home(self.env()) / "api-runs", remote.runs_dir(self.env()))
        self.assertTrue(result["run_dir"].startswith(str(remote.runs_dir(self.env()))))
        self.assertEqual(runs.list_runs(paths.runs_dir(self.env())), [])
        self.assertTrue(all(auth == "Bearer sk-test" for _, _, auth in self.requests))

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
        self.assertEqual(remote.endpoint("openrouter"), ("openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"))
        self.assertEqual(remote.endpoint("openrouter", "http://x/v1"), ("openrouter", "http://x/v1", "OPENROUTER_API_KEY"))
        self.assertEqual(remote.endpoint(None, "http://x/v1", "K"), ("openai_compatible", "http://x/v1", "K"))

    def test_the_command_prints_one_json_result_without_the_key(self):
        out = subprocess.run([sys.executable, "-m", "benchclub", "api", "vendor-model", "--base-url", self.base,
                              "--api-key-env", "TEST_KEY", "--json"],
                             env={**self.env(), "PYTHONPATH": str(support.PACKAGE / "src")}, capture_output=True,
                             text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        result = json.loads(out.stdout)
        self.assertEqual((result["passed"], result["samples"], result["reference_only"]), (9, 9, True))
        self.assertNotIn("sk-test", out.stdout + out.stderr)


if __name__ == "__main__":
    unittest.main()
