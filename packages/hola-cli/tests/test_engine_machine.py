"""The engine's Linux hardware detection, with stand-in nvidia-smi, rocm-smi and lscpu on PATH."""

import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import support
from test_engine_load import holaeval

ROCM_JSON = """WARNING: AMD GPU device(s) is/are in a low-power state. Check power control/runtime_status
{"card1": {"Card Series": "AMD Radeon RX 7900 XTX", "Card model": "0x744c", "VRAM Total Memory (B)": "25753026560"},
 "card0": {"Card series": "AMD Radeon RX 7900 XTX", "VRAM Total Memory (B)": "25753026560"},
 "system": {"Driver version": "6.8.5"}}"""


def stub(directory, name, stdout, code=0):
    path = Path(directory, name)
    path.write_text(f"#!/bin/sh\n/bin/cat <<'EOF'\n{stdout}\nEOF\nexit {code}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


@unittest.skipIf(os.name == "nt", "stand-in tools are shell scripts")
class LinuxGpusTest(unittest.TestCase):
    def gpus_with(self, **tools):
        with tempfile.TemporaryDirectory() as bin_dir:
            for name, (stdout, code) in tools.items():
                stub(bin_dir, name.replace("_", "-"), stdout, code)
            with mock.patch.dict(os.environ, {"PATH": bin_dir}):
                return holaeval.linux_gpus()

    def test_every_nvidia_card_is_listed_with_its_memory(self):
        out = "NVIDIA GeForce RTX 3090, 24576 MiB\nNVIDIA GeForce RTX 3090, 24576 MiB"
        self.assertEqual(self.gpus_with(nvidia_smi=(out, 0)),
                         ["NVIDIA GeForce RTX 3090, 24576 MiB", "NVIDIA GeForce RTX 3090, 24576 MiB"])

    def test_a_failing_nvidia_smi_lists_nothing(self):
        self.assertEqual(self.gpus_with(nvidia_smi=("NVIDIA-SMI has failed because it couldn't communicate", 9)), [])

    def test_amd_cards_come_from_rocm_smi_in_card_order(self):
        self.assertEqual(self.gpus_with(rocm_smi=(ROCM_JSON, 0)),
                         ["AMD Radeon RX 7900 XTX, 24560 MiB", "AMD Radeon RX 7900 XTX, 24560 MiB"])

    def test_no_gpu_tools_means_no_gpus(self):
        self.assertEqual(self.gpus_with(), [])

    def test_lscpu_names_the_cores_when_cpuinfo_does_not(self):
        out = "Architecture: aarch64\nModel name: Cortex-A76\nModel name: Cortex-A55\nModel name: Cortex-A76"
        with tempfile.TemporaryDirectory() as bin_dir:
            stub(bin_dir, "lscpu", out)
            with mock.patch.dict(os.environ, {"PATH": bin_dir}):
                self.assertEqual(holaeval.lscpu_model_name(), "Cortex-A76 + Cortex-A55")


if __name__ == "__main__":
    unittest.main()
