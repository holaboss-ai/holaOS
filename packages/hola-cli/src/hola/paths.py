"""Where hola keeps runs, the private Ollama's state and the sign-in token."""

import os
import sys
from pathlib import Path


def home(env=None, platform=None, user_home=None):
    """$HOLA_HOME, else ~/.hola on macOS, $XDG_DATA_HOME/hola on Linux, %APPDATA%\\hola on Windows."""
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    user_home = Path.home() if user_home is None else Path(user_home)
    if env.get("HOLA_HOME"):
        return Path(env["HOLA_HOME"])
    if platform == "win32":
        return Path(env.get("APPDATA") or user_home / "AppData" / "Roaming") / "hola"
    if platform.startswith("linux"):
        return Path(env.get("XDG_DATA_HOME") or user_home / ".local" / "share") / "hola"
    return user_home / ".hola"


def runs_dir(env=None):
    """A run lives at runs_dir()/<run_id>/run-record.json."""
    return home(env) / "runs"


def state_dir(env=None):
    return home(env) / "state"


def credentials_path(env=None):
    return home(env) / "credentials.json"


def log_path(env=None):
    return home(env) / "hola.log"


def write_private(path, text):
    """Write a file only its owner can read (0600), replacing it atomically."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode("utf-8"))
    finally:
        os.close(fd)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def display(path):
    """A path with the home directory written as ~."""
    text = str(path)
    user_home = str(Path.home())
    return "~" + text[len(user_home):] if text == user_home or text.startswith(user_home + os.sep) else text
