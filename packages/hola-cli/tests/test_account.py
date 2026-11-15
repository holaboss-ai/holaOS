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
from hola import account, cli, paths, runs
from hola.errors import HolaError

RUN_ID = "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11"
TOKEN = "hcli_tok"


class FakeHub:
    """The device-flow, session and publish endpoints, answered the way HolaHub answers them."""

    def __init__(self):
        self.polls = []  # what each /device/token poll answers, in order
        self.signed_out = set()
        self.published = []
        self.refuse = None  # (status, body) to answer the next publishes with
        self.min_publish = "0.1.0"

    def handle(self, method, path, token, body):
        if (method, path) == ("POST", "/api/auth/device/code"):
            return 200, {"device_code": "dc-1", "user_code": "ABCD1234", "verification_uri": "https://www.example/device",
                         "verification_uri_complete": "https://www.example/device?user_code=ABCD1234",
                         "expires_in": 600, "interval": 5}
        if (method, path) == ("POST", "/api/auth/device/token"):
            return self.polls.pop(0) if self.polls else (400, {"error": "authorization_pending"})
        if (method, path) == ("GET", "/gateway/hub/public/bench/cli.json"):
            return 200, {"latest": "0.1.0", "min_publish": self.min_publish}
        signed_in = token is not None and token.startswith("hcli_") and token not in self.signed_out
        if (method, path) == ("GET", "/api/auth/get-session"):
            user = {"id": "u1", "name": "Sudo", "email": "sudo@example.com"}
            return 200, ({"user": user, "session": {}} if signed_in else None)
        if (method, path) == ("POST", "/api/auth/sign-out"):
            self.signed_out.add(token)
            return 200, {"success": True}
        if (method, path) == ("POST", "/gateway/hub/bench/runs"):
            if not signed_in:
                return 401, {"error": "Authentication required"}
            if self.refuse:
                return self.refuse
            self.published.append(body)
            return 201, {"id": body["run_record"]["run_id"]}
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


def run_record(run_id=RUN_ID, started_at="2026-10-27T10:00:00Z", **overrides):
    record = {
        "schema": "hola.run-record/0.1", "run_id": run_id, "started_at": started_at,
        "suite": {"id": "suite-standard", "version": "1.0"},
        "subject": {"id": "openbmb-minicpm5-2b", "name": "MiniCPM5-2B", "quant": "Q4_K_M", "version": "71a44e98400f",
                    "digest_registered": True},
        "runtime": {"client": {"app": "hola-cli", "version": "0.1.0"},
                    "provider": {"engine": "ollama", "version": "0.40.10", "managed": True}},
        "results": [],
    }
    record.update(overrides)
    return record


class AccountTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.fake = FakeHub()
        self.server = serve(self.fake)
        env = {"HOLA_HOME": str(self.home), "HOLA_API": f"http://127.0.0.1:{self.server.server_port}",
               "HOLA_HUB": "https://hub.example"}
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

    def save_run(self, record=None):
        record = record or run_record()
        run_dir = paths.runs_dir() / record["run_id"]
        run_dir.mkdir(parents=True)
        (run_dir / "run-record.json").write_text(json.dumps(record))
        return run_dir

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
        entry = saved[os.environ["HOLA_API"]]
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
        self.assertEqual(expired.exception.next_step, "Run `hola login` again.")
        self.assertFalse(paths.credentials_path().exists())

    def test_a_signed_out_publish_says_how_to_sign_in(self):
        with self.assertRaises(HolaError) as caught:
            account.publish_run(self.save_run())
        self.assertEqual(caught.exception.code, "not_signed_in")
        self.assertIn("hola login", caught.exception.next_step)

    def test_publish_uploads_the_record_as_is_and_returns_the_run_page(self):
        self.signed_in()
        self.save_run()
        run_dir, record = runs.resolve("6f1c")
        url = account.publish_run(run_dir, record)
        self.assertEqual(url, f"https://hub.example/bench/runs/{RUN_ID}")
        self.assertEqual(self.fake.published, [{"run_record": run_record(), "submitter_name": "Sudo"}])
        self.assertEqual(runs.published(run_dir)["url"], url)

    def test_a_run_holahub_would_refuse_never_leaves_the_machine(self):
        self.signed_in()
        unmanaged = run_record(runtime={"client": {"app": "hola-cli", "version": "0.1.0"}, "provider": {"engine": "ollama"}})
        with self.assertRaises(HolaError) as caught:
            account.publish_run(self.save_run(unmanaged))
        self.assertEqual(caught.exception.code, "not_publishable")
        self.assertEqual(self.fake.published, [])

    def test_a_refused_run_reads_holahubs_reason(self):
        self.signed_in()
        run_dir = self.save_run()
        self.fake.refuse = (422, {"error": "unregistered_build", "message": "server wording"})
        with self.assertRaises(HolaError) as caught:
            account.publish_run(run_dir)
        self.assertEqual(caught.exception.code, "unregistered_build")
        self.assertIn("71a44e98400f", caught.exception.message)
        self.assertIsNone(runs.published(run_dir))

    def test_a_retired_version_is_refused_before_uploading(self):
        self.signed_in()
        self.fake.min_publish = "9.0.0"
        with self.assertRaises(HolaError) as caught:
            account.publish_run(self.save_run())
        self.assertEqual(caught.exception.code, "client_too_old")
        self.assertIn("9.0.0", caught.exception.message)
        self.assertEqual(self.fake.published, [])

    def test_logout_revokes_the_session_and_deletes_the_token(self):
        self.signed_in()
        self.assertTrue(account.logout())
        self.assertIn(TOKEN, self.fake.signed_out)
        self.assertFalse(paths.credentials_path().exists())
        self.assertFalse(account.logout())

    def test_a_token_revoked_elsewhere_reads_as_signed_out(self):
        self.signed_in()
        self.fake.signed_out.add(TOKEN)
        with self.assertRaises(HolaError) as caught:
            account.publish_run(self.save_run())
        self.assertEqual(caught.exception.code, "signed_out")

    def test_an_unreachable_holahub_names_the_host_and_what_to_check(self):
        with mock.patch.dict(os.environ, {"HOLA_API": "http://127.0.0.1:9"}):
            with self.assertRaises(HolaError) as caught:
                self.login()
        self.assertEqual(caught.exception.code, "offline")
        self.assertIn("127.0.0.1:9", caught.exception.message)

    def test_the_hola_command_wires_publish_whoami_and_logout_with_json(self):
        self.signed_in()
        self.save_run()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(cli.main(["publish", "latest", "--json"]), 0)
            self.assertEqual(cli.main(["whoami", "--json"]), 0)
            self.assertEqual(cli.main(["logout", "--json"]), 0)
            self.assertEqual(cli.main(["whoami", "--json"]), 1)
        published, me, out, after = json_documents(stdout.getvalue())
        self.assertEqual(published, {"ok": True, "run_id": RUN_ID, "url": f"https://hub.example/bench/runs/{RUN_ID}"})
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
