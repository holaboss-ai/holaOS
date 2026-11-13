import unittest

import support  # noqa: F401  (puts src/ on the path)
from benchclub.engine import suite11
from benchclub.engine.suite11 import common


class NormalizeTest(unittest.TestCase):
    def test_thinking_is_never_graded(self):
        resp = common.normalize_response({"message": {"content": "<think>the answer is 42</think>", "thinking": "42"}})
        self.assertEqual(resp["content"], "")

    def test_tool_arguments_as_string_or_dict(self):
        msg = {"tool_calls": [{"function": {"name": "a", "arguments": '{"x": 1}'}},
                              {"function": {"name": "b", "arguments": {"y": 2}}},
                              {"function": {"name": "c", "arguments": "not json"}}]}
        calls = common.normalize_response({"message": msg})["tool_calls"]
        self.assertEqual([c["arguments"] for c in calls], [{"x": 1}, {"y": 2}, None])

    def test_defaults(self):
        self.assertEqual(common.normalize_response({}), {"content": "", "tool_calls": [], "done_reason": "stop"})


class DispatchTest(unittest.TestCase):
    def test_unknown_bench_is_refused(self):
        with self.assertRaises(ValueError):
            suite11.grade({"bench": "nope"}, {})


if __name__ == "__main__":
    unittest.main()
