"""Signing in with the device flow and publishing, against a fake HolaHub."""

import contextlib
import io
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import support  # noqa: F401  (puts src/ on the path)
from benchclub import account, cli, paths
from benchclub.errors import HolaError

TOKEN = "hcli_tok"


class FakeHub:
    """The device-flow, session and publish endpoints, answered the way HolaHub answers them."""

    def __init__(self):
        self.polls = []  # what each /device/token poll answers, in order
        self.signed_out = set()

    def handle(self, method, path, token, body):
        if (method, path) == ("POST", "/api/auth/device/code"):
            return 200, {"device_code": "dc-1", "user_code": "ABCD1234", "verification_uri": "https://www.example/device",
                         "verification_uri_complete": "https://www.example/device?user_code=ABCD1234",
                         "expires_in": 600, "interval": 5}
        if (method, path) == ("POST", "/api/auth/device/token"):
            return self.polls.pop(0) if self.polls else (400, {"error": "authorization_pending"})
        signed_in = token is not None and token.startswith("hcli_") and token not in self.signed_out
        if (method, path) == ("GET", "/api/auth/get-session"):
            user = {"id": "u1", "name": "Sudo", "email": "sudo@example.com"}
            return 200, ({"user": user, "session": {}} if signed_in else None)
        if (method, path) == ("POST", "/api/auth/sign-out"):
            self.signed_out.add(token)
            return 200, {"success": True}
        return 404, {"error": "not_found"}


def serve(fake):
    class Handler(BaseHTTPRequestHandler):
        def _answer(self):
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length)) if length else None
            auth = self.headers.get("authorization") or ""
            token = auth[len("Bearer "):] if auth.startswith("Bearer ") else None
            status, answer = fake.handle(self.command, self.path, token, body)
            raw = json.dumps(answer).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        do_GET = do_POST = _answer

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class AccountTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.fake = FakeHub()
        self.server = serve(self.fake)
        env = {"BENCHCLUB_HOME": str(self.home), "BENCHCLUB_API": f"http://127.0.0.1:{self.server.server_port}",
               "BENCHCLUB_HUB": "https://hub.example"}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.printed = io.StringIO()
        self.out = cli.Out(self.printed)
        self.sleeps = []

    def login(self):
        return account.login(self.out, sleep=self.sleeps.append, clock=lambda: len(self.sleeps))

    def signed_in(self):
        self.fake.polls = [(200, {"access_token": TOKEN})]
        self.login()

    def test_login_shows_the_code_waits_for_approval_and_saves_a_private_token(self):
        self.fake.polls = [(400, {"error": "authorization_pending"}), (400, {"error": "slow_down"}),
                           (200, {"access_token": TOKEN, "token_type": "Bearer"})]
        user = self.login()
        self.assertEqual(user["name"], "Sudo")
        printed = self.printed.getvalue()
        self.assertIn("    ABCD-1234\n", printed)
        self.assertIn("    https://www.example/device\n", printed)
        self.assertEqual(self.sleeps, [5, 5, 10])
        saved = json.loads(paths.credentials_path().read_text())
        entry = saved[os.environ["BENCHCLUB_API"]]
        self.assertEqual(entry["token"], TOKEN)
        self.assertEqual(entry["user"], {"id": "u1", "name": "Sudo"})
        self.assertNotIn("sudo@example.com", paths.credentials_path().read_text())
        if sys.platform != "win32":
            self.assertEqual(stat.S_IMODE(paths.credentials_path().stat().st_mode), 0o600)

    def test_a_denied_or_expired_code_says_so_and_saves_nothing(self):
        self.fake.polls = [(400, {"error": "access_denied"})]
        with self.assertRaises(HolaError) as denied:
            self.login()
        self.assertEqual(denied.exception.code, "login_denied")
        self.fake.polls = [(400, {"error": "expired_token"})]
        with self.assertRaises(HolaError) as expired:
            self.login()
        self.assertEqual(expired.exception.next_step, "Run `benchclub login` again.")
        self.assertFalse(paths.credentials_path().exists())

    def test_logout_revokes_the_session_and_deletes_the_token(self):
        self.signed_in()
        self.assertTrue(account.logout())
        self.assertIn(TOKEN, self.fake.signed_out)
        self.assertFalse(paths.credentials_path().exists())
        self.assertFalse(account.logout())

    def test_a_token_revoked_elsewhere_reads_as_signed_out(self):
        self.signed_in()
        self.fake.signed_out.add(TOKEN)
        self.assertIsNone(account.whoami(TOKEN))

    def test_an_unreachable_hub_names_the_host_and_what_to_check(self):
        with mock.patch.dict(os.environ, {"BENCHCLUB_API": "http://127.0.0.1:9"}):
            with self.assertRaises(HolaError) as caught:
                self.login()
        self.assertEqual(caught.exception.code, "offline")
        self.assertIn("127.0.0.1:9", caught.exception.message)

    def test_the_benchclub_command_wires_whoami_and_logout_with_json(self):
        self.signed_in()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(cli.main(["whoami", "--json"]), 0)
            self.assertEqual(cli.main(["logout", "--json"]), 0)
            self.assertEqual(cli.main(["whoami", "--json"]), 1)
        me, out, after = json_documents(stdout.getvalue())
        self.assertEqual(me["user"]["name"], "Sudo")
        self.assertEqual(out, {"ok": True, "was_signed_in": True})
        self.assertEqual(after["error"]["code"], "not_signed_in")


def json_documents(text):
    decoder, found, index = json.JSONDecoder(), [], 0
    while text[index:].strip():
        index += len(text[index:]) - len(text[index:].lstrip())
        value, index = decoder.raw_decode(text, index)
        found.append(value)
    return found

if __name__ == "__main__":
    unittest.main()
