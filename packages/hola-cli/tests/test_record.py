import json
import unittest

import support
from hola import record

SUBJECT = {
    "type": "model", "id": "openbmb-minicpm5-2b", "name": "MiniCPM5-2B", "vendor": "OpenBMB", "quant": "Q4_K_M",
    "ollama": {"tag": "openbmb/minicpm5-2b:q4_k_m", "known_digests": ["d1"], "min_version": "0.12.6"},
}


def read(name, fixture=""):
    return json.loads((support.PARITY / fixture / name).read_text(encoding="utf-8"))


@unittest.skipUnless(support.PARITY.is_dir(), "the parity golden lives in the holaOS repo")
class ParityGoldenTest(unittest.TestCase):
    def build(self, client, fixture=""):
        inputs = read("inputs.json", fixture)
        return record.build_run_record(
            run_id=inputs["run_id"], bench=read("bench-output.json", fixture), subject=read("subject.json", fixture),
            digest=inputs["digest"], evidence=read("evidence.json", fixture), client=client,
            artifacts={"recording": None, "cards": [], "highlights": record.bench_highlights(inputs["events"]),
                       **inputs.get("artifacts", {})},
            conditions=inputs["conditions"])

    def test_the_cli_builds_the_exact_run_record_the_desktop_test_expects(self):
        for fixture in ("", "coding"):
            with self.subTest(fixture=fixture or "standard"):
                built = self.build(read("inputs.json", fixture)["client"], fixture)
                expected = (support.PARITY / fixture / "run-record.json").read_text(encoding="utf-8")
                self.assertEqual(record.dumps(built, sort_keys=True), expected)

    def test_the_client_is_the_only_field_that_differs(self):
        desktop = self.build({"app": "holaOS", "version": "0.9.0"})
        cli = self.build({"app": "hola-cli", "version": "0.1.0"})
        cli["runtime"]["client"] = desktop["runtime"]["client"]
        self.assertEqual(record.dumps(cli), record.dumps(desktop))

    def test_sandbox_evidence_follows_javascripts_truthiness(self):
        bench = read("bench-output.json", "coding")
        build = lambda sandbox: record.build_run_record(
            run_id="r", bench={**bench, "sandbox": sandbox}, subject=read("subject.json", "coding"), digest=None,
            evidence={"kind": "local", "provider": {}}, client={}, artifacts={}, conditions={})
        self.assertEqual(build({})["test_agent"]["settings"]["sandbox"], {})
        self.assertNotIn("sandbox", build(None)["test_agent"]["settings"])


class RunRecordTest(unittest.TestCase):
    def test_an_unlisted_digest_is_recorded_but_flagged(self):
        bench = read("bench-output.json") if support.PARITY.is_dir() else None
        if bench is None:
            self.skipTest("needs the parity bench output")
        build = lambda digest: record.build_run_record(
            run_id="r", bench=bench, subject=SUBJECT, digest=digest,
            evidence={"kind": "local", "provider": {"managed": True}}, client={"app": "hola-cli", "version": "0"},
            artifacts={"recording": None, "cards": [], "highlights": []}, conditions={"cpu_busy_pct": None})
        self.assertTrue(build("d1")["subject"]["digest_registered"])
        self.assertFalse(build("d2")["subject"]["digest_registered"])
        self.assertFalse(build(None)["subject"]["digest_registered"])
        self.assertEqual(record.publish_blockers(build("d1")), [])
        self.assertIn("not one HolaHub has registered", record.publish_blockers(build("d2"))[0])

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
