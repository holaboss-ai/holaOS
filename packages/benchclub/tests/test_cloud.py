"""`benchclub cloud-worker`: claim a platform job with the runner key, run the hosted model, submit."""

import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import support  # noqa: F401  (puts src/ on the path)
from benchclub import account, cli, cloud, machine, pinned, record as record_mod, remote
from test_submit import JOB_TOKEN, FakeHub, serve

RUNNER_KEY = "{{SECRET_xo41hxgz}}"
MODEL = "vendor/model-6"


def platform_job(**overrides):
    pack = pinned.pack_path(pinned.DEFAULT_SUITE)
    job = {
        "schema": "benchclub.job/0.1", "job_id": "01JCLOUD0000000000000000AA", "kind": "eval", "placement": "platform",
        "suite": {"id": "suite-standard", "version": "1.0", "sha256": hashlib.sha256(pack.read_bytes()).hexdigest()},
        "subject": "vendor-model-6",
        "build": {"engine": "openrouter", "tag": MODEL, "digest": record_mod.api_build_digest("openrouter", MODEL),
                  "quant": "API"},
        "runtime_profile": "openrouter-1.0", "lease_seconds": 60, "heartbeat_seconds": 1,
    }
    return {**job, **overrides}


class CloudHub(FakeHub):
    """The fake hub plus the runner-key claim of platform jobs."""

    def __init__(self, jobs):
        super().__init__()
        self.queue = list(jobs)
        self.platform_claims = []

    def handle(self, method, path, token, body):
        if (method, path) == ("POST", "/runner/v1/platform/claim"):
            if token != RUNNER_KEY:
                return 401, {"code": "runner_key_invalid"}
            self.platform_claims.append(body)
            if not self.queue:
                return 200, {"job": None}
            return 200, {"job": self.queue.pop(0), "token": JOB_TOKEN, "subject": {"name": "Model 6", "vendor": "Vendor"}}
        return super().handle(method, path, token, body)


class CloudWorkerTest(unittest.TestCase):
    def start(self, jobs):
        self.home = Path(tempfile.mkdtemp())
        self.fake = CloudHub(jobs)
        server = serve(self.fake)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        api, base, self.requests = machine.engine().fake_openai()
        self.addCleanup(api.shutdown)
        env = {"BENCHCLUB_HOME": str(self.home), "BENCHCLUB_API": f"http://127.0.0.1:{server.server_port}",
               "BENCHCLUB_RUNNER_KEY": RUNNER_KEY, "OPENROUTER_API_KEY": "sk-or-test"}
        for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"):
            env[key] = ""
        patches = [mock.patch.dict(os.environ, env),
                   mock.patch.dict(remote.PROVIDERS, {"openrouter": (base, "OPENROUTER_API_KEY")})]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def work(self):
        stdout = io.StringIO()
        with mock.patch("sys.stdout", stdout):
            code = cli.main(["cloud-worker", "--once"])
        return code, [json.loads(line) for line in stdout.getvalue().splitlines() if line.startswith("{")]

    def test_a_platform_job_is_run_and_submitted_as_a_hosted_run(self):
        self.start([platform_job()])
        code, logs = self.work()
        self.assertEqual(code, 0)
        self.assertEqual(self.fake.platform_claims, [{"engines": ["openrouter"]}])
        self.assertEqual([entry["event"] for entry in logs], ["worker_ready", "job_claimed", "job_done"])
        self.assertEqual(len(self.fake.completed), 1)
        token, record = self.fake.completed[0]
        self.assertEqual(token, JOB_TOKEN)
        self.assertEqual((record["job_id"], record["placement"]), ("01JCLOUD0000000000000000AA", "platform"))
        self.assertEqual(record["subject"]["id"], "vendor-model-6")
        self.assertEqual(record["subject"]["name"], "Model 6")
        self.assertEqual(record["subject"]["version"], "sha256:" + platform_job()["build"]["digest"])
        self.assertEqual((record["runtime"]["backend"], record["runtime"]["profile"]), ("api", "openrouter-1.0"))
        self.assertEqual(record["suite"]["sha256"], platform_job()["suite"]["sha256"])
        self.assertEqual(sum(r["passed"] for r in record["results"]), 9)
        # The uploaded wire log is the one the record's integrity block covers.
        wire = [event for chunk in self.fake.event_chunks for event in chunk["events"]]
        canonical = "\n".join(record_mod.jcs(w) for w in wire).encode("utf-8")
        self.assertEqual(record["events"]["sha256"], hashlib.sha256(canonical).hexdigest())
        self.assertEqual(record["events"]["last_seq"], len(wire) - 1)
        self.assertEqual(self.fake.aborts, [])
        self.assertTrue(all(auth == "Bearer sk-or-test" for _, _, auth in self.requests))
        self.assertEqual([body["model"] for _, body, _ in self.requests][:1], [MODEL])
        self.assertFalse(any(cloud.runs_root().iterdir()) if cloud.runs_root().exists() else False)

    def test_an_empty_queue_exits_cleanly(self):
        self.start([])
        code, logs = self.work()
        self.assertEqual(code, 0)
        self.assertEqual([entry["event"] for entry in logs], ["worker_ready"])
        self.assertEqual(self.fake.completed, [])

    def test_a_suite_hosted_models_dont_run_is_aborted(self):
        self.start([platform_job(suite={"id": "suite-coding", "version": "1.0", "sha256": "x" * 64})])
        _code, logs = self.work()
        self.assertEqual(logs[-1]["event"], "job_failed")
        self.assertEqual(self.fake.aborts, [(JOB_TOKEN, "suite_unsupported:suite-coding@1.0")])
        self.assertEqual(self.requests, [])

    def test_a_bad_runner_key_is_reported(self):
        self.start([platform_job()])
        with mock.patch.dict(os.environ, {"BENCHCLUB_RUNNER_KEY": "wrong"}):
            code, logs = self.work()
        self.assertEqual(code, 1)
        self.assertEqual(logs[-1]["code"], "runner_key_invalid")
        self.assertNotIn(RUNNER_KEY, json.dumps(logs))


class OwnEndpointHub(CloudHub):
    """A person's local job on a hosted model: the claim hands back the hosted build."""

    def handle(self, method, path, token, body):
        if (method, path) == ("POST", "/runner/v1/claim") and token and token.startswith("hcli_"):
            self.claims.append(token)
            return 200, {"job": platform_job(placement="local"), "token": JOB_TOKEN}
        return super().handle(method, path, token, body)


class OwnEndpointTest(unittest.TestCase):
    """`benchclub run <hosted model> --base-url …`: the submitter's own endpoint answers, submitted as self-reported."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.fake = OwnEndpointHub([])
        self.fake.complete_response = {"status": "finalized", "counted": False,
                                       "not_counted_reason": ["self_reported_endpoint"], "url": "https://hub.example/r/1"}
        server = serve(self.fake)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        api, self.base, self.requests = machine.engine().fake_openai()
        self.addCleanup(api.shutdown)
        hub_url = f"http://127.0.0.1:{server.server_port}"
        patcher = mock.patch.dict(os.environ, {"BENCHCLUB_HOME": str(self.home), "BENCHCLUB_API": hub_url,
                                               "BENCHCLUB_HUB": hub_url})
        patcher.start()
        self.addCleanup(patcher.stop)
        account.login(cli.Out(io.StringIO()), sleep=lambda _s: None, clock=lambda: 0)

    def run_cli(self, *argv):
        stdout = io.StringIO()
        with mock.patch("sys.stdout", stdout):
            code = cli.main(["run", *argv])
        return code, stdout.getvalue()

    def test_a_local_gateway_answers_and_the_run_is_submitted_without_its_address(self):
        code, output = self.run_cli(MODEL, "--base-url", self.base, "--api-model", "gateway/model-6", "--json")
        self.assertEqual(code, 0, output)
        self.assertEqual(self.fake.jobs, [{"subject": "vendor-model-6", "suite": {"id": "suite-standard",
                                                                                "version": "1.0"}, "placement": "local"}])
        _token, record = self.fake.completed[0]
        self.assertEqual(record["placement"], "local")
        self.assertEqual(record["subject"]["id"], "vendor-model-6")
        self.assertEqual(record["subject"]["tag"], "gateway/model-6")
        self.assertEqual((record["runtime"]["backend"], record["runtime"]["profile"]), ("api", "openai_compatible-1.0"))
        self.assertNotIn("base_url", record["runtime"]["provider"])
        self.assertNotIn(self.base, json.dumps(record))
        self.assertEqual({body["model"] for _, body, _ in self.requests}, {"gateway/model-6"})
        self.assertEqual(json.loads(output)["not_counted_reason"], ["self_reported_endpoint"])

    def test_the_human_report_says_why_it_does_not_count(self):
        _code, output = self.run_cli(MODEL, "--base-url", self.base)
        self.assertIn("self-reported", output)
        self.assertIn("can't see what answered", output)


if __name__ == "__main__":
    unittest.main()
