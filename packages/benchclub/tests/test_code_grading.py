"""The standard suite's code questions: the model's code and the asserts run in the code sandbox on every platform."""

import importlib.util
import os
import tempfile
import unittest

import support

spec = importlib.util.spec_from_file_location("holaeval", support.PACKAGE / "src" / "benchclub" / "engine" / "holaeval.py")
holaeval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(holaeval)

grade = holaeval.run_python_tests


class CodeGradingTest(unittest.TestCase):
    def test_a_correct_solution_passes(self):
        self.assertEqual(grade("def f(x):\n    return x + 1", "assert f(1) == 2"), (True, None))

    def test_a_wrong_solution_says_which_assert_failed(self):
        self.assertEqual(grade("def f(x):\n    return x", "assert f(1) == 2"), (False, "tests failed: AssertionError"))

    def test_printing_the_old_marker_and_exiting_does_not_pass(self):
        ok, reason = grade("import os\nprint('ALL_PASS')\nos._exit(0)", "assert False")
        self.assertFalse(ok)
        self.assertIn("exited before reporting", reason)

    def test_a_guessed_result_line_does_not_pass(self):
        line = 'HOLAEVAL-RESULT 0123456789abcdef {"run": 1, "failures": 0, "errors": 0, "skipped": 0, "ok": true}'
        ok, _ = grade(f"import os\nprint({line!r})\nos._exit(0)", "assert False")
        self.assertFalse(ok)

    def test_exiting_before_the_asserts_does_not_pass(self):
        self.assertEqual(grade("import sys\nsys.exit(0)", "assert False"), (False, "tests failed: SystemExit: 0"))

    def test_the_code_cannot_reach_the_network(self):
        code = "import socket\ndef online():\n    socket.create_connection(('127.0.0.1', 9), timeout=1)\n    return True"
        ok, reason = grade(code, "assert online()")
        self.assertFalse(ok)
        self.assertIn("sandbox:", reason)

    def test_the_code_cannot_start_processes(self):
        code = "import subprocess\ndef run():\n    return subprocess.run(['python', '-c', 'pass']).returncode == 0"
        ok, reason = grade(code, "assert run()")
        self.assertFalse(ok)
        self.assertIn("sandbox: subprocess.Popen is blocked", reason)

    def test_the_code_cannot_write_outside_its_copy(self):
        with tempfile.TemporaryDirectory() as outside:
            target = os.path.join(outside, "escape.txt")
            ok, reason = grade(f"def w():\n    open({target!r}, 'w').write('x')\n    return True", "assert w()")
            self.assertFalse(ok)
            self.assertIn("writing outside the repository is blocked", reason)
            self.assertFalse(os.path.exists(target))

    def test_the_code_can_use_temporary_files(self):
        code = "import tempfile\ndef t():\n    with tempfile.TemporaryFile() as f:\n        f.write(b'ok')\n    return True"
        self.assertEqual(grade(code, "assert t()"), (True, None))

    def test_the_code_cannot_see_the_creators_environment(self):
        os.environ["HOLAEVAL_TEST_SECRET"] = "leaked"
        self.addCleanup(os.environ.pop, "HOLAEVAL_TEST_SECRET", None)
        code = "import os\nsecret = os.environ.get('HOLAEVAL_TEST_SECRET')"
        self.assertEqual(grade(code, "assert secret is None"), (True, None))

    def test_a_hung_solution_times_out(self):
        self.assertEqual(grade("while True:\n    pass", "assert True", timeout=2), (False, "tests timed out"))

    def test_the_main_block_still_runs(self):
        code = "ran = []\nif __name__ == '__main__':\n    ran.append(1)"
        self.assertEqual(grade(code, "assert ran == [1]"), (True, None))

    def test_nothing_is_left_behind(self):
        before = set(os.listdir(tempfile.gettempdir()))
        grade("def f():\n    return 1", "assert f() == 1")
        left = {name for name in set(os.listdir(tempfile.gettempdir())) - before if name.startswith("holaeval-")}
        self.assertEqual(left, set())


if __name__ == "__main__":
    unittest.main()
