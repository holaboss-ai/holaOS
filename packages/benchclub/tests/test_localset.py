"""`benchclub run-set`: asks the local model with BenchClub's requests and passes the replies back untouched."""

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from benchclub import localset
from benchclub.errors import HolaError

DIGEST = "1e2d" * 16
ENTRY = {"id": "qwen-qwen3.5-2b", "name": "Qwen3.5 2B", "tag": "qwen3.5:2b", "build_digest": f"sha256:{DIGEST}",
         "aliases": ["qwen3.5:2b"]}


class FakeOllama:
    """Answers /v1/chat/completions with "Answer: B" and remembers each request it got."""

    def __init__(self, status=200):
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append((self.path, body))
                reply = json.dumps({"choices": [{"finish_reason": "stop",
                                                 "message": {"content": "Answer: B"}}]}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


class FakeServer:
    """ExternalOllama's surface: version, tags, pull."""

    def __init__(self, base_url, tags):
        self.base_url, self.tags, self.pulled = base_url, tags, []

    def start(self):
        return "0.40.16"

    def _tags(self):
        return self.tags

    def pull(self, model, on_progress=None):
        self.pulled.append(model)
        self.tags.append({"name": model, "digest": DIGEST})


class Lines:
    def __init__(self):
        self.lines = []

    def line(self, text="", indent=2):
        self.lines.append(text)


class Hub:
    """BenchClub's local-run routes, as the CLI sees them through localset._hub."""

    def __init__(self, answer_failures=0):
        self.calls = []
        self.answer_failures = answer_failures

    def __call__(self, method, path, body=None, token=None, timeout=None):
        self.calls.append((method, path, body, token))
        if path == "/v1/local/set-runs":
            return 201, {"job_id": "J1", "token": "bcj_job", "watch_url": "https://www.benchclub.ai/me/runs/J1",
                         "set": {"id": "S1", "title": "Science", "version": "2"},
                         "model": {"subject": ENTRY["id"], "name": ENTRY["name"], "tag": ENTRY["tag"]},
                         "questions": [{"id": f"Q{i}", "type": "mcq", "modality": "text",
                                        "request": {"model": "qwen3.5:2b", "temperature": 0, "max_tokens": 16384,
                                                    "messages": [{"role": "user", "content": f"question {i}"}]}}
                                       for i in (1, 2)]}
        if path.endswith("/answers"):
            if self.answer_failures:
                self.answer_failures -= 1
                return 503, {"code": "judge_failed"}
            return 200, {"id": body["id"], "status": "graded", "score": 0, "done": 1, "total": 2}
        if path.endswith("/finish"):
            return 200, {"job_id": "J1", "run_id": "R1", "url": "https://www.benchclub.ai/me/runs/J1",
                         "summary": {"questions": 2, "graded": 2, "choice": {"right": 0, "total": 2},
                                     "short": {"total": 0, "mean": None}}}
        return 200, {}

    def paths(self):
        return [p for _m, p, _b, _t in self.calls]


class RunSetTest(unittest.TestCase):
    def setUp(self):
        self.ollama = FakeOllama()
        self.addCleanup(self.ollama.close)
        patches = [
            mock.patch.object(localset.account, "saved_session", return_value={"token": "session"}),
            mock.patch.object(localset.account, "machine_report",
                              return_value={"cpu": "Apple M4 Pro", "memory_gb": 48, "gpus": [], "os": "Darwin"}),
            mock.patch.object(localset.hub, "fetch_subjects_index", return_value=([ENTRY], "hub")),
            mock.patch.object(localset, "HEARTBEAT_S", 3600),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_with(self, hub, tags, **kwargs):
        server = FakeServer(self.ollama.base_url, tags)
        with mock.patch.object(localset, "_hub", hub), \
                mock.patch.object(localset.ollama, "ExternalOllama", return_value=server):
            return localset.run_set("S1", "qwen3.5:2b", out=Lines(), env={}, **kwargs), server

    def test_each_reply_goes_back_as_it_came_under_the_local_name(self):
        hub = Hub()
        done, _server = self.run_with(hub, [{"name": "qwen3.5:2b-q4_K_M", "digest": DIGEST}])
        self.assertEqual(done["run_id"], "R1")
        start = next(b for _m, p, b, _t in hub.calls if p == "/v1/local/set-runs")
        self.assertEqual(start["model"], {"tag": "qwen3.5:2b", "digest": DIGEST})
        self.assertEqual(start["engine"], {"name": "ollama", "version": "0.40.16"})
        self.assertEqual(start["hardware"]["cpu"], "Apple M4 Pro")
        self.assertEqual([p for p, _b in self.ollama.requests], ["/v1/chat/completions"] * 2)
        self.assertTrue(all(b["model"] == "qwen3.5:2b-q4_K_M" for _p, b in self.ollama.requests))
        answers = [b for _m, p, b, _t in hub.calls if p.endswith("/answers")]
        self.assertEqual([a["id"] for a in answers], ["Q1", "Q2"])
        self.assertEqual(answers[0]["status"], 200)
        self.assertIn("Answer: B", answers[0]["body"])
        self.assertNotIn("/runner/v1/jobs/J1/abort", hub.paths())

    def test_a_judge_that_failed_gets_the_answer_again(self):
        hub = Hub(answer_failures=2)
        with mock.patch.object(localset.time, "sleep"):
            self.run_with(hub, [{"name": "qwen3.5:2b", "digest": DIGEST}])
        self.assertEqual(sum(p.endswith("/answers") for p in hub.paths()), 4)

    def test_a_model_this_ollama_lacks_is_pulled_only_when_asked(self):
        with self.assertRaises(HolaError) as caught:
            self.run_with(Hub(), [])
        self.assertEqual(caught.exception.code, "model_missing")
        _done, server = self.run_with(Hub(), [], pull=True)
        self.assertEqual(server.pulled, ["qwen3.5:2b"])

    def test_a_run_that_breaks_off_is_aborted(self):
        hub = Hub(answer_failures=99)
        with mock.patch.object(localset.time, "sleep"), self.assertRaises(HolaError):
            self.run_with(hub, [{"name": "qwen3.5:2b", "digest": DIGEST}])
        self.assertIn("/runner/v1/jobs/J1/abort", hub.paths())

    def test_refusals_read_as_sentences(self):
        def refuse(*_args, **_kwargs):
            return 409, {"code": "model_digest_mismatch", "message": "Your copy of qwen3.5:2b isn't the build."}
        with self.assertRaises(HolaError) as caught:
            self.run_with(refuse, [{"name": "qwen3.5:2b", "digest": "other"}])
        self.assertEqual(caught.exception.code, "model_digest_mismatch")
        self.assertIn("isn't the build", caught.exception.message)

    def test_a_model_that_never_answered_is_reported_not_scored_here(self):
        status, text, error, _seconds = localset.ask("http://127.0.0.1:9", {"model": "x"}, timeout=2)
        self.assertIsNone(status)
        self.assertEqual(text, "")
        self.assertTrue(error)


if __name__ == "__main__":
    unittest.main()
