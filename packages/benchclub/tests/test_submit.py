"""The submission flow against a fake hub: claim -> run -> upload event chunks -> complete."""

import io
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import support  # noqa: F401  (puts src/ on the path)
from benchclub import account, cli, paths, record as record_mod, submit
from benchclub.errors import HolaError

TOKEN = "hcli_session_token"
JOB_TOKEN = "jobtok_01JB7XQ2"
GOLDEN = support.PACKAGE / "tests" / "golden"
JOB = {
    "schema": "benchclub.job/0.1",
    "job_id": "01JB7XQ2M8K4N6P8R0T2V4X6Y8",
    "kind": "eval",
    "placement": "platform",
    "pool": "cuda-l40s",
    "suite": {"id": "suite-standard", "version": "1.0",
              "sha256": "4bbdf2da8b959801bb223c2a13d71fe952604138798ef2da0705df45794b6f67"},
    "subject": "openbmb-minicpm5-2b",
    "build": {"engine": "ollama", "tag": "openbmb/minicpm5-2b:q4_k_m",
              "digest": "sha256:71a44e98400fbd490d66332a0ebba31143479a714987c13f45c82e94025cbfa7", "quant": "Q4_K_M"},
    "runtime_profile": "ollama-0.40",
    "lease_seconds": 60,
    "heartbeat_seconds": 1,
}
CATALOG = {"suites": ["suite-standard@1.0"],
           "runtime_profiles": [{"id": "ollama-0.40", "engine": "ollama", "version_min": "0.40.0", "version_max": None}],
           "subjects": [{"type": "model", "id": "openbmb-minicpm5-2b", "name": "MiniCPM5-2B", "vendor": "OpenBMB",
                         "quant": "Q4_K_M", "suites": ["suite-standard@1.0"], "build_digest": JOB["build"]["digest"],
                         "ollama": {"tag": "openbmb/minicpm5-2b:q4_K_M", "known_digests": [JOB["build"]["digest"][7:]]}}]}


class FakeHub:
    """The device-flow and the runner endpoints (claim/heartbeat/events/complete/abort)."""

    def __init__(self):
        self.polls = [(200, {"access_token": TOKEN})]
        self.claims = []          # session tokens that claimed
        self.event_chunks = []    # bodies posted to /events, in order
        self.completed = []       # (token, record) posted to /complete
        self.aborts = []          # (token, reason)
        self.heartbeats = 0
        self.heartbeat_bodies = []
        self.beat = threading.Event()      # set when a heartbeat arrives
        self.cancel_on_heartbeat = False   # when True, heartbeat answers {"cancel": true}
        self.claim_status = (200, None)    # override to force a claim error
        self.jobs = []            # bodies posted to /v1/jobs
        self.complete_response = {"status": "finalized", "counted": True, "not_counted_reason": None,
                                  "url": "https://hub.example/bench/runs/01JB7XQ2M8K4N6P8R0T2V4X6Y8"}

    def handle(self, method, path, token, body):
        if (method, path) == ("POST", "/api/auth/device/code"):
            return 200, {"device_code": "dc-1", "user_code": "ABCD1234",
                         "verification_uri": "https://www.example/device", "expires_in": 600, "interval": 5}
        if (method, path) == ("POST", "/api/auth/device/token"):
            return self.polls.pop(0) if self.polls else (400, {"error": "authorization_pending"})
        signed_in = token is not None and token.startswith("hcli_")
        if (method, path) == ("GET", "/api/auth/get-session"):
            return 200, ({"user": {"id": "u1", "name": "Sudo"}} if signed_in else None)
        if (method, path) == ("GET", "/v1/cli/catalog"):
            return 200, CATALOG
        if (method, path) == ("POST", "/v1/jobs"):
            if not signed_in:
                return 401, {"code": "unauthorized"}
            self.jobs.append(body)
            return 201, {"job_id": JOB["job_id"], "claim_code": "K7Q2M9", "command": "benchclub run K7Q2M9"}
        if (method, path) == ("POST", "/runner/v1/claim"):
            if self.claim_status[0] != 200:
                return self.claim_status
            if not signed_in:
                return 401, {"error": "auth required"}
            self.claims.append(token)
            return 200, {"job": JOB, "token": JOB_TOKEN}
        if path.startswith("/runner/v1/jobs/"):
            action = path.rsplit("/", 1)[-1]
            job_ok = token == JOB_TOKEN
            if not job_ok:
                return 401, {"error": "bad job token"}
            if action == "heartbeat":
                self.heartbeats += 1
                self.heartbeat_bodies.append(body)
                self.beat.set()
                return 200, ({"cancel": True} if self.cancel_on_heartbeat else {"ok": True})
            if action == "events":
                self.event_chunks.append(body)
                return 202, {"ok": True}
            if action == "complete":
                self.completed.append((token, body))
                return 200, {"run_id": body["run_id"], **self.complete_response}
            if action == "abort":
                self.aborts.append((token, (body or {}).get("reason")))
                return 200, {"ok": True}
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


def golden(name):
    return json.loads((GOLDEN / "standard" / f"{name}.json").read_text(encoding="utf-8"))


class ChunkTest(unittest.TestCase):
    def test_chunks_split_by_byte_budget_and_carry_the_starting_position(self):
        wire = [{"event": "e", "t": i, "pad": "x" * 40} for i in range(5)]
        chunks = submit.chunks(wire, limit=120)
        self.assertGreater(len(chunks), 1)
        # seqs are contiguous positions, and concatenating the chunks rebuilds the log in order.
        rebuilt, seq = [], 0
        for start, events in chunks:
            self.assertEqual(start, seq)
            rebuilt.extend(events)
            seq += len(events)
        self.assertEqual(rebuilt, wire)

    def test_one_oversize_event_rides_in_its_own_chunk(self):
        wire = [{"event": "big", "t": 0, "pad": "x" * 500}]
        self.assertEqual(submit.chunks(wire, limit=64), [(0, wire)])


class SubmitTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.fake = FakeHub()
        self.server = serve(self.fake)
        env = {"BENCHCLUB_HOME": str(self.home), "BENCHCLUB_API": f"http://127.0.0.1:{self.server.server_port}",
               "BENCHCLUB_HUB": f"http://127.0.0.1:{self.server.server_port}"}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.ran = []
        account.login(cli.Out(io.StringIO()), sleep=lambda _s: None, clock=lambda: 0)

    def stub_eval(self, sleep_until=None):
        """A run_eval that writes the standard golden's record + native event log, as a real run would."""
        def run_eval(config, *, suite, job_id, placement, ui=None, env=None):
            self.ran.append({"suite": suite, "job_id": job_id, "placement": placement})
            if sleep_until is not None:
                sleep_until.wait(timeout=5)
            seeds = {n: golden(n) for n in ("inputs", "bench-output", "subject", "evidence")}
            run_id = seeds["inputs"]["run_id"]
            rec = record_mod.build_run_record(
                run_id=run_id, job_id=job_id, placement=placement, bench=seeds["bench-output"],
                subject=seeds["subject"], digest=seeds["inputs"]["digest"], evidence=seeds["evidence"],
                client={"app": "benchclub", "version": "0.1.0"}, events=seeds["inputs"]["events"],
                conditions=seeds["inputs"]["conditions"])
            run_dir = paths.runs_dir() / run_id
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / "run-record.json").write_text(record_mod.dumps(rec), encoding="utf-8")
            lines = "".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n"
                            for e in seeds["inputs"]["events"])
            (run_dir / "events.jsonl").write_text(lines, encoding="utf-8")
            return {"ok": True, "run_id": run_id, "run_dir": str(run_dir)}
        return run_eval

    def test_run_job_claims_runs_uploads_the_wire_log_and_completes(self):
        out = submit.run_job("ABCD1234", run_eval=self.stub_eval())
        # claim used the signed-in session token; the job's identity drove the run.
        self.assertEqual(self.fake.claims, [TOKEN])
        self.assertEqual(self.ran, [{"suite": "suite-standard@1.0", "job_id": JOB["job_id"], "placement": "platform"}])
        # every event chunk is a valid event-chunk/0.1 body for this job; concatenation rebuilds the wire log.
        run_id = golden("inputs")["run_id"]
        native = [json.loads(line) for line
                  in (paths.runs_dir() / run_id / "events.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        wire = record_mod.wire_events(native)
        rebuilt, seq = [], 0
        for chunk in self.fake.event_chunks:
            self.assertEqual(chunk["schema"], "benchclub.event-chunk/0.1")
            self.assertEqual(chunk["job_id"], JOB["job_id"])
            self.assertEqual(chunk["seq"], seq)
            rebuilt.extend(chunk["events"])
            seq += len(chunk["events"])
        self.assertEqual(rebuilt, wire)
        # complete carried the record under the job token, with the job's id + placement stamped in.
        (token, record), = self.fake.completed
        self.assertEqual(token, JOB_TOKEN)
        self.assertEqual(record["job_id"], JOB["job_id"])
        self.assertEqual(record["placement"], "platform")
        self.assertEqual(record["schema"], "benchclub.run-record/0.2")
        self.assertEqual(out["outcome"]["status"], "finalized")
        self.assertEqual(out["outcome"]["counted"], True)
        self.assertEqual(self.fake.aborts, [])

    def test_heartbeats_keep_the_lease_alive_while_the_suite_runs(self):
        # the stubbed run blocks until a heartbeat arrives (job heartbeat_seconds=1), proving the loop fires
        # during the run rather than only after it.
        submit.run_job("ABCD1234", run_eval=self.stub_eval(sleep_until=self.fake.beat))
        self.assertGreaterEqual(self.fake.heartbeats, 1)

    def test_heartbeats_carry_what_the_run_is_doing(self):
        def run_eval(config, *, suite, job_id, placement, ui=None, env=None):
            ui("pull", {"status": "pulling", "digest": "sha256:a", "total": 100, "completed": 40})
            ui("event", {"type": "task_done", "kind": "speed", "task": "speed@0", "decode_tps": 313.44})
            ui("event", {"type": "task_start", "kind": "task", "task": "code-intervals", "category": "code",
                         "samples": 3})
            ui("event", {"type": "sample_done", "task": "code-intervals", "sample": 0, "passed": True})
            ui("event", {"type": "sample_done", "task": "code-intervals", "sample": 1, "passed": False})
            self.fake.beat.clear()
            self.fake.beat.wait(timeout=5)
            return self.stub_eval()(config, suite=suite, job_id=job_id, placement=placement, ui=ui, env=env)
        submit.run_job("ABCD1234", run_eval=run_eval)
        sent = [b["progress"] for b in self.fake.heartbeat_bodies if b and b.get("progress")]
        self.assertTrue(sent)
        self.assertEqual(sent[-1], {
            "phase": "tasks",
            "pull": {"done": 40, "total": 100},
            "speed": [313.4],
            "tasks": [{"task": "code-intervals", "category": "code", "samples": [True, False], "total": 3}],
        })

    def test_a_server_cancel_on_heartbeat_stops_the_run_and_aborts(self):
        self.fake.cancel_on_heartbeat = True
        with self.assertRaises(HolaError) as caught:
            submit.run_job("ABCD1234", run_eval=self.stub_eval(sleep_until=self.fake.beat))
        self.assertEqual(caught.exception.code, "job_cancelled")
        self.assertEqual([r for _t, r in self.fake.aborts], ["cancelled_by_server"])
        self.assertEqual(self.fake.completed, [])

    def test_a_run_that_raises_aborts_the_job_and_reraises(self):
        def boom(config, *, suite, job_id, placement, ui=None, env=None):
            raise HolaError("bench_failed", "the benchmark stopped")
        with self.assertRaises(HolaError) as caught:
            submit.run_job("ABCD1234", run_eval=boom)
        self.assertEqual(caught.exception.code, "bench_failed")
        self.assertEqual([r for _t, r in self.fake.aborts], ["run_failed"])
        self.assertEqual(self.fake.completed, [])

    def test_a_bad_code_says_how_to_fix_it_and_runs_nothing(self):
        self.fake.claim_status = (404, {"error": "no such code"})
        with self.assertRaises(HolaError) as caught:
            submit.run_job("NOPE", run_eval=self.stub_eval())
        self.assertEqual(caught.exception.code, "bad_code")
        self.assertEqual(self.ran, [])

    def test_a_not_counted_run_reports_the_reason(self):
        self.fake.complete_response = {"status": "finalized", "counted": False,
                                       "not_counted_reason": ["engine_outside_profile"], "url": None}
        printed = io.StringIO()
        with mock.patch.object(submit, "run_job",
                               return_value={"outcome": {"status": "finalized", "run_id": "r", "counted": False,
                                                          "not_counted_reason": ["engine_outside_profile"], "url": None}}):
            args = type("A", (), {"target": "ABCD1234", "json": False})()
            submit.cmd_run(args, cli.Out(printed))
        self.assertIn("this run doesn't count", printed.getvalue())
        self.assertIn("doesn't count runs on this Ollama version", printed.getvalue())

    def test_a_busy_machine_counts_but_says_speed_does_not(self):
        printed = io.StringIO()
        submit.report(cli.Out(printed), {"status": "finalized", "counted": True,
                                         "not_counted_reason": ["machine_busy"], "url": "https://x/r/1"})
        self.assertIn("Submitted and counted", printed.getvalue())
        self.assertIn("Speed isn't counted", printed.getvalue())

    def test_a_model_name_creates_a_job_on_its_registered_build_then_claims_it(self):
        with mock.patch.object(submit, "engine_check", return_value=None), \
                mock.patch.object(submit, "run_job", return_value={"outcome": {"status": "finalized", "counted": True}}) as run_job:
            args = type("A", (), {"target": "minicpm5-2b", "json": False})()
            submit.cmd_run(args, cli.Out(io.StringIO()))
        self.assertEqual(self.fake.jobs, [{"subject": "openbmb-minicpm5-2b", "placement": "local",
                                           "suite": {"id": "suite-standard", "version": "1.0"},
                                           "build_digest": JOB["build"]["digest"]}])
        self.assertEqual(run_job.call_args.args[0], "K7Q2M9")

    def test_an_ollama_version_that_wont_count_stops_before_a_job_is_made(self):
        engine = {"version": "0.41.0", "supported": "0.40.x"}
        with mock.patch.object(submit, "engine_check", return_value=engine), \
                mock.patch.object(submit, "run_job") as run_job:
            args = type("A", (), {"target": "minicpm5-2b", "json": False})()
            with self.assertRaises(HolaError) as caught:
                submit.cmd_run(args, cli.Out(io.StringIO()))
        self.assertEqual(caught.exception.code, "engine_not_counted")
        self.assertIn("0.40.x", caught.exception.message)
        self.assertEqual((self.fake.jobs, run_job.called), ([], False))

    def test_codes_and_model_names_are_told_apart(self):
        self.assertEqual(submit.resolve_target("minicpm5-2b"), ("model", submit.hub.fetch_subjects_index()[0][0]))
        self.assertEqual(submit.resolve_target("k7q-2m9".upper()), ("code", "K7Q2M9"))
        with self.assertRaises(HolaError) as caught:
            submit.resolve_target("qwen")
        self.assertEqual(caught.exception.code, "unknown_subject")

    def test_the_benchclub_command_wires_run_with_json(self):
        outcome = {"status": "finalized", "run_id": "r1", "counted": True, "not_counted_reason": None,
                   "url": "https://hub.example/bench/runs/r1"}
        with mock.patch.object(submit, "run_job", return_value={"outcome": outcome}) as run_job:
            stdout = io.StringIO()
            with mock.patch("sys.stdout", stdout):
                self.assertEqual(cli.main(["run", "ABCD1234", "--json"]), 0)
        run_job.assert_called_once()
        self.assertEqual(run_job.call_args.args[0], "ABCD1234")
        printed = json.loads(stdout.getvalue())
        self.assertEqual(printed, {"ok": True, "status": "finalized", "run_id": "r1", "counted": True,
                                   "not_counted_reason": None, "url": "https://hub.example/bench/runs/r1"})


if __name__ == "__main__":
    unittest.main()
