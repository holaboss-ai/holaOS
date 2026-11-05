import shutil
import subprocess
import sys
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
SYNC = PACKAGE / "scripts" / "sync-engine.py"
SOURCE = PACKAGE.parent.parent / "runtime" / "api-server" / "src"


@unittest.skipUnless(SOURCE.is_dir(), "runs inside the holaOS repo, where the engine's sources live")
@unittest.skipUnless(shutil.which("node"), "reading the bundled subjects needs node")
class EngineSyncTest(unittest.TestCase):
    def test_the_packaged_engine_is_byte_identical_to_the_desktop_one(self):
        out = subprocess.run([sys.executable, str(SYNC), "--check"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)


if __name__ == "__main__":
    unittest.main()
