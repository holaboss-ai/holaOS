"""The engine's others-busy sampling, with a fake process table and tick counter."""

import importlib.util
import os
import re
import subprocess
import sys
import time
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

    def test_the_measuring_process_itself_is_not_background_load(self):
        # holaeval (pid 200 here) used 2 more core-seconds of the 36 available.
        pct = holaeval.others_cpu_pct(((1800, 3600), BEFORE), ((3600, 7200), AFTER), 2.0, 18, root_pid=100, self_pid=200)
        self.assertEqual(pct, round(50 - 100 * 12 / 36, 1))

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
        self.assertEqual(sampler.self_pid, os.getpid())
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

    def test_typeperf_subtracts_ollama_and_this_process_per_core_share(self):
        names = ["Processor(_Total)\\% Processor Time"] + [
            f"Process({p})\\{c}" for c in ("% Processor Time", "ID Process")
            for p in ("Idle", "ollama", "llama-server", "chrome", "python#1")]
        header = ",".join(['"(PDH-CSV 4.0)"'] + [f'"\\\\PC\\{n}"' for n in names])
        values = ",".join(f'"{v}"' for v in ["10/27/2026 12:00:01.123", "40.0", "1200.0", "20.0", "300.0", "80.0",
                                               "16.0", "0", "4100", "4200", "5150", "777"])
        csv = f"\r\n{header}\r\n{values}\r\nExiting, please wait...\r\n"
        self.assertEqual(holaeval.parse_typeperf(csv, 16), 20.0)
        self.assertEqual(holaeval.parse_typeperf(csv, 16, self_pid=777), 19.0)
        self.assertIsNone(holaeval.parse_typeperf("Error: No valid counters.\r\n", 16))


@unittest.skipIf(os.name == "nt", "reads the live process table")
class LiveMachineTest(unittest.TestCase):
    """Real counters on the machine running the tests; tolerances leave room for whatever else it is doing."""

    def test_a_process_marked_as_ollama_is_taken_out_of_the_same_window(self):
        burner = subprocess.Popen([sys.executable, "-c", "while True: pass"])
        idle = subprocess.Popen(["sleep", "30"])
        try:
            time.sleep(0.3)
            before = (holaeval.read_cpu_ticks(), holaeval.read_processes())
            started = time.monotonic()
            time.sleep(2)
            wall = time.monotonic() - started
            after = (holaeval.read_cpu_ticks(), holaeval.read_processes())
        finally:
            for proc in (burner, idle):
                proc.kill()
                proc.wait()
        cpus = os.cpu_count()
        counted = holaeval.others_cpu_pct(before, after, wall, cpus, root_pid=idle.pid)
        excluded = holaeval.others_cpu_pct(before, after, wall, cpus, root_pid=burner.pid)
        one_core = 100 / cpus
        self.assertGreater(counted - excluded, 0.3 * one_core)
        self.assertLess(counted - excluded, 1.2 * one_core + 0.1)

    def test_the_tick_counter_covers_at_least_what_processes_accounted_for(self):
        # Exited and root-owned processes never show in ps, so ticks may read higher, never much lower.
        before = (holaeval.read_cpu_ticks(), holaeval.read_processes())
        started = time.monotonic()
        time.sleep(2)
        wall = time.monotonic() - started
        after = (holaeval.read_cpu_ticks(), holaeval.read_processes())
        ticks = 100 * (after[0][0] - before[0][0]) / (after[0][1] - before[0][1])
        accounted = 100 * sum(max(0.0, t - before[1][pid][2]) for pid, (_, _, t) in after[1].items()
                              if pid in before[1]) / (wall * os.cpu_count())
        self.assertGreater(ticks, accounted - 5)
        self.assertLessEqual(ticks, 100)

    @unittest.skipUnless(sys.platform == "darwin", "top's CPU usage line is the macOS reference")
    def test_the_tick_counter_agrees_with_top(self):
        before = holaeval.read_cpu_ticks()
        out = subprocess.run(["top", "-l", "2", "-n", "0", "-s", "3"], capture_output=True, text=True).stdout
        after = holaeval.read_cpu_ticks()
        idle = float(re.findall(r"CPU usage: .*?([\d.]+)% idle", out)[-1])
        ticks = 100 * (after[0] - before[0]) / (after[1] - before[1])
        self.assertLess(abs(ticks - (100 - idle)), 15)

if __name__ == "__main__":
    unittest.main()
