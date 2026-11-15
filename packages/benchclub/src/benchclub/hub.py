"""BenchClub's public reads: which models can be run, which Ollama versions count, which benchclub may publish.

Nothing about a run leaves the machine from this module; signing in and publishing live in account.py.
"""

import json
import os
import re
import urllib.parse
import urllib.request

from benchclub import __version__, paths, pinned
from benchclub.errors import HolaError
from benchclub.ollama import compare_versions

DEFAULT_API = "https://benchclub-api.imerch.ai"
CATALOG_PATH = "/v1/cli/catalog"
TIMEOUT_S = 10
DEFAULT_QUANT = "q4_k_m"
_catalogs = {}


def saved_hub(env=None):
    """The hub `benchclub login --hub` remembered, or None."""
    try:
        config = json.loads(paths.config_path(env).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = config.get("hub") if isinstance(config, dict) else None
    return value.rstrip("/") if isinstance(value, str) and value else None


def remember_hub(url, env=None):
    """Save the hub every later command talks to. Returns the normalized URL."""
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise HolaError("bad_hub", f"{url} isn't a hub address.", "Use the full address, e.g. https://hub.example.com.")
    normalized = f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/")
    paths.write_private(paths.config_path(env), json.dumps({"hub": normalized}, indent=2))
    return normalized


def api_base(env=None):
    """BenchClub's API: $BENCHCLUB_API (or the older $BENCHCLUB_HUB), else the hub `login --hub` saved, else production."""
    env = os.environ if env is None else env
    return (env.get("BENCHCLUB_API") or env.get("BENCHCLUB_HUB") or saved_hub(env) or DEFAULT_API).rstrip("/")


hub_base = api_base


def fetch_json(url, timeout=TIMEOUT_S):
    """The parsed body, or None when unreachable or not JSON (the static host answers unknown paths with its app's HTML)."""
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": f"benchclub/{__version__}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            if "json" not in (response.headers.get("Content-Type") or ""):
                return None
            return json.loads(response.read())
    except (OSError, ValueError):
        return None


def derived_aliases(entry):
    """`minicpm5-2b` for `openbmb-minicpm5-2b`, the Ollama tag, and `qwen3:8b` for a Q4_K_M build tagged `qwen3:8b-q4_K_M`."""
    aliases = []
    subject_id, vendor = entry.get("id") or "", (entry.get("vendor") or "").lower()
    if vendor and subject_id.startswith(vendor + "-"):
        aliases.append(subject_id[len(vendor) + 1:])
    tag = (entry.get("ollama") or {}).get("tag")
    if tag:
        aliases.append(tag)
        if (entry.get("quant") or "").lower() == DEFAULT_QUANT:
            for sep in ("-", ":"):
                if tag.lower().endswith(sep + DEFAULT_QUANT):
                    aliases.append(tag[: -len(DEFAULT_QUANT) - 1])
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
        "tag": (subject.get("ollama") or {}).get("tag"),
        "build_digest": subject.get("build_digest"),
    }


def fetch_catalog(env=None):
    """BenchClub's catalog for this CLI, or None when it can't be read. Read once per process and API."""
    url = f"{api_base(env)}{CATALOG_PATH}"
    if url not in _catalogs:
        body = fetch_json(url)
        if not (isinstance(body, dict) and isinstance(body.get("subjects"), list)):
            return None
        subjects = [s for s in body["subjects"] if isinstance(s, dict) and s.get("id") and isinstance(s.get("ollama"), dict)]
        _catalogs[url] = {**body, "subjects": [with_bundled(s) for s in subjects]}
    return _catalogs[url]


def with_bundled(subject):
    """The hub's facts over the bundled config for the same tag, which adds what the hub doesn't keep (sampling)."""
    tag = str(subject["ollama"].get("tag") or "").lower()
    bundled = next((b for b in pinned.bundled_subjects() if b["ollama"]["tag"].lower() == tag), None)
    if not bundled:
        return subject
    merged = {**bundled, **{k: v for k, v in subject.items() if v is not None}}
    merged["ollama"] = {**bundled["ollama"], **subject["ollama"]}
    merged["suites"] = list(dict.fromkeys([*(subject.get("suites") or []), *(bundled.get("suites") or [])]))
    return merged


def fetch_subjects_index(env=None):
    """(entries, source): BenchClub's catalog, or the bundled list when BenchClub can't be reached."""
    catalog = fetch_catalog(env)
    if catalog and catalog["subjects"]:
        return [catalog_entry(s) for s in catalog["subjects"]], "hub"
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
    hint = f"Did you mean {', '.join(close[:3])}?" if close else "Run `benchclub list` to see the models you can test."
    raise HolaError("unknown_subject", f"There is no model called {query}.", hint)


def fetch_subject(subject_id, env=None):
    """(config, source): BenchClub's copy wins whenever it loads, otherwise the bundled one, as on the desktop."""
    catalog = fetch_catalog(env)
    found = next((s for s in (catalog or {}).get("subjects", []) if s.get("id") == subject_id), None)
    if found:
        return found, "hub"
    bundled = next((s for s in pinned.bundled_subjects() if s.get("id") == subject_id), None)
    if bundled:
        return bundled, "bundled"
    raise HolaError("unknown_subject", f"Couldn't load {subject_id}'s config from BenchClub.",
                    "Check your connection, then run this again.")


def fetch_cli_policy(env=None):
    """BenchClub's {latest, min_publish} for benchclub, or None when it can't be read."""
    body = (fetch_catalog(env) or {}).get("cli")
    if isinstance(body, dict) and isinstance(body.get("latest"), str):
        return {"latest": body["latest"], "min_publish": body.get("min_publish") if isinstance(body.get("min_publish"), str) else None}
    return None


def runtime_profiles(env=None):
    """The Ollama versions BenchClub counts runs on, or None when the catalog can't be read."""
    profiles = (fetch_catalog(env) or {}).get("runtime_profiles")
    if not isinstance(profiles, list):
        return None
    return [p for p in profiles if isinstance(p, dict) and isinstance(p.get("version_min"), str)]


def _parts(version):
    return [int(p) if p.isdigit() else 0 for p in re.split(r"[.-]", version)[:3]]


def in_profile(version, profile):
    """A bare minimum covers its own minor series, as the hub judges it."""
    low = profile["version_min"]
    if compare_versions(version, low) < 0:
        return False
    if profile.get("version_max"):
        return compare_versions(version, profile["version_max"]) <= 0
    return _parts(version)[:2] == _parts(low)[:2]


def profile_text(profile):
    if profile.get("version_max"):
        return f"{profile['version_min']} to {profile['version_max']}"
    major, minor = _parts(profile["version_min"])[:2]
    return f"{major}.{minor}.x"


def counted_versions(version, profiles):
    """None when this Ollama version counts or we can't tell; otherwise the versions that do, in words."""
    if not version or profiles is None:
        return None
    if any(in_profile(version, p) for p in profiles):
        return None
    return " or ".join(profile_text(p) for p in profiles) or "none yet"


def version_status(versions, current=__version__):
    """Whether this benchclub is behind, and whether BenchClub still accepts its runs (None when unknown)."""
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
    """BenchClub's 422 reasons for a refused publish, as a HolaError a person can act on."""
    details = details or {}
    subject = record.get("subject") or {}
    if reason == "client_too_old":
        floor = details.get("min_publish") or "a newer version"
        return HolaError(reason, f"BenchClub no longer accepts runs made with benchclub {current}; the oldest it takes is {floor}.",
                         "Update benchclub, run the benchmark again, then publish the new run.", details)
    if reason == "unmanaged_provider":
        return HolaError(reason, "This run used an Ollama server benchclub didn't start, so its conditions are unknown "
                                 "and it can't be published.", "Run it again without --ollama-url.", details)
    if reason == "unregistered_build":
        digest = (subject.get("version") or "unknown")[:12]
        return HolaError(reason, f"This build of {subject.get('name') or 'the model'} (digest {digest}) isn't one BenchClub "
                                 "has registered, so the run can't be published.",
                         "Run `benchclub run` with a model from `benchclub list`.", details)
    if reason == "unknown_client":
        return HolaError(reason, "BenchClub didn't recognize the app that made this run, so it can't be published.",
                         "Run the benchmark again with the current benchclub, then publish the new run.", details)
    return HolaError("publish_failed", f"BenchClub refused the run ({reason}).", "Run `benchclub doctor`, then try again.", details)
