"""The busy rule shared with the desktop: others' CPU while it generated over busy_others_cpu_pct (40)."""

import io
import unittest

import support
from hola import cli, pinned, runs


class BusyRuleTest(unittest.TestCase):
    def test_the_threshold_is_the_shared_one(self):
        self.assertEqual(pinned.conditions()["busy_others_cpu_pct"], 40)
        self.assertNotIn("busy_cpu_pct", pinned.conditions())

    def test_others_during_generation_decide_and_the_pre_run_sample_is_the_fallback(self):
        self.assertFalse(runs.was_busy({"cpu_busy_pct": 70, "others_cpu_busy_pct": 40}))
        self.assertTrue(runs.was_busy({"cpu_busy_pct": 10, "others_cpu_busy_pct": 40.1}))
        self.assertTrue(runs.was_busy({"cpu_busy_pct": 41}))
        self.assertTrue(runs.was_busy({"cpu_busy_pct": 41, "others_cpu_busy_pct": None}))
        self.assertFalse(runs.was_busy({"cpu_busy_pct": 40}))
        self.assertFalse(runs.was_busy({"cpu_busy_pct": None}))

    def test_eval_says_a_busy_card_wont_count_and_stays_quiet_otherwise(self):
        self.assertEqual(cli.busy_note({"cpu_busy_pct": 12, "others_cpu_busy_pct": 46.5}),
                         "Other programs used 46.5% of the CPU while it generated, so this card won't count in charts.")
        self.assertEqual(cli.busy_note({"cpu_busy_pct": 52}),
                         "Other programs used 52% of the CPU when the run started, so this card won't count in charts.")
        self.assertIsNone(cli.busy_note({"cpu_busy_pct": 60, "others_cpu_busy_pct": 26.8}))

    def test_the_summary_carries_the_note_only_for_a_busy_run(self):
        result = {"summary": {"decode_tps": 128.3, "decode_tps_8k": 119.6, "ttft_ms": 45.3, "cpu_offload": False,
                              "vram_bytes": None, "tasks": {}},
                  "record_path": "/r/run-record.json", "run_id": "90f9d8b5-0000", "publishable": True, "publish_blockers": []}
        for others, shown in ((41.0, True), (40.0, False)):
            stream = io.StringIO()
            cli.print_eval_result({**result, "conditions": {"cpu_busy_pct": 27, "others_cpu_busy_pct": others}}, None,
                                  cli.Out(stream))
            self.assertEqual("won't count in charts" in stream.getvalue(), shown, others)

    def test_doctor_warns_only_above_the_threshold(self):
        self.assertEqual(cli.load_check(40)["status"], "ok")
        warn = cli.load_check(41)
        self.assertEqual(warn["status"], "warn")
        self.assertIn("Over 40%", warn["next_step"])
        self.assertIsNone(cli.load_check(None))


if __name__ == "__main__":
    unittest.main()
