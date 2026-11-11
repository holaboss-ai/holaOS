"""The machine the CLI tells BenchClub about at sign-in, and the models it suggests after a run."""

import getpass
import io
import socket
import unittest
from unittest import mock

import support  # noqa: F401  (puts src/ on the path)
from benchclub import account, cli, submit
from benchclub.errors import HolaError


class Recorder:
    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    def __call__(self, method, path, *, body=None, token=None):
        self.calls.append((method, path, body, token))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class MachineReportTest(unittest.TestCase):
    def test_the_report_names_the_hardware_and_nothing_personal(self):
        report = account.machine_report()
        self.assertEqual(set(report), {"cpu", "memory_gb", "gpus", "os", "arch"})
        text = repr(report).lower()
        for private in {socket.gethostname().split(".")[0].lower(), getpass.getuser().lower()}:
            if len(private) > 3:
                self.assertNotIn(private, text)

    def test_signing_in_sends_it_with_the_new_token(self):
        recorder = Recorder((204, None))
        with mock.patch.object(account, "_request", recorder), \
                mock.patch.object(account, "machine_report", lambda: {"cpu": "Apple M5 Pro", "memory_gb": 48}):
            self.assertTrue(account.report_machine("hcli_new"))
        self.assertEqual(recorder.calls, [("PUT", "/v1/me/machine", {"cpu": "Apple M5 Pro", "memory_gb": 48}, "hcli_new")])

    def test_a_hub_that_cant_take_it_doesnt_stop_sign_in(self):
        for answer in (HolaError("offline", "Couldn't reach the hub."), (404, None)):
            with mock.patch.object(account, "_request", Recorder(answer)), \
                    mock.patch.object(account, "machine_report", lambda: {}):
                self.assertFalse(account.report_machine("hcli_new"))
        with mock.patch.object(account, "machine_report", side_effect=OSError("sysctl")):
            self.assertFalse(account.report_machine("hcli_new"))

    def test_finishing_a_login_reports_the_machine(self):
        reported = []
        with mock.patch.object(account, "whoami", lambda token: {"id": "u1", "name": "Sudo"}), \
                mock.patch.object(account, "saved_session", lambda: None), \
                mock.patch.object(account, "_remember", lambda token, user: None), \
                mock.patch.object(account, "report_machine", reported.append):
            account._finish_login("hcli_new", cli.Out(io.StringIO()))
        self.assertEqual(reported, ["hcli_new"])


MODELS = [
    {"id": "qwen-qwen3.6-35b-a3b", "name": "Qwen3.6-35B-A3B", "quant": "Q4_K_M", "tag": "qwen3.6:35b-a3b",
     "download_bytes": 23 * 2**30},
    {"id": "google-gemma-3-12b-it", "name": "gemma-3-12b-it", "quant": "Q4_K_M", "tag": "gemma3:12b",
     "download_bytes": int(8.1 * 2**30)},
    {"id": "broken", "name": "No tag"},
]


class NextModelsTest(unittest.TestCase):
    def test_it_asks_for_a_few_and_keeps_only_runnable_ones(self):
        recorder = Recorder((200, {"machine": None, "models": MODELS}))
        with mock.patch.object(account, "_request", recorder):
            models = submit.next_models("hcli_x")
        self.assertEqual([m["tag"] for m in models], ["qwen3.6:35b-a3b", "gemma3:12b"])
        self.assertEqual(recorder.calls[0][:2], ("GET", "/v1/me/next-models?limit=3"))
        self.assertEqual(recorder.calls[0][3], "hcli_x")

    def test_an_old_hub_or_no_network_suggests_nothing(self):
        for answer in ((404, {"error": "not_found"}), (200, {"models": "?"}), HolaError("offline", "x")):
            with mock.patch.object(account, "_request", Recorder(answer)):
                self.assertEqual(submit.next_models("hcli_x"), [])

    def test_the_suggestions_are_commands_to_copy(self):
        printed = io.StringIO()
        submit.suggest_next(cli.Out(printed), MODELS[:2])
        lines = printed.getvalue().splitlines()
        self.assertIn("Next on this machine:", lines[1])
        self.assertTrue(lines[2].strip().startswith("benchclub run qwen3.6:35b-a3b  Qwen3.6-35B-A3B Q4_K_M"))
        self.assertTrue(lines[3].strip().startswith("benchclub run gemma3:12b       gemma-3-12b-it Q4_K_M"))
        self.assertIn("23.0 GB", lines[2])

    def test_nothing_to_suggest_prints_nothing(self):
        printed = io.StringIO()
        submit.suggest_next(cli.Out(printed), [])
        self.assertEqual(printed.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
