"""Signing in to the hub with the OAuth device flow.

`benchclub login` works over SSH on a machine with no browser: it prints a code, and the person
approves it on any device. The hub scopes the session to claiming jobs, saying who it is, and signing
out. Submitting a run is a separate, claim-first flow — see submit.py.
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from benchclub import __version__, hub, paths
from benchclub.errors import HolaError

CLIENT_ID = "benchclub-cli"
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
TIMEOUT_S = 30


def _json(raw):
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def _request(method, path, *, body=None, token=None):
    """(status, parsed JSON or None). A network failure becomes a sentence about what to check."""
    base = hub.api_base()
    headers = {"Accept": "application/json", "User-Agent": f"benchclub/{__version__}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{base}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return response.status, _json(response.read())
    except urllib.error.HTTPError as error:
        return error.code, _json(error.read())
    except (urllib.error.URLError, OSError) as error:
        host = urllib.parse.urlsplit(base).netloc or base
        raise HolaError("offline", f"Couldn't reach {host} ({getattr(error, 'reason', error)}).",
                        "Check your connection, or the proxy in HTTPS_PROXY.") from None


def _read_credentials():
    try:
        saved = json.loads(paths.credentials_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return saved if isinstance(saved, dict) else {}


def _write_credentials(saved):
    paths.write_private(paths.credentials_path(), json.dumps(saved, indent=2))


def saved_session():
    """The sign-in saved for this API, or None. A staging and a production sign-in are kept apart."""
    entry = _read_credentials().get(hub.api_base())
    return entry if isinstance(entry, dict) and entry.get("token") else None


def _remember(token, user):
    saved = _read_credentials()
    saved[hub.api_base()] = {
        "token": token,
        "user": {"id": user.get("id"), "name": user.get("name")},
        "signed_in_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _write_credentials(saved)


def _forget():
    saved = _read_credentials()
    if saved.pop(hub.api_base(), None) is None:
        return
    if saved:
        _write_credentials(saved)
    else:
        paths.credentials_path().unlink(missing_ok=True)


def whoami(token):
    """The signed-in user for a token, or None when HolaHub no longer accepts it."""
    status, body = _request("GET", "/api/auth/get-session", token=token)
    if status != 200 or not isinstance(body, dict) or not isinstance(body.get("user"), dict):
        return None
    return body["user"]


def display_code(code):
    return f"{code[:4]}-{code[4:]}" if len(code) == 8 else code


def _revoke(token):
    try:
        _request("POST", "/api/auth/sign-out", body={}, token=token)
    except HolaError:
        pass


def login(out, sleep=time.sleep, clock=time.monotonic):
    """Runs the device flow and saves the session; returns the signed-in user."""
    status, grant = _request("POST", "/api/auth/device/code", body={"client_id": CLIENT_ID})
    if status != 200 or not isinstance(grant, dict) or "device_code" not in grant:
        raise HolaError("login_failed", f"HolaHub didn't start a sign-in (HTTP {status}).", "Try again in a minute.")
    out.line("To sign in, open this page on any device:")
    out.line(grant["verification_uri"], indent=4)
    out.line("and enter the code:")
    out.line(display_code(grant["user_code"]), indent=4)
    if grant.get("verification_uri_complete"):
        out.line(f"Or open {grant['verification_uri_complete']}")
    out.line(f"Waiting for you to approve it{out.ell} (Ctrl-C to cancel)")

    interval = max(int(grant.get("interval") or 5), 1)
    deadline = clock() + int(grant.get("expires_in") or 600)
    try:
        while clock() < deadline:
            sleep(interval)
            status, answer = _request("POST", "/api/auth/device/token", body={
                "grant_type": DEVICE_GRANT, "device_code": grant["device_code"], "client_id": CLIENT_ID,
            })
            answer = answer if isinstance(answer, dict) else {}
            if status == 200 and answer.get("access_token"):
                return _finish_login(answer["access_token"], out)
            error = answer.get("error")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval += 5
                continue
            if error == "access_denied":
                raise HolaError("login_denied", "The sign-in was denied in the browser. Nothing was saved.",
                                "Run `benchclub login` again if that wasn't you.")
            if error == "expired_token":
                break
            raise HolaError("login_failed", f"Sign-in failed: {answer.get('error_description') or error or status}.",
                            "Run `benchclub login` again.")
    except KeyboardInterrupt:
        raise HolaError("cancelled", "Sign-in cancelled. Nothing was saved.") from None
    raise HolaError("login_expired", "The code expired before it was approved.", "Run `benchclub login` again.")


def _finish_login(token, out):
    user = whoami(token)
    if user is None:
        raise HolaError("login_failed", "HolaHub approved the sign-in but didn't accept the session.",
                        "Run `benchclub login` again.")
    previous = saved_session()
    _remember(token, user)
    if previous and previous["token"] != token:
        _revoke(previous["token"])
    out.good(f"Signed in as {user.get('name') or 'you'}. `benchclub run <code>` can now submit runs to the hub.")
    return user


def logout():
    """Revokes the saved session on HolaHub and deletes it; False when there was none."""
    session = saved_session()
    if session is None:
        return False
    _revoke(session["token"])
    _forget()
    return True


def _emit(value):
    print(json.dumps(value, indent=2, ensure_ascii=False), flush=True)


def cmd_login(args, out):
    progress = type(out)(sys.stderr) if args.json else out
    if getattr(args, "hub", None):
        hub.remember_hub(args.hub)
    user = login(progress)
    if args.json:
        _emit({"ok": True, "user": {"id": user.get("id"), "name": user.get("name")}, "api": hub.api_base()})
    return 0


def cmd_logout(args, out):
    signed_out = logout()
    if args.json:
        _emit({"ok": True, "was_signed_in": signed_out})
    elif signed_out:
        out.good("Signed out. The sign-in on HolaHub is revoked and the saved token deleted.")
    else:
        out.line("You weren't signed in.")
    return 0


def cmd_whoami(args, out):
    session = saved_session()
    if session is None:
        raise HolaError("not_signed_in", "You're not signed in to HolaHub.", "Run `benchclub login`.")
    user = whoami(session["token"])
    if user is None:
        raise HolaError("signed_out", "Your sign-in has expired or was signed out.", "Run `benchclub login`.")
    if args.json:
        _emit({"ok": True, "user": {"id": user.get("id"), "name": user.get("name"), "email": user.get("email")},
               "api": hub.api_base()})
        return 0
    host = urllib.parse.urlsplit(hub.hub_base()).netloc
    email = f" ({user['email']})" if user.get("email") else ""
    out.good(f"Signed in to {host} as {user.get('name') or 'you'}{email}.")
    return 0


def add_commands(sub):
    """Registers login, logout and whoami on cli.py's subparsers."""
    for name, fn, help_text in (
        ("login", cmd_login, "sign in to the hub with a code you approve on any device"),
        ("logout", cmd_logout, "sign out of the hub and delete the saved token"),
        ("whoami", cmd_whoami, "show who you're signed in to the hub as"),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--json", action="store_true")
        if name == "login":
            p.add_argument("--hub", metavar="URL", help="the hub to sign in to; later commands use it too")
        p.set_defaults(fn=fn)
