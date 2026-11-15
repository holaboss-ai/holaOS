"""HolaHub's public reads: which models can be tested and which hola versions may publish.

Nothing about a run leaves the machine from this module; signing in and publishing live in account.py.
"""

import json
import os
import re
import urllib.parse
import urllib.request

from hola import __version__, pinned
from hola.errors import HolaError
from hola.ollama import compare_versions

DEFAULT_HUB = "https://hub.holaos.ai"
DEFAULT_API = "https://api.holaos.ai"
TIMEOUT_S = 10


def hub_base(env=None):
    """HolaHub's site, where the subject configs are static files. Staging: HOLA_HUB=https://hub.imerchstaging.com"""
    env = os.environ if env is None else env
    return (env.get("HOLA_HUB") or DEFAULT_HUB).rstrip("/")


def api_base(env=None):
    """The BFF in front of HolaHub's API (`<api>/gateway/hub/...`). Staging: HOLA_API=https://api.imerchstaging.com"""
    env = os.environ if env is None else env
    return (env.get("HOLA_API") or DEFAULT_API).rstrip("/")


def fetch_json(url, timeout=TIMEOUT_S):
    """The parsed body, or None when unreachable or not JSON (the static host answers unknown paths with its app's HTML)."""
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": f"hola-cli/{__version__}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            if "json" not in (response.headers.get("Content-Type") or ""):
                return None
            return json.loads(response.read())
    except (OSError, ValueError):
        return None


def derived_aliases(entry):
    """`minicpm5-2b` for `openbmb-minicpm5-2b`: the id without its vendor prefix, and the Ollama tag."""
    aliases = []
    subject_id, vendor = entry.get("id") or "", (entry.get("vendor") or "").lower()
    if vendor and subject_id.startswith(vendor + "-"):
        aliases.append(subject_id[len(vendor) + 1:])
    tag = (entry.get("ollama") or {}).get("tag")
    if tag:
        aliases.append(tag)
    return aliases


def catalog_entry(subject):
    return {
        "id": subject["id"],
        "aliases": list(dict.fromkeys([*(subject.get("aliases") or []), *derived_aliases(subject)])),
        "name": subject.get("name"),
        "vendor": subject.get("vendor"),
        "quant": subject.get("quant"),
        "download_bytes": subject.get("download_bytes"),
        "min_memory_gb": subject.get("min_memory_gb"),
        "suites": subject.get("suites") or [],
    }


def fetch_subjects_index(env=None):
    """(entries, source): HolaHub's subjects index, or the bundled list when HolaHub can't be reached."""
    body = fetch_json(f"{hub_base(env)}/bench/subjects/index.json")
    entries = body.get("subjects") if isinstance(body, dict) else body
    if isinstance(entries, list) and entries and all(isinstance(e, dict) and e.get("id") for e in entries):
        return [catalog_entry(e) for e in entries], "hub"
    return [catalog_entry(s) for s in pinned.bundled_subjects()], "bundled"


def resolve(query, entries):
    """An id, an alias or an Ollama tag, any case → its catalog entry."""
    wanted = query.strip().lower()
    by_id = [e for e in entries if e["id"].lower() == wanted]
    matches = by_id or [e for e in entries if wanted in (a.lower() for a in e["aliases"])]
    if len(matches) == 1:
        return matches[0]
    if matches:
        ids = ", ".join(e["id"] for e in matches)
        raise HolaError("unknown_subject", f"{query} could mean {ids}.", "Run it again with one of those ids.")
    close = [e["id"] for e in entries if wanted and (wanted in e["id"].lower() or any(wanted in a.lower() for a in e["aliases"]))]
    hint = f"Did you mean {', '.join(close[:3])}?" if close else "Run `hola list` to see the models you can test."
    raise HolaError("unknown_subject", f"There is no model called {query}.", hint)


def fetch_subject(subject_id, env=None):
    """(config, source): HolaHub's copy wins whenever it loads, otherwise the bundled one, as on the desktop."""
    if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,99}", subject_id):
        body = fetch_json(f"{hub_base(env)}/bench/subjects/{urllib.parse.quote(subject_id)}.json")
        if isinstance(body, dict) and body.get("id") == subject_id:
            return body, "hub"
    bundled = next((s for s in pinned.bundled_subjects() if s.get("id") == subject_id), None)
    if bundled:
        return bundled, "bundled"
    raise HolaError("unknown_subject", f"Couldn't load {subject_id}'s config from HolaHub.",
                    "Check your connection, then run this again.")


def fetch_cli_policy(env=None):
    """HolaHub's {latest, min_publish} for hola, or None when it can't be read."""
    body = fetch_json(f"{api_base(env)}/gateway/hub/public/bench/cli.json", timeout=5)
    if isinstance(body, dict) and isinstance(body.get("latest"), str):
        return {"latest": body["latest"], "min_publish": body.get("min_publish") if isinstance(body.get("min_publish"), str) else None}
    return None


def version_status(versions, current=__version__):
    """Whether this hola is behind, and whether HolaHub still accepts its runs (None when unknown)."""
    if not versions:
        return {"current": current, "latest": None, "behind": False, "can_publish": None}
    floor = versions.get("min_publish")
    return {
        "current": current,
        "latest": versions["latest"],
        "behind": compare_versions(current, versions["latest"]) < 0,
        "can_publish": None if floor is None else compare_versions(current, floor) >= 0,
    }


def publish_refusal(reason, record, details=None, current=__version__):
    """HolaHub's 422 reasons for a refused publish, as a HolaError a person can act on."""
    details = details or {}
    subject = record.get("subject") or {}
    if reason == "client_too_old":
        floor = details.get("min_publish") or "a newer version"
        return HolaError(reason, f"HolaHub no longer accepts runs made with hola {current}; the oldest it takes is {floor}.",
                         "Update hola, run the benchmark again, then publish the new run.", details)
    if reason == "unmanaged_provider":
        return HolaError(reason, "This run used an Ollama server hola didn't start, so its conditions are unknown "
                                 "and it can't be published.", "Run it again without --ollama-url.", details)
    if reason == "unregistered_build":
        digest = (subject.get("version") or "unknown")[:12]
        return HolaError(reason, f"This build of {subject.get('name') or 'the model'} (digest {digest}) isn't one HolaHub "
                                 "has registered, so the run can't be published.",
                         "Run `hola eval` again to test the build HolaHub lists.", details)
    if reason == "unknown_client":
        return HolaError(reason, "HolaHub didn't recognize the app that made this run, so it can't be published.",
                         "Run the benchmark again with the current hola, then publish the new run.", details)
    return HolaError("publish_failed", f"HolaHub refused the run ({reason}).", "Run `hola doctor`, then try again.", details)
