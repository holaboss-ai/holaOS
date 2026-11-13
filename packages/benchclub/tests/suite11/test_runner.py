import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2]
ENGINE = PACKAGE / "src" / "benchclub" / "engine"
PACK = ENGINE / "packs" / "suite-standard-1.1.json"
FAKE = PACKAGE / "tests" / "fake_ollama.py"
sys.path.insert(0, str(PACKAGE / "src"))

import io  # noqa: E402

from benchclub import cli, runs  # noqa: E402
from benchclub import record as run_record  # noqa: E402

spec = importlib.util.spec_from_file_location("holaeval_under_test", ENGINE / "holaeval.py")
holaeval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(holaeval)
graders_spec = importlib.util.spec_from_file_location("suite11_graders", ENGINE / "suite11" / "__init__.py",
                                                     submodule_search_locations=[str(ENGINE / "suite11")])
suite11 = importlib.util.module_from_spec(graders_spec)
sys.modules["suite11_graders"] = suite11
graders_spec.loader.exec_module(suite11)


class FakeEmit:
    def __init__(self):
        self.events, self.task = [], None

    def __call__(self, event, **fields):
        self.events.append({"type": event, **fields})

    def text(self, chunk):
        pass


def reply(content="", tool_calls=None, done_reason="stop"):
    return {"content": content, "tool_calls": tool_calls, "done_reason": done_reason, "eval_count": 5, "chunks": 1,
            "gen_s": 0.1, "total_s": 0.2, "ttft_s": 0.05, "eval_s": 0.1, "prompt_eval_count": 10,
            "prompt_eval_s": 0.01, "load_s": 0.0, "thinking": ""}


def first(bench):
    return next(i for i in json.loads(PACK.read_text(encoding="utf-8"))["items"] if i["bench"] == bench)


class ItemTest(unittest.TestCase):
    def run_item(self, item, send, capabilities=("completion", "tools")):
        emit = FakeEmit()
        result = holaeval.item11("http://x", "m", item, {"temperature": 0}, {"think": False}, list(capabilities),
                                 emit, suite11.grade, send=send)
        return result, emit.events

    def test_a_model_without_tools_is_a_format_error_not_a_request(self):
        def send(*_a, **_k):
            raise AssertionError("no request expected")
        result, events = self.run_item(first("bfcl"), send, capabilities=("completion",))
        self.assertEqual((result["passed"], result["outcome"], result["kind"]), (False, "format_error", "item"))
        self.assertEqual([e["type"] for e in events], ["task_start", "sample_done"])

    def test_a_reply_cut_off_by_the_token_cap_is_unfinished(self):
        item = first("ifeval")
        result, _ = self.run_item(item, lambda *_a, **_k: reply("x", done_reason="length"))
        self.assertEqual(result["outcome"], "unfinished")

    def test_a_failed_request_is_an_error_and_the_run_goes_on(self):
        def send(*_a, **_k):
            raise OSError("connection refused")
        result, events = self.run_item(first("simpleqa"), send)
        self.assertEqual(result["outcome"], "error")
        self.assertTrue(events[-1]["reason"].startswith("request failed"))

    def test_the_request_is_the_item_with_thinking_off_and_its_own_token_cap(self):
        seen = {}

        def send(_root, payload, on_text=None):
            seen.update(payload)
            return reply("<think>hmm</think>Paris")
        item = first("jsonschema")
        result, events = self.run_item(item, send)
        self.assertEqual(seen["messages"], item["messages"])
        self.assertIs(seen["think"], False)
        self.assertEqual(seen["options"]["num_predict"], item["max_tokens"])
        self.assertEqual(seen["format"], item["format"]) if item.get("format") is not None else None
        self.assertEqual(events[-1]["response"]["content"], "Paris")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class EndToEndTest(unittest.TestCase):
    def test_speed_then_items_through_a_fake_ollama(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = f"127.0.0.1:{free_port()}"
            env = {**os.environ, "OLLAMA_HOST": host, "FAKE_OLLAMA_STATE": tmp, "FAKE_OLLAMA_HAS": "m"}
            server = subprocess.Popen([sys.executable, str(FAKE), "serve"], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(f"http://{host}/api/version", timeout=1)
                        break
                    except OSError:
                        time.sleep(0.05)
                out = subprocess.run([sys.executable, "-I", str(ENGINE / "holaeval.py"), "bench", "--base-url",
                                      f"http://{host}", "--model", "m", "--pack", str(PACK), "--out", tmp,
                                      "--label", "t", "--only", "pp512,tg128,bfcl,ifeval"],
                                     capture_output=True, text=True, timeout=120)
            finally:
                server.terminate()
                server.wait(5)
            self.assertEqual(out.returncode, 0, out.stderr[-2000:])
            record = json.loads((Path(tmp) / "bench-t.json").read_text(encoding="utf-8"))
        self.assertEqual(record["suite"]["version"], "1.1")
        self.assertEqual(record["request"]["think"], False)
        speed = {r["task"]: r for r in record["results"] if r.get("kind") == "speed"}
        self.assertEqual(set(speed), {"pp512", "tg128"})
        self.assertGreater(speed["tg128"]["metrics"]["decode_tps"], 0)
        items = [r for r in record["results"] if r.get("kind") == "item"]
        self.assertEqual({r["bench"] for r in items}, {"bfcl", "ifeval"})
        self.assertEqual(len(items), 50 + 15)
        self.assertTrue(all(r["outcome"] in suite11.OUTCOMES + ("error",) for r in items))

        events = [{"type": e.pop("event"), "at": e.pop("t", 0), **e}
                  for e in (json.loads(line) for line in out.stdout.splitlines() if line.startswith("{"))]
        wire = run_record.wire_events(events, home="")
        done = [w for w in wire if w["event"] == "task_done" and w.get("sample") == 0]
        self.assertEqual(len(done), len(items))
        self.assertTrue(all("response" in w and "outcome" in w for w in done))


class CliTest(unittest.TestCase):
    RECORD = {"suite": {"id": "suite-standard", "version": "1.1"}, "results": [
        {"task": "tg128", "kind": "speed", "status": "ok", "metrics": {"decode_tps": 42.5, "tg_tps": 42.5}},
        {"task": "tg128@d8192", "kind": "speed", "status": "ok", "metrics": {"decode_tps": 30.1}},
        {"task": "bfcl-1", "kind": "item", "bench": "bfcl", "passed": True, "outcome": "pass"},
        {"task": "bfcl-2", "kind": "item", "bench": "bfcl", "passed": False, "outcome": "wrong"},
        {"task": "simpleqa-1", "kind": "item", "bench": "simpleqa", "passed": False, "outcome": "abstained"}]}

    def test_a_run_summary_reads_speed_and_counts_items_per_benchmark(self):
        s = runs.summarize(Path("."), self.RECORD)
        self.assertEqual((s["suite"], s["decode_tps"], s["decode_tps_8k"]), ("suite-standard@1.1", 42.5, 30.1))
        self.assertEqual(s["tasks"]["bfcl"], {"status": "ok", "passed": 1, "samples": 2})
        self.assertEqual(s["tasks"]["simpleqa"], {"status": "ok", "passed": 0, "samples": 1})

    def test_progress_is_one_line_per_benchmark(self):
        out = io.StringIO()
        view = cli.EvalView({"name": "m"}, stream=out, suite="suite-standard@1.1")
        for bench, task, passed in (("bfcl", "b1", True), ("bfcl", "b2", False), ("ifeval", "i1", True)):
            view.on_event({"type": "task_start", "kind": "item", "task": task, "bench": bench, "sample": 0})
            view.on_event({"type": "sample_done", "task": task, "sample": 0, "passed": passed})
        view.on_event({"type": "done"})
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("BFCL tool calls", lines[0])
        self.assertTrue(lines[0].endswith("1/2"))
        self.assertTrue(lines[1].endswith("1/1"))


class SuiteFamilyTest(unittest.TestCase):
    def test_a_model_set_up_for_one_minor_version_runs_the_others(self):
        from benchclub import pinned
        self.assertEqual(pinned.suite_family("suite-standard@1.1"), pinned.suite_family("suite-standard@1.0"))
        self.assertNotEqual(pinned.suite_family("suite-standard@1.0"), pinned.suite_family("suite-coding@1.0"))
        self.assertNotEqual(pinned.suite_family("suite-standard@2.0"), pinned.suite_family("suite-standard@1.0"))


if __name__ == "__main__":
    unittest.main()
