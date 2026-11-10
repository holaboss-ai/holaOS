import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import support
from benchclub import hub
from benchclub.errors import HolaError

CATALOG = {
    "schema": "benchclub.cli-catalog/0.1",
    "suites": ["suite-standard@1.0"],
    "runtime_profiles": [{"id": "ollama-0.40", "engine": "ollama", "version_min": "0.40.0", "version_max": None}],
    "cli": {"latest": "0.2.0", "min_publish": "0.1.0"},
    "subjects": [
        {"type": "model", "id": "openbmb-minicpm5-2b", "name": "MiniCPM5-2B", "vendor": "OpenBMB", "quant": "Q4_K_M",
         "download_bytes": 1561319547, "min_memory_gb": 8, "suites": ["suite-standard@1.0"],
         "ollama": {"tag": "openbmb/minicpm5-2b:q4_K_M", "known_digests": ["from-hub"]},
         "build_digest": "sha256:from-hub"},
        {"type": "model", "id": "qwen-qwen3-8b", "name": "Qwen3-8B", "vendor": "Qwen", "quant": "Q4_K_M",
         "download_bytes": 5200000000, "min_memory_gb": 10, "suites": ["suite-standard@1.0"],
         "ollama": {"tag": "qwen3:8b-q4_K_M", "known_digests": ["c98b"]}, "build_digest": "sha256:c98b"},
    ],
}


class FakeHub:
    """Serves JSON at the given paths and the app's HTML everywhere else, as the static host does."""

    def __init__(self, routes):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                found = self.path in routes
                data = json.dumps(routes[self.path]).encode() if found else b"<!doctype html><html></html>"
                self.send_response(200)
                self.send_header("Content-Type", "application/json" if found else "text/html")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class HubTest(unittest.TestCase):
    def setUp(self):
        self.hub = FakeHub({"/v1/cli/catalog": CATALOG})
        self.addCleanup(self.hub.close)
        self.env = {"BENCHCLUB_HUB": self.hub.url, "BENCHCLUB_API": self.hub.url}
        self.dead = {"BENCHCLUB_HUB": "http://127.0.0.1:9", "BENCHCLUB_API": "http://127.0.0.1:9"}

    def test_the_api_defaults_to_production_and_follows_the_environment(self):
        self.assertEqual(hub.api_base({}), "https://benchclub-api.imerch.ai")
        self.assertEqual(hub.api_base({"BENCHCLUB_API": "https://api.example.com/"}), "https://api.example.com")
        self.assertEqual(hub.api_base({"BENCHCLUB_HUB": "https://older.example.com"}), "https://older.example.com")

    def test_the_index_comes_from_benchclub_and_falls_back_to_the_bundled_list(self):
        entries, source = hub.fetch_subjects_index(self.env)
        self.assertEqual((source, [e["id"] for e in entries]), ("hub", ["openbmb-minicpm5-2b", "qwen-qwen3-8b"]))
        self.assertEqual(entries[1]["build_digest"], "sha256:c98b")
        entries, source = hub.fetch_subjects_index(self.dead)
        self.assertEqual(source, "bundled")
        self.assertIn("qwen-qwen3.6-35b-a3b", [e["id"] for e in entries])

    def test_a_subjects_config_prefers_benchclubs_copy_and_keeps_bundled_sampling(self):
        config, source = hub.fetch_subject("openbmb-minicpm5-2b", self.env)
        self.assertEqual((source, config["ollama"]["known_digests"]), ("hub", ["from-hub"]))
        self.assertEqual(config["sampling"]["top_p"], 0.95)
        self.assertIn("suite-coding@1.0", config["suites"])
        config, source = hub.fetch_subject("qwen-qwen3.5-2b", self.env)
        self.assertEqual((source, config["ollama"]["tag"]), ("bundled", "qwen3.5:2b-q4_K_M"))
        with self.assertRaises(HolaError):
            hub.fetch_subject("not-a-model", self.dead)

    def test_ollamas_default_tag_finds_the_q4_build(self):
        entries, _ = hub.fetch_subjects_index(self.env)
        self.assertEqual(hub.resolve("qwen3:8b", entries)["id"], "qwen-qwen3-8b")
        self.assertEqual(hub.resolve("openbmb/minicpm5-2b", entries)["id"], "openbmb-minicpm5-2b")

    def test_which_ollama_versions_count(self):
        profiles = hub.runtime_profiles(self.env)
        self.assertIsNone(hub.counted_versions("0.40.14", profiles))
        self.assertEqual(hub.counted_versions("0.41.0", profiles), "0.40.x")
        self.assertEqual(hub.counted_versions("0.9.2", profiles), "0.40.x")
        self.assertIsNone(hub.counted_versions("0.41.0", hub.runtime_profiles(self.dead)))
        ranged = [{"version_min": "0.40.0", "version_max": "0.41.3"}]
        self.assertIsNone(hub.counted_versions("0.41.3", ranged))
        self.assertEqual(hub.counted_versions("0.41.4", ranged), "0.40.0 to 0.41.3")

    def test_html_from_the_static_host_is_not_json(self):
        self.assertIsNone(hub.fetch_json(f"{self.hub.url}/bench/cli.json"))

    def test_ids_aliases_and_tags_resolve_in_any_case(self):
        entries, _ = hub.fetch_subjects_index(self.dead)
        for query in ("qwen-qwen3.5-2b", "Qwen3.5-2B", "qwen3.5:2b-q4_K_M"):
            self.assertEqual(hub.resolve(query, entries)["id"], "qwen-qwen3.5-2b")
        self.assertEqual(hub.resolve("minicpm5-2b", entries)["id"], "openbmb-minicpm5-2b")
        with self.assertRaisesRegex(HolaError, "no model called qwen") as caught:
            hub.resolve("qwen", entries)
        self.assertIn("qwen-qwen3.5-2b", caught.exception.next_step)

    def test_the_cli_policy_says_when_this_version_is_behind_or_too_old(self):
        policy = hub.fetch_cli_policy(self.env)
        self.assertEqual(policy, {"latest": "0.2.0", "min_publish": "0.1.0"})
        self.assertEqual(hub.version_status(policy, "0.1.0"),
                         {"current": "0.1.0", "latest": "0.2.0", "behind": True, "can_publish": True})
        self.assertFalse(hub.version_status(policy, "0.0.9")["can_publish"])
        self.assertIsNone(hub.version_status(hub.fetch_cli_policy(self.dead))["can_publish"])

    def test_each_publish_refusal_reads_as_a_sentence(self):
        record = {"subject": {"name": "MiniCPM5-2B", "version": "0123456789abcdef"}}
        too_old = hub.publish_refusal("client_too_old", record, {"min_publish": "0.2.0"}, current="0.1.0")
        self.assertEqual(too_old.message, "BenchClub no longer accepts runs made with benchclub 0.1.0; the oldest it takes is 0.2.0.")
        self.assertIn("--ollama-url", hub.publish_refusal("unmanaged_provider", record).next_step)
        self.assertIn("0123456789ab", hub.publish_refusal("unregistered_build", record).message)
        self.assertEqual(hub.publish_refusal("unknown_client", record).code, "unknown_client")
        self.assertEqual(hub.publish_refusal("something_new", record).code, "publish_failed")


if __name__ == "__main__":
    unittest.main()


class RememberedHubTest(unittest.TestCase):
    def test_login_hub_is_used_by_later_commands(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            env = {"BENCHCLUB_HOME": home}
            self.assertEqual(hub.api_base(env), hub.DEFAULT_API)
            saved = hub.remember_hub("http://localhost:3081/", env)
            self.assertEqual(saved, "http://localhost:3081")
            self.assertEqual(hub.api_base(env), "http://localhost:3081")
            self.assertEqual(hub.hub_base(env), "http://localhost:3081")

    def test_environment_beats_the_remembered_hub(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            hub.remember_hub("http://localhost:3081", {"BENCHCLUB_HOME": home})
            env = {"BENCHCLUB_HOME": home, "BENCHCLUB_API": "https://api.example.com"}
            self.assertEqual(hub.api_base(env), "https://api.example.com")

    def test_a_hub_needs_a_scheme_and_host(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            with self.assertRaises(HolaError):
                hub.remember_hub("localhost:3081", {"BENCHCLUB_HOME": home})
