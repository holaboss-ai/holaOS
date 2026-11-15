"""suite-coding@1.0 in the CLI: the macOS-only refusal, progress per try, the matrix and the generated review."""

import io
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

import support
from hola import bench, cli, coding, pinned
from hola.errors import HolaError

NBSP = " "


def task(task_id, passed, *, status="ok", reasons=None, finished=3, attempts=None):
    return {"task": task_id, "kind": "task", "category": "coding", "status": status, "passed": passed, "samples": 3,
            "reasons": reasons or {}, "metrics": {"finished": finished}, "attempts": attempts or []}


def attempt(turns, tokens, seconds, touched=False):
    return {"turns": turns, "completion_tokens": tokens, "seconds": seconds, "touched_tests": touched}


def record(tasks, gpus=None):
    hardware = {"cpu": "Apple M5 Pro", "memory_gb": 48, **({"gpus": gpus} if gpus else {})}
    return {"subject": {"name": "Qwen3.5-2B", "quant": "Q4_K_M"},
            "runtime": {"hardware": hardware, "provider": {"engine": "ollama", "version": "0.40.10"}}, "results": tasks}


class ReviewTest(unittest.TestCase):
    def test_the_review_reads_as_the_run_page_writes_it(self):
        tasks = [
            task("fix-pagination", 3, attempts=[attempt(4, 1250, 38.5), attempt(6, 2000, 50)]),
            task("parse-duration", 2, reasons={"hidden tests failed (3 of 21)": 1}, attempts=[attempt(9, 3100, 61.5, True)]),
            task("csv-export", 0, reasons={"hidden tests failed (5 of 10)": 2, "tests could not run": 1}),
            task("checkout-bug", 3),
            task("calc-power", 0, reasons={"tool call written as text": 3}, finished=0),
        ]
        self.assertEqual(coding.review(record(tasks)), [
            "On Apple M5 Pro · 48 GB with Ollama 0.40.10, Qwen3.5-2B (Q4_K_M) solved the failing test and the reported "
            "bug every time, and the spec implementation some of the time.",
            "It did not solve the CLI option (5 of 10 hidden tests failed) or the parser change (wrote a tool call as "
            "text instead of calling the tool).",
            f"A typical try took 6 turns and 2.0K generated tokens, about 50{NBSP}s on this machine.",
            "It edited the visible tests in 1 try; they were restored before grading.",
            "This shows what Qwen3.5-2B can do as a coding agent on this hardware. It is not a ranking.",
        ])

    def test_one_unsolved_task_names_its_reason_after_a_colon(self):
        tasks = [task("fix-pagination", 1, reasons={"request failed": 2}), task("csv-export", 0, reasons={"tests timed out": 3})]
        lines = coding.review(record(tasks, gpus=["NVIDIA GeForce RTX 4090, 24564 MiB"]))
        self.assertEqual(lines[0], "On RTX 4090 24 GB · 48 GB RAM with Ollama 0.40.10, Qwen3.5-2B (Q4_K_M) solved the "
                                   "failing test some of the time and no task every time.")
        self.assertEqual(lines[1], "It did not solve the CLI option: the tests timed out.")

    def test_a_model_without_tool_calling_is_not_a_fail(self):
        lines = coding.review(record([task("fix-pagination", 0, status="unsupported")]))
        self.assertEqual(lines, ["Ollama reports no tool calling for Qwen3.5-2B (Q4_K_M), so the coding scenario could not "
                                 "run. That is not a fail."])

    def test_numbers_round_the_way_javascript_does(self):
        self.assertEqual(coding.to_fixed(1.25, 1), "1.3")
        self.assertEqual(coding.to_fixed(1.05, 1), "1.1")
        self.assertEqual(coding.thousands(1250), "1.3K")
        self.assertEqual(coding.thousands(999), "999")
        self.assertEqual(coding.thousands(None), "–")
        lines = coding.review(record([task("fix-pagination", 3, attempts=[attempt(5, 999, 40.5), attempt(6, 1001, 41.5)])]))
        self.assertIn(f"5.5 turns and 1.0K generated tokens, about 41{NBSP}s", lines[1])

    def test_the_matrix_has_one_row_per_task_with_the_main_reason(self):
        tasks = [task("fix-pagination", 3), task("parse-duration", 1, reasons={"hidden tests failed (3 of 21)": 2}, finished=2),
                 task("csv-export", 0, status="unsupported"), task("checkout-bug", 2, status="incomplete", finished=2)]
        self.assertEqual(coding.matrix(record(tasks)), [
            ("Fix a failing test", "3/3", "finished 3/3", ""),
            ("Implement from a spec", "1/3", "finished 2/3", "3 of 21 hidden tests failed"),
            ("Add a CLI option", "not supported", "–", "no tool calling in this Ollama model"),
            ("Fix a reported bug", "2/3", "finished 2/3", "did not finish"),
        ])


class Utf8Stream(io.StringIO):
    encoding = "utf-8"


class ProgressTest(unittest.TestCase):
    EVENTS = [
        {"type": "task_start", "task": "fix-pagination", "kind": "task", "category": "coding", "samples": 3},
        {"type": "attempt_start", "task": "fix-pagination", "sample": 1},
        {"type": "text", "task": "fix-pagination", "n": 1200},
        {"type": "tool_call", "task": "fix-pagination", "sample": 1, "turn": 5, "name": "read"},
        {"type": "tool_result", "task": "fix-pagination", "sample": 1, "turn": 5, "name": "read"},
        {"type": "text", "task": "fix-pagination", "n": 900},
        {"type": "sample_done", "task": "fix-pagination", "sample": 1, "passed": False,
         "reason": "hidden tests failed (2 of 9)", "turns": 9, "tokens": 3400, "seconds": 40.6},
    ]

    def render(self, tty):
        stream = Utf8Stream()
        stream.isatty = lambda: tty
        view = cli.EvalView({"name": "Qwen3.5-2B", "quant": "Q4_K_M"}, stream, "suite-coding@1.0")
        with mock.patch.object(cli.time, "monotonic", side_effect=[float(i) for i in range(100)]):
            for event in self.EVENTS:
                view("event", event)
        return stream.getvalue()

    def test_a_pipe_gets_one_line_per_try(self):
        self.assertEqual(self.render(False), "  ▸ fix-pagination try 2/3 · failed: 2 of 9 hidden tests failed · 9 turns · "
                                             "3.4K tokens · 41 s\n")

    def test_a_terminal_sees_the_turn_and_tokens_while_the_try_runs(self):
        text = self.render(True)
        self.assertIn("\r  ▸ fix-pagination try 2/3 · turn 6 · 2.1K tokens", text)
        self.assertTrue(text.endswith("9 turns · 3.4K tokens · 41 s\n"))
        self.assertEqual(text.count("\n"), 1)


class SuiteTest(unittest.TestCase):
    def test_the_suites_mirror_the_desktops_bench_suites(self):
        source = support.REPO / "runtime" / "api-server" / "src" / "bench-runner.ts"
        if not source.exists():
            self.skipTest("needs the holaOS repo")
        found = {m.group(1): (m.group(2), tuple(re.findall(r'"(\w+)"', m.group(3) or "")) or None)
                 for m in re.finditer(r'"(suite-[\w.@-]+)": \{ pack: "[^"]+", command: "(\w+)"(?:, platforms: \[([^\]]*)\])? \}',
                                      source.read_text())}
        self.assertEqual(found, {suite: (spec["command"], spec["platforms"]) for suite, spec in pinned.SUITES.items()})

    def test_elsewhere_than_macos_the_coding_scenario_says_why_it_cannot_run(self):
        for platform, name in (("linux", "Linux"), ("win32", "Windows")):
            with mock.patch.object(bench.sys, "platform", platform), self.assertRaises(HolaError) as caught:
                bench.run_eval(support.SUBJECT, suite="suite-coding@1.0", env={"HOLA_HOME": "/nonexistent"})
            self.assertEqual(caught.exception.code, "unsupported_platform")
            self.assertEqual(caught.exception.message, "The coding scenario runs on macOS only for now; it needs a sandbox "
                                                       f"we haven't shipped for {name} yet.")
            self.assertIn("hola eval openbmb-minicpm5-2b", caught.exception.next_step)

    @unittest.skipUnless(sys.platform == "darwin", "the coding scenario needs the macOS sandbox")
    def test_a_model_not_set_up_for_the_suite_is_refused(self):
        subject = {**support.SUBJECT, "suites": ["suite-standard@1.0"]}
        with self.assertRaisesRegex(HolaError, "isn't set up for suite-coding@1.0"):
            bench.run_eval(subject, suite="suite-coding@1.0", env={"HOLA_HOME": "/nonexistent"})


@unittest.skipUnless(sys.platform == "darwin", "the coding scenario needs the macOS sandbox")
class CodingRunTest(unittest.TestCase):
    def test_a_coding_run_end_to_end_against_the_fake_ollama(self):
        box = support.Sandbox()
        self.addCleanup(box.close)
        env = {**box.env, "PYTHONPATH": str(support.PACKAGE / "src"), "PYTHONIOENCODING": "utf-8"}
        out = subprocess.run([sys.executable, "-m", "hola", "eval", "qwen3.5-2b", "--suite", "suite-coding@1.0",
                              "--ignore-memory", "--json"], env=env, capture_output=True, text=True, timeout=600)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        result = json.loads(out.stdout)
        self.assertEqual(result["suite"], "suite-coding@1.0")
        self.assertEqual([r["task"] for r in result["results"]], list(coding.TASKS))
        self.assertEqual(result["summary"]["tasks"]["fix-pagination"], {"status": "ok", "passed": 3, "samples": 3})
        self.assertEqual(result["summary"]["tasks"]["calc-power"]["passed"], 0)

        rr = json.loads(Path(result["record_path"]).read_text())
        self.assertEqual(rr["suite"]["id"], "suite-coding")
        self.assertEqual(rr["runtime"]["client"]["app"], "hola-cli")
        self.assertEqual(rr["test_agent"]["settings"]["sandbox"], {"os": "seatbelt", "audit_hook": True, "network": False})
        self.assertEqual(rr["test_agent"]["settings"]["budgets"]["max_turns"], 15)
        self.assertEqual(rr["artifacts"]["transcripts"], "transcripts")
        self.assertTrue((Path(result["run_dir"]) / "transcripts" / "fix-pagination-0.jsonl").exists())
        self.assertNotIn("others_cpu_busy_pct", rr["runtime"]["conditions"])

        stream = io.StringIO()
        cli.print_eval_result(result, None, cli.Out(stream), rr)
        text = stream.getvalue()
        self.assertRegex(text, r"Fix a failing test\s+3/3\s+finished 3/3")
        self.assertRegex(text, r"Change a parser\s+0/3\s+finished 3/3\s+\d+ of \d+ hidden tests failed")
        prose = " ".join(text.split())
        self.assertIn("solved the failing test every time.", prose)
        self.assertIn("It is not a ranking.", prose)
        self.assertNotIn("won't count in charts", text)


if __name__ == "__main__":
    unittest.main()
