import os
import stat
import tempfile
import unittest
from pathlib import Path

import support
from hola import paths


class PathsTest(unittest.TestCase):
    def test_home_follows_each_platforms_convention(self):
        self.assertEqual(paths.home({}, "darwin", "/Users/u"), Path("/Users/u/.hola"))
        self.assertEqual(paths.home({}, "linux", "/home/u"), Path("/home/u/.local/share/hola"))
        self.assertEqual(paths.home({"XDG_DATA_HOME": "/data"}, "linux", "/home/u"), Path("/data/hola"))
        self.assertEqual(paths.home({"APPDATA": "C:/Users/u/AppData/Roaming"}, "win32", "C:/Users/u"),
                         Path("C:/Users/u/AppData/Roaming/hola"))
        self.assertEqual(paths.home({"HOLA_HOME": "/tmp/h"}, "linux", "/home/u"), Path("/tmp/h"))

    def test_runs_and_credentials_live_under_home(self):
        env = {"HOLA_HOME": "/h"}
        self.assertEqual(paths.runs_dir(env), Path("/h/runs"))
        self.assertEqual(paths.credentials_path(env), Path("/h/credentials.json"))

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_private_files_are_readable_by_their_owner_only(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d, "hola", "credentials.json")
            paths.write_private(target, '{"token": "x"}')
            paths.write_private(target, '{"token": "y"}')
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(target.read_text(), '{"token": "y"}')
            self.assertEqual(list(target.parent.iterdir()), [target])


if __name__ == "__main__":
    unittest.main()
