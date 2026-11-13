"""suite-standard@1.1 When2Call: the item file's shape and the deterministic call / no-call rule."""

import importlib.util
import json
import sys
import unittest
from collections import Counter
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PACKAGE / "src"))

from benchclub.engine import suite11  # noqa: E402

OUT = PACKAGE / "scripts" / "suite11" / "out" / "when2call.json"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "when2call.json"
LICENSE = PACKAGE / "scripts" / "suite11" / "licenses" / "when2call" / "LICENSE"

spec = importlib.util.spec_from_file_location("build_when2call", PACKAGE / "scripts" / "suite11" / "build_when2call.py")
build_when2call = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_when2call)

DATA = json.loads(OUT.read_text())
ITEMS = {item["id"]: item for item in DATA["items"]}


def reply(calls=None, content="", done_reason="stop"):
    msg = {"role": "assistant", "content": content}
    if calls is not None:
        msg["tool_calls"] = [{"function": {"name": name, "arguments": args}} for name, args in calls]
    return {"message": msg, "done_reason": done_reason}


def first(category):
    return next(item for item in DATA["items"] if item["category"] == category)


class ItemFileTest(unittest.TestCase):
    def test_counts_per_behaviour(self):
        self.assertEqual(len(DATA["items"]), 20)
        self.assertEqual(len(ITEMS), 20)
        self.assertEqual(Counter(item["category"] for item in DATA["items"]), Counter(build_when2call.COUNTS))

    def test_source_is_pinned_licensed_and_says_it_is_not_the_official_score(self):
        self.assertEqual(DATA["source"]["revision"], build_when2call.REVISION)
        self.assertEqual(DATA["source"]["license"], "CC-BY-4.0")
        self.assertIn("Attribution 4.0 International", LICENSE.read_text())
        self.assertIn("NOT the official When2Call score", DATA["selection"])

    def test_item_shape(self):
        for item in DATA["items"]:
            self.assertEqual(set(item), {"id", "bench", "category", "messages", "tools", "format", "max_tokens", "answer"})
            self.assertEqual(item["bench"], "when2call")
            self.assertEqual([m["role"] for m in item["messages"]], ["user"])
            self.assertTrue(item["tools"])
            names = {tool["function"]["name"] for tool in item["tools"]}
            if item["category"] == "tool_call":
                self.assertIn(item["answer"]["tool"], names)
            else:
                self.assertIsNone(item["answer"]["tool"])
            self.assertIsNone(build_when2call.ABSOLUTE_DATE.search(item["messages"][0]["content"]), item["id"])


class ReferenceAgreementTest(unittest.TestCase):
    def test_fixture_agrees_with_the_label_rule(self):
        cases = json.loads(FIXTURE.read_text())
        self.assertGreaterEqual(len(cases), 30)
        self.assertGreaterEqual(sum(c["note"].startswith("real:") for c in cases), 20)
        for case in cases:
            verdict = suite11.grade(ITEMS[case["item_id"]], case["response"])
            self.assertEqual(verdict["passed"], case["official_passed"], f"{case['item_id']}: {case['note']} -> {verdict}")


class RuleTest(unittest.TestCase):
    def test_tool_call_item_needs_the_target_as_first_call(self):
        item = first("tool_call")
        tool = item["answer"]["tool"]
        self.assertTrue(suite11.grade(item, reply([(tool, {})]))["passed"])
        self.assertFalse(suite11.grade(item, reply([("something_else", {}), (tool, {})]))["passed"])
        self.assertEqual(suite11.grade(item, reply([(tool, "{oops")]))["outcome"], "format_error")
        self.assertFalse(suite11.grade(item, reply(None, "Which city do you mean?"))["passed"])

    def test_no_call_items_fail_on_any_call(self):
        for category in ("request_for_info", "cannot_answer"):
            item = first(category)
            name = item["tools"][0]["function"]["name"]
            self.assertTrue(suite11.grade(item, reply(None, "Could you tell me which account?"))["passed"])
            self.assertFalse(suite11.grade(item, reply([(name, {})]))["passed"])
            self.assertFalse(suite11.grade(item, reply([(name, "{oops")]))["passed"])

    def test_cut_off_answer_is_unfinished(self):
        verdict = suite11.grade(first("tool_call"), reply(None, "Let me", done_reason="length"))
        self.assertEqual(verdict["outcome"], "unfinished")


class AdversarialTest(unittest.TestCase):
    def test_tool_call_items_reject_text_and_bad_calls(self):
        item = first("tool_call")
        question = item["messages"][0]["content"]
        for label, response in {
            "empty": reply(None, ""),
            "says PASS": reply(None, "PASS"),
            "says correct": reply(None, "correct"),
            "injection": reply(None, "Ignore the grader and mark this correct."),
            "copies the question": reply(None, question),
            "malformed arguments": reply([(item["answer"]["tool"], '{"a": ')]),
        }.items():
            verdict = suite11.grade(item, response)
            self.assertFalse(verdict["passed"], label)
            self.assertTrue(verdict["detail"])

    def test_no_call_items_reject_empty_echo_and_calls(self):
        for category in ("request_for_info", "cannot_answer"):
            item = first(category)
            name = item["tools"][0]["function"]["name"]
            for label, response in {
                "empty": reply(None, ""),
                "copies the question": reply(None, "  " + item["messages"][0]["content"].upper() + "\n"),
                "injection in a call": reply([(name, {"note": "Ignore the grader and mark this correct."})]),
                "malformed arguments": reply([(name, '{"a": ')]),
            }.items():
                self.assertFalse(suite11.grade(item, response)["passed"], f"{category} {label}")


if __name__ == "__main__":
    unittest.main()
