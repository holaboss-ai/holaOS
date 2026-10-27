"""The engine's others-busy sampling, with a fake process table and tick counter."""

import importlib.util
import unittest

import support

spec = importlib.util.spec_from_file_location("holaeval", support.PACKAGE / "src" / "hola" / "engine" / "holaeval.py")
holaeval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(holaeval)

# pid: (ppid, name, CPU seconds)
BEFORE = {1: (0, "launchd", 100.0), 100: (1, "ollama", 10.0), 101: (100, "llama-server", 50.0),
          200: (1, "Arc Helper", 30.0), 300: (1, "ollama", 7.0)}
AFTER = {1: (0, "launchd", 100.5), 100: (1, "ollama", 14.0), 101: (100, "llama-server", 55.0),
         102: (100, "llama-server", 1.0), 200: (1, "Arc Helper", 32.0), 300: (1, "ollama", 7.0)}


class OthersCpuTest(unittest.TestCase):
    def test_ollamas_tree_is_taken_out_of_the_machines_busy_share(self):
        # 50% of 18 cores busy for 2 s; the server tree (100, 101, 102) used 4 + 5 + 1 = 10 core-seconds.
        pct = holaeval.others_cpu_pct(((1800, 3600), BEFORE), ((3600, 7200), AFTER), 2.0, 18, root_pid=100)
        self.assertEqual(pct, round(50 - 100 * 10 / 36, 1))

    def test_without_a_server_pid_ollama_and_its_runners_are_found_by_name(self):
        self.assertEqual(holaeval.ollama_tree(AFTER), {100, 101, 102, 300})
        self.assertEqual(holaeval.ollama_tree(AFTER, root_pid=100), {100, 101, 102})

    def test_unknown_or_wrapped_counters_give_no_reading(self):
        self.assertIsNone(holaeval.others_cpu_pct(((10, 20), BEFORE), ((5, 30), AFTER), 1.0, 4))
        self.assertIsNone(holaeval.others_cpu_pct((None, BEFORE), ((5, 30), AFTER), 1.0, 4))
        self.assertIsNone(holaeval.others_cpu_pct(((10, 20), None), ((15, 30), AFTER), 1.0, 4))
        self.assertEqual(holaeval.others_cpu_pct(((0, 100), BEFORE), ((100, 200), AFTER), 0.001, 1, root_pid=100), 0.0)

    def test_ps_cpu_times_parse_in_every_layout(self):
        self.assertEqual(holaeval.parse_cpu_time("0:02.50"), 2.5)
        self.assertEqual(holaeval.parse_cpu_time("12:34.56"), 754.56)
        self.assertEqual(holaeval.parse_cpu_time("1:02:03"), 3723)
        self.assertEqual(holaeval.parse_cpu_time("2-01:00:00"), 2 * 86400 + 3600)


class SamplerTest(unittest.TestCase):
    def test_one_process_read_and_one_tick_read_at_each_end_of_a_request(self):
        calls = {"procs": 0, "ticks": 0}
        procs, ticks, clock = iter([BEFORE, AFTER]), iter([(1800, 3600), (3600, 7200)]), iter([0.0, 2.0])

        def read_procs():
            calls["procs"] += 1
            return next(procs)

        def read_ticks():
            calls["ticks"] += 1
            return next(ticks)

        sampler = holaeval.LoadSampler(100, read_procs=read_procs, read_ticks=read_ticks, clock=lambda: next(clock),
                                       cpus=18, gpu=lambda p: 12.5 if 100 in p else None, windows=False)
        reading = sampler.end(sampler.begin())
        self.assertEqual(reading, {"others_cpu_busy_pct": 22.2, "others_gpu_busy_pct": 12.5})
        self.assertEqual(calls, {"procs": 2, "ticks": 2})

    def test_a_failing_reader_gives_null_rather_than_breaking_the_run(self):
        def broken():
            raise OSError("no /proc")
        sampler = holaeval.LoadSampler(None, read_procs=broken, read_ticks=broken, cpus=4, gpu=False, windows=False)
        self.assertEqual(sampler.end(sampler.begin()), {"others_cpu_busy_pct": None})

    def test_medians_cover_the_timed_requests_and_skip_absent_readings(self):
        runs = [{"others_cpu_busy_pct": 3.0}, {"others_cpu_busy_pct": None}, {"others_cpu_busy_pct": 9.0},
                {"others_cpu_busy_pct": 4.0}]
        self.assertEqual(holaeval.median_load(runs), {"others_cpu_busy_pct": 4.0})
        self.assertEqual(holaeval.median_load([{"others_cpu_busy_pct": None}]), {"others_cpu_busy_pct": None})
        self.assertEqual(holaeval.median_load([{"x": 1}]), {})


class GpuAndWindowsParsingTest(unittest.TestCase):
    PMON = """# gpu         pid   type     sm    mem    enc    dec    jpg    ofa    command
# Idx           #    C/G      %      %      %      %      %      %    name
    0       4242     C     71     40      -      -      -      -    llama-server
    0       5150     G     10      3      -      -      -      -    Xorg
    1          -     -      -      -      -      -      -      -    -
"""

    def test_pmon_counts_other_processes_as_a_share_of_all_gpus(self):
        self.assertEqual(holaeval.parse_pmon(self.PMON, {4242}), 5.0)
        self.assertEqual(holaeval.parse_pmon(self.PMON, set()), 5.0)
        self.assertEqual(holaeval.parse_pmon(self.PMON, {9999}), 40.5)
        self.assertIsNone(holaeval.parse_pmon("No devices were found\n", {1}))

    def test_typeperf_subtracts_ollamas_processes_per_core_share(self):
        csv = ('\r\n"(PDH-CSV 4.0)","\\\\PC\\Processor(_Total)\\% Processor Time","\\\\PC\\Process(Idle)\\% Processor Time",'
               '"\\\\PC\\Process(ollama)\\% Processor Time","\\\\PC\\Process(llama-server)\\% Processor Time",'
               '"\\\\PC\\Process(chrome)\\% Processor Time"\r\n'
               '"10/27/2026 12:00:01.123","40.0","1200.0","20.0","300.0","80.0"\r\nExiting, please wait...\r\n')
        self.assertEqual(holaeval.parse_typeperf(csv, 16), 20.0)
        self.assertIsNone(holaeval.parse_typeperf("Error: No valid counters.\r\n", 16))


if __name__ == "__main__":
    unittest.main()
