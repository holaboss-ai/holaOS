import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import support
from hola import hub
from hola.errors import HolaError

INDEX = {"subjects": [
    {"id": "openbmb-minicpm5-2b", "aliases": ["minicpm5-2b"], "name": "MiniCPM5-2B", "vendor": "OpenBMB", "quant": "Q4_K_M",
     "download_bytes": 1561319547, "min_memory_gb": 8, "suites": ["suite-standard@1.0"]},
    {"id": "openbmb-minicpm5-2b-q8_0", "aliases": [], "name": "MiniCPM5-2B", "vendor": "OpenBMB", "quant": "Q8_0",
     "suites": ["suite-standard@1.0"]},
]}


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
        self.hub = FakeHub({
            "/bench/subjects/index.json": INDEX,
            "/bench/subjects/openbmb-minicpm5-2b.json": {"type": "model", "id": "openbmb-minicpm5-2b", "name": "MiniCPM5-2B",
                                                          "quant": "Q4_K_M", "ollama": {"tag": "from-hub"}},
            "/gateway/hub/public/bench/cli.json": {"latest": "0.2.0", "min_publish": "0.1.0"},
        })
        self.addCleanup(self.hub.close)
        self.env = {"HOLA_HUB": self.hub.url, "HOLA_API": self.hub.url}
        self.dead = {"HOLA_HUB": "http://127.0.0.1:9", "HOLA_API": "http://127.0.0.1:9"}

    def test_bases_default_to_production_and_follow_the_environment(self):
        self.assertEqual(hub.hub_base({}), "https://hub.holaos.ai")
        self.assertEqual(hub.api_base({}), "https://api.holaos.ai")
        self.assertEqual(hub.hub_base({"HOLA_HUB": "https://hub.imerchstaging.com/"}), "https://hub.imerchstaging.com")

    def test_the_index_comes_from_holahub_and_falls_back_to_the_bundled_list(self):
        entries, source = hub.fetch_subjects_index(self.env)
        self.assertEqual((source, [e["id"] for e in entries]), ("hub", ["openbmb-minicpm5-2b", "openbmb-minicpm5-2b-q8_0"]))
        entries, source = hub.fetch_subjects_index(self.dead)
        self.assertEqual(source, "bundled")
        self.assertIn("qwen-qwen3.6-35b-a3b", [e["id"] for e in entries])

    def test_a_subjects_config_prefers_holahubs_copy(self):
        config, source = hub.fetch_subject("openbmb-minicpm5-2b", self.env)
        self.assertEqual((source, config["ollama"]["tag"]), ("hub", "from-hub"))
        config, source = hub.fetch_subject("qwen-qwen3.5-2b", self.env)
        self.assertEqual((source, config["ollama"]["tag"]), ("bundled", "qwen3.5:2b-q4_K_M"))
        with self.assertRaises(HolaError):
            hub.fetch_subject("not-a-model", self.dead)

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
        self.assertEqual(too_old.message, "HolaHub no longer accepts runs made with hola 0.1.0; the oldest it takes is 0.2.0.")
        self.assertIn("--ollama-url", hub.publish_refusal("unmanaged_provider", record).next_step)
        self.assertIn("0123456789ab", hub.publish_refusal("unregistered_build", record).message)
        self.assertEqual(hub.publish_refusal("unknown_client", record).code, "unknown_client")
        self.assertEqual(hub.publish_refusal("something_new", record).code, "publish_failed")


if __name__ == "__main__":
    unittest.main()
