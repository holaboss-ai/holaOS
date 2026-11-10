import hashlib
import json
import unittest

import support
from benchclub import record

SUBJECT = {
    "type": "model", "id": "openbmb-minicpm5-2b", "name": "MiniCPM5-2B", "vendor": "OpenBMB", "quant": "Q4_K_M",
    "ollama": {"tag": "openbmb/minicpm5-2b:q4_k_m", "known_digests": ["d1"], "min_version": "0.12.6"},
}


GOLDEN = support.PACKAGE / "tests" / "golden"


def read_golden(variant, name):
    return json.loads((GOLDEN / variant / name).read_text(encoding="utf-8"))


class GoldenTest(unittest.TestCase):
    """The CLI/runner is the sole writer of benchclub.run-record/0.2, so its goldens live with the CLI."""

    def build(self, variant, client=None):
        inputs = read_golden(variant, "inputs.json")
        return record.build_run_record(
            run_id=inputs["run_id"], job_id=f"local:{inputs['run_id']}", placement="local",
            bench=read_golden(variant, "bench-output.json"), subject=read_golden(variant, "subject.json"),
            digest=inputs["digest"], evidence=read_golden(variant, "evidence.json"),
            client=client or {"app": "benchclub", "version": "0.1.0"}, events=inputs["events"],
            conditions=inputs["conditions"])

    def test_build_matches_the_committed_golden(self):
        for variant in ("standard", "coding"):
            with self.subTest(variant=variant):
                built = record.dumps(self.build(variant), sort_keys=True)
                expected = (GOLDEN / variant / "run-record.json").read_text(encoding="utf-8")
                self.assertEqual(built, expected, "run tests/golden/_generate.py if the record shape changed on purpose")

    def test_the_record_holds_the_0_2_shape(self):
        for variant in ("standard", "coding"):
            with self.subTest(variant=variant):
                rec = self.build(variant)
                self.assertEqual(rec["schema"], "benchclub.run-record/0.2")
                self.assertEqual(rec["placement"], "local")
                self.assertTrue(rec["job_id"].startswith("local:"))
                self.assertEqual(rec["runtime"]["client"]["app"], "benchclub")
                self.assertNotIn("kind", rec["runtime"])
                self.assertIn(rec["runtime"]["backend"], ("cuda", "metal", "rocm", "vulkan", "cpu"))
                self.assertTrue(rec["runtime"]["profile"])
                self.assertIsNone(rec["artifacts"])
                self.assertEqual(set(rec["events"]), {"sha256", "bytes", "chunks", "last_seq"})
                for res in rec["results"]:
                    self.assertNotIn("attempts", res)
                    if res["kind"] == "task":
                        self.assertGreaterEqual(res["samples_n"], 1)
                        self.assertGreaterEqual(len(res["samples"]), 1)
                        for sample in res["samples"]:
                            self.assertEqual(set(sample["events"]), {"from_seq", "to_seq"})

    def test_the_integrity_block_matches_the_canonical_log(self):
        inputs = read_golden("standard", "inputs.json")
        rec = self.build("standard")
        canonical = record.events_canonical(inputs["events"]).encode("utf-8")
        self.assertEqual(rec["events"]["sha256"], hashlib.sha256(canonical).hexdigest())
        self.assertEqual(rec["events"]["bytes"], len(canonical))
        self.assertEqual(rec["events"]["last_seq"], len(record.wire_events(inputs["events"])) - 1)
        self.assertEqual(rec["events"]["chunks"], 0)

    def test_jcs_canonicalizes_like_rfc_8785(self):
        self.assertEqual(record.jcs({"b": 1, "a": 2}), '{"a":2,"b":1}')
        self.assertEqual(record.jcs({"x": 1.0, "y": [1, "a", True, None]}), '{"x":1,"y":[1,"a",true,null]}')
        self.assertEqual(record.jcs("中文\t\""), '"中文\\t\\""')

    def test_events_canonicalize_to_the_wire_shape(self):
        native = [{"type": "run_started", "at": 5, "seq": 1},
                  {"type": "task_start", "kind": "task", "samples": 3, "at": 6, "seq": 2},
                  {"type": "sample_done", "task": "t", "sample": 0, "passed": True, "at": 7, "seq": 3}]
        # run_started→run_start; the capability aggregate task_start (kind=task, no sample) is dropped;
        # sample_done→task_done; at→t, seq is implicit.
        self.assertEqual(record.events_canonical(native),
                         '{"event":"run_start","t":5}\n{"event":"task_done","passed":true,"sample":0,"t":7,"task":"t"}')

    def test_lifecycle_events_never_reach_the_wire(self):
        # engine run noise (phase, pull_progress, done, …) stays in the local record only — the leak that
        # a lifecycle 'done' event's absolute path caused on the first real run cannot recur on the wire.
        native = [{"type": "run_started", "at": 1, "seq": 1},
                  {"type": "phase", "phase": "pulling", "at": 2, "seq": 2},
                  {"type": "pull_progress", "status": "x", "at": 3, "seq": 3},
                  {"type": "task_start", "task": "speed@0", "kind": "speed", "at": 4, "seq": 4},
                  {"type": "done", "file": "/Users/someone/.benchclub/runs/r/bench-main.json", "at": 5, "seq": 5}]
        self.assertEqual([w["event"] for w in record.wire_events(native)], ["run_start", "task_start"])

    def test_wire_scrubs_the_home_prefix_from_every_string(self):
        native = [{"type": "tool_result", "task": "csv-export", "sample": 0, "name": "read_file", "error": True,
                   "summary": "could not open /home/alice/repo/x.py", "at": 9, "seq": 1}]
        wire = record.wire_events(native, home="/home/alice")
        self.assertEqual(wire[0]["summary"], "could not open ~/repo/x.py")

    def test_unsupported_task_omits_counts(self):
        engine_result = {"task": "tool-flight", "kind": "task", "category": "tool", "status": "unsupported",
                         "reason": "no tools", "pass": None, "passed": 0, "samples": 0, "score": None, "tokens": 0, "time": 0}
        out = record._result_0_2(engine_result, [])
        self.assertEqual(out, {"task": "tool-flight", "kind": "task", "category": "tool",
                               "status": "unsupported", "tokens": 0, "time": 0})
        for banned in ("passed", "samples_n", "samples", "score", "pass", "reason"):
            self.assertNotIn(banned, out)

    def test_sandbox_evidence_follows_javascripts_truthiness(self):
        bench = read_golden("coding", "bench-output.json")
        build = lambda sandbox: record.build_run_record(
            run_id="r", job_id="local:r", placement="local", bench={**bench, "sandbox": sandbox},
            subject=read_golden("coding", "subject.json"), digest=None, evidence={"provider": {}},
            client={"app": "benchclub", "version": "0"}, events=[], conditions={})
        self.assertEqual(build({})["test_agent"]["settings"]["sandbox"], {})
        self.assertNotIn("sandbox", build(None)["test_agent"]["settings"])


class RunRecordTest(unittest.TestCase):
    def test_an_unlisted_digest_is_recorded_but_flagged(self):
        bench = read_golden("standard", "bench-output.json")
        build = lambda digest: record.build_run_record(
            run_id="r", job_id="local:r", placement="local", bench=bench, subject=SUBJECT, digest=digest,
            evidence={"provider": {"managed": True}}, client={"app": "benchclub", "version": "0"},
            events=[], conditions={"cpu_busy_pct": None})
        self.assertTrue(build("d1")["subject"]["digest_registered"])
        self.assertFalse(build("d2")["subject"]["digest_registered"])
        self.assertFalse(build(None)["subject"]["digest_registered"])
        self.assertEqual(record.publish_blockers(build("d1")), [])
        self.assertIn("not one BenchClub has registered", record.publish_blockers(build("d2"))[0])

    def test_runs_on_someone_elses_server_cannot_be_published(self):
        rr = {"runtime": {"provider": {"managed": False}}, "subject": {"digest_registered": True}}
        self.assertIn("did not start", record.publish_blockers(rr)[0])

    def test_subjects_must_name_an_id_a_quant_and_an_ollama_tag(self):
        self.assertEqual(record.parse_bench_subject(SUBJECT)["id"], SUBJECT["id"])
        with self.assertRaisesRegex(record.SubjectError, "type"):
            record.parse_bench_subject({**SUBJECT, "type": "agent"})
        with self.assertRaisesRegex(record.SubjectError, r"ollama\.tag"):
            record.parse_bench_subject({**SUBJECT, "ollama": {}})
        with self.assertRaisesRegex(record.SubjectError, "quant"):
            record.parse_bench_subject({**SUBJECT, "quant": " "})

    def test_the_ollama_floor_is_the_higher_of_the_suites_and_the_models(self):
        compare = lambda a, b: (tuple(map(int, a.split("."))) > tuple(map(int, b.split(".")))) - (
            tuple(map(int, a.split("."))) < tuple(map(int, b.split("."))))
        self.assertEqual(record.min_ollama_version("0.12.0", SUBJECT, compare), "0.12.6")
        self.assertEqual(record.min_ollama_version("0.13.1", SUBJECT, compare), "0.13.1")
        self.assertIsNone(record.min_ollama_version(None, {**SUBJECT, "ollama": {"tag": "x"}}, compare))

    def test_highlights_round_halves_up_like_math_round(self):
        base = 1_000_000
        highlights = record.bench_highlights([
            {"at": base, "type": "run_started"},
            {"at": base + 500, "type": "text", "task": "warmup"},
            {"at": base + 4250, "type": "text", "task": "speed@0"},
            {"at": base + 4300, "type": "text", "task": "speed@0"},
            {"at": base + 9050, "type": "task_done", "task": "speed@0"},
            {"at": base + 12_000, "type": "sample_done", "task": "tool-flight", "reason": "request failed: HTTP 500"},
            {"at": base + 13_000, "type": "task_done", "task": "tool-flight", "status": "error"},
        ])
        self.assertEqual(highlights, [
            {"t": 4.3, "label": "first_token", "task": "speed@0"},
            {"t": 9.1, "label": "task_done", "task": "speed@0"},
            {"t": 12.0, "label": "error", "task": "tool-flight"},
            {"t": 13.0, "label": "error", "task": "tool-flight"},
        ])


class JsonLikeJavaScriptTest(unittest.TestCase):
    def test_numbers_print_as_json_stringify_prints_them(self):
        # Expected strings are JSON.stringify's output under Node 24.
        cases = [(0.0, "0"), (-0.0, "0"), (1.0, "1"), (100.0, "100"), (1e21, "1e+21"), (1e-7, "1e-7"),
                 (0.000001, "0.000001"), (1.5e-7, "1.5e-7"), (123456789012345680000.0, "123456789012345680000"),
                 (0.1, "0.1"), (128831.3, "128831.3"), (1e16, "10000000000000000"), (2.5e-5, "0.000025"),
                 (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"), (-42.5, "-42.5"),
                 (1234.5678e-10, "1.2345678e-7"), (0.30000000000000004, "0.30000000000000004"),
                 (float("nan"), "null"), (7, "7"), (True, "true")]
        for value, expected in cases:
            self.assertEqual(record.js_number(value), expected, value)

    def test_strings_escape_as_json_stringify_does(self):
        text = "中文 “q” \t\n\u0001\u001f\u007f\u2028 \\ \""
        self.assertEqual(record.dumps({"s": text}),
                         '{\n  "s": "中文 “q” \\t\\n\\u0001\\u001f\u007f\u2028 \\\\ \\""\n}\n')

    def test_layout_matches_json_stringify_with_two_spaces(self):
        self.assertEqual(record.dumps({"b": [], "a": {}, "c": [1, {"d": None}]}),
                         '{\n  "b": [],\n  "a": {},\n  "c": [\n    1,\n    {\n      "d": null\n    }\n  ]\n}\n')
        self.assertEqual(record.dumps({"b": 1, "a": 2}, sort_keys=True), '{\n  "a": 2,\n  "b": 1\n}\n')


if __name__ == "__main__":
    unittest.main()
