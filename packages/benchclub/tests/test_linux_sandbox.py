"""The engine's Linux sandbox layer. It only exists as root on Linux, so these run in a container or on a cloud worker."""

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import support

spec = importlib.util.spec_from_file_location("holaeval", support.PACKAGE / "src" / "benchclub" / "engine" / "holaeval.py")
holaeval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(holaeval)

AS_ROOT_ON_LINUX = sys.platform.startswith("linux") and os.geteuid() == 0


def tests_of(body):
    return {"tests/__init__.py": "", "tests/test_x.py": f"import os, unittest\n\n\nclass T(unittest.TestCase):\n{body}\n"}


@unittest.skipUnless(AS_ROOT_ON_LINUX, "needs root on Linux")
class LinuxSandboxTest(unittest.TestCase):
    def setUp(self):
        self.pack = tempfile.mkdtemp()
        with open(os.path.join(self.pack, "hidden.txt"), "w", encoding="utf-8") as f:
            f.write("hidden")
        self.addCleanup(shutil.rmtree, self.pack, True)
        self.box = holaeval.CodeSandbox("", deny_read=self.pack, cpu_seconds=5)
        self.addCleanup(shutil.rmtree, self.box.work, True)

    def confined(self, script):
        """A child with the OS layer but no audit hook, so only the OS can stop it."""
        return subprocess.run([self.box.python, "-I", "-B", "-c", script], cwd=self.box.work, capture_output=True, text=True,
                              env={"PATH": "/usr/bin:/bin"}, timeout=20, preexec_fn=self.box.limits)

    def test_the_smoke_test_passes_here(self):
        self.assertIsNone(holaeval.linux_sandbox_problem(self.pack))

    def test_the_run_record_names_the_layer(self):
        self.assertEqual(self.box.evidence, {"os": "linux-uid-seccomp", "audit_hook": True, "network": False})

    def test_tests_run_as_nobody_and_can_write_in_the_repo(self):
        r = self.box.run(tests_of("    def test_me(self):\n        self.assertEqual(os.getuid(), 65534)\n"
                                  "        open('made.txt', 'w').close()\n"))
        self.assertTrue(r["result"]["ok"], r["output"])

    def test_a_runaway_test_is_stopped_and_cleaned_up(self):
        r = self.box.run(tests_of("    def test_spin(self):\n        while True:\n            pass\n"), timeout=2)
        self.assertTrue(r["timed_out"] or r["result"] is None)
        self.box.run(tests_of("    def test_ok(self):\n        pass\n"))

    def test_the_os_stops_network_sockets_but_not_unix_ones(self):
        p = self.confined("import socket\na, b = socket.socketpair()\nsocket.socket(socket.AF_INET)\n")
        self.assertIn('"<string>", line 3', p.stderr)
        self.assertIn("PermissionError", p.stderr)

    def test_the_os_stops_reading_the_pack(self):
        p = self.confined(f"open({os.path.join(self.pack, 'hidden.txt')!r})\n")
        self.assertIn("PermissionError", p.stderr)

    def test_the_os_stops_writing_to_roots_home(self):
        p = self.confined(f"open({os.path.join(os.path.expanduser('~root'), '.escape')!r}, 'w')\n")
        self.assertIn("PermissionError", p.stderr)

    def test_standard_code_grading_runs_as_nobody(self):
        self.assertEqual(holaeval.run_python_tests("import os\ndef uid():\n    return os.getuid()", "assert uid() == 65534"),
                         (True, None))

    def test_standard_code_grading_has_no_network(self):
        code = "import socket\ndef online():\n    try:\n        socket.socket(socket.AF_INET)\n    except OSError:\n        return False\n    return True"
        self.assertEqual(holaeval.run_python_tests(code, "assert online() is False"), (True, None))

    def test_standard_code_grading_cannot_see_the_workers_environment(self):
        os.environ["HOLAEVAL_TEST_SECRET"] = "leaked"
        self.addCleanup(os.environ.pop, "HOLAEVAL_TEST_SECRET", None)
        code = "import os\nsecret = os.environ.get('HOLAEVAL_TEST_SECRET')"
        self.assertEqual(holaeval.run_python_tests(code, "assert secret is None"), (True, None))

    def test_the_smoke_test_passes_without_a_pack(self):
        self.assertIsNone(holaeval.linux_sandbox_problem(None))

    def test_turning_the_layer_off_is_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            box = holaeval.CodeSandbox(d, os_sandbox=False)
            self.assertEqual(box.evidence, {"os": None, "audit_hook": True, "network": None})


@unittest.skipUnless(sys.platform.startswith("linux") and not AS_ROOT_ON_LINUX, "needs a non-root user on Linux")
class NonRootLinuxTest(unittest.TestCase):
    def test_it_says_it_needs_root(self):
        self.assertIn("root", holaeval.linux_sandbox_problem("/tmp"))


if __name__ == "__main__":
    unittest.main()
