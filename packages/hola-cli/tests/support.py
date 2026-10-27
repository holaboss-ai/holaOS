"""Shared test setup: puts src/ on the path and locates the repo's parity fixtures."""

import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACKAGE / "src"))
REPO = PACKAGE.parent.parent
PARITY = REPO / "runtime" / "api-server" / "src" / "__fixtures__" / "parity"
