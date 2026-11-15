"""Build scripts/suite11/out/bfcl.json: 50 BFCL v4 single-turn items at a pinned gorilla commit.

  python3 scripts/suite11/build_bfcl.py                 # fetch from GitHub at the pinned commit
  python3 scripts/suite11/build_bfcl.py --repo <dir>    # read a local gorilla checkout at that commit

Tools are converted the way BFCL's own `convert_to_tool(functions, GORILLA_TO_OPENAPI, <FC style>)` does it,
so a model sees exactly what an OpenAI-style function-calling model sees on the leaderboard.
"""

import argparse
import copy
import json
import random
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

SHA = "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"
URL = "https://github.com/ShishirPatil/gorilla"
RAW = f"https://raw.githubusercontent.com/ShishirPatil/gorilla/{SHA}"
DATA = "berkeley-function-call-leaderboard/bfcl_eval/data"
SEED = 20261113
COUNTS = {
    "simple_python": 10,
    "multiple": 8,
    "parallel": 8,
    "parallel_multiple": 6,
    "irrelevance": 10,
    "live_simple": 4,
    "live_multiple": 4,
}
HERE = Path(__file__).resolve().parent

GORILLA_TO_OPENAPI = {
    "integer": "integer", "number": "number", "float": "number", "string": "string", "boolean": "boolean",
    "bool": "boolean", "array": "array", "list": "array", "dict": "object", "object": "object", "tuple": "array",
    "any": "string", "byte": "integer", "short": "integer", "long": "integer", "double": "number", "char": "string",
    "ArrayList": "array", "Array": "array", "HashMap": "object", "Hashtable": "object", "Queue": "array",
    "Stack": "array", "Any": "string", "String": "string", "Boolean": "boolean",
}
PYTHON_TYPES = {"string", "integer", "float", "boolean", "array", "tuple", "dict", "any"}

_MONTH = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
ABSOLUTE_DATE = re.compile("|".join([
    r"\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b",
    r"\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b",
    r"\b" + _MONTH + r"\.?\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\b",
    r"\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?" + _MONTH + r"\b",
    r"\b" + _MONTH + r"\.?,?\s+\d{4}\b",
    r"\b(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b",
]), re.IGNORECASE)


def _cast_to_openai_type(properties, mapping):
    for key, value in properties.items():
        if "type" not in value:
            properties[key]["type"] = "string"
        else:
            var_type = value["type"]
            if mapping == GORILLA_TO_OPENAPI and var_type == "float":
                properties[key]["format"] = "float"
                properties[key]["description"] += " This is a float type value."
            properties[key]["type"] = mapping.get(var_type, "string")
        if properties[key]["type"] in ("array", "object"):
            if "properties" in properties[key]:
                properties[key]["properties"] = _cast_to_openai_type(properties[key]["properties"], mapping)
            elif "items" in properties[key]:
                items = properties[key]["items"]
                items["type"] = mapping[items["type"]]
                if items["type"] == "array" and "items" in items:
                    items["items"]["type"] = mapping[items["items"]["type"]]
                elif items["type"] == "object" and "properties" in items:
                    items["properties"] = _cast_to_openai_type(items["properties"], mapping)
    return properties


def convert_to_tool(functions):
    tools = []
    for item in copy.deepcopy(functions):
        item["name"] = re.sub(r"\.", "_", item["name"])
        item["parameters"]["type"] = "object"
        item["parameters"]["properties"] = _cast_to_openai_type(item["parameters"]["properties"], GORILLA_TO_OPENAPI)
        tools.append({"type": "function", "function": item})
    return tools


def checker_schema(function):
    """The part of a function description the AST checker reads: name, required, each param's type and item type."""
    params = {}
    for name, spec in function["parameters"]["properties"].items():
        entry = {"type": spec["type"]}
        if spec["type"] in ("array", "tuple"):
            entry["items"] = {"type": spec["items"]["type"]}
        params[name] = entry
    return {"name": function["name"], "required": list(function["parameters"].get("required", [])),
            "properties": params}


def checkable(functions):
    for fn in functions:
        for spec in fn["parameters"]["properties"].values():
            if spec.get("type") not in PYTHON_TYPES:
                return False
            if spec["type"] in ("array", "tuple") and spec.get("items", {}).get("type") not in PYTHON_TYPES:
                return False
    return True


def read_jsonl(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def fetch(repo, rel):
    if repo:
        return (Path(repo) / rel).read_text()
    with urllib.request.urlopen(f"{RAW}/{rel}", timeout=120) as r:
        return r.read().decode()


def build(repo):
    if repo:
        head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        if head != SHA:
            sys.exit(f"{repo} is at {head}, expected {SHA}")
    rng = random.Random(SEED)
    items, dropped = [], {}
    for cat, count in COUNTS.items():
        entries = read_jsonl(fetch(repo, f"{DATA}/BFCL_v4_{cat}.json"))
        answers = {}
        if cat != "irrelevance":
            answers = {a["id"]: a["ground_truth"] for a in read_jsonl(fetch(repo, f"{DATA}/possible_answer/BFCL_v4_{cat}.json"))}
        pool = []
        dropped[cat] = 0
        for e in entries:
            if len(e["question"]) != 1:
                continue
            text = " ".join(m["content"] for m in e["question"][0]) + " " + json.dumps(answers.get(e["id"]))
            if ABSOLUTE_DATE.search(text):
                dropped[cat] += 1
                continue
            if not checkable(e["function"]):
                continue
            pool.append(e)
        pool.sort(key=lambda e: e["id"])
        for e in rng.sample(pool, count):
            if cat == "irrelevance":
                answer = {"no_call": True}
            else:
                gt = answers[e["id"]]
                if "parallel" in cat or "multiple" in cat:
                    by_name = {}
                    for fn in e["function"]:
                        by_name.setdefault(fn["name"], fn)
                    functions = [checker_schema(by_name[n]) for n in dict.fromkeys(next(iter(g)) for g in gt)]
                else:
                    functions = [checker_schema(e["function"][0])]
                answer = {"functions": functions, "ground_truth": gt}
            items.append({
                "id": f"bfcl/{e['id']}", "bench": "bfcl", "category": cat,
                "messages": [{"role": m["role"], "content": m["content"]} for m in e["question"][0]],
                "tools": convert_to_tool(e["function"]),
                "format": None, "max_tokens": 2048, "answer": answer,
            })
    return items, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", help="local gorilla checkout at the pinned commit")
    args = ap.parse_args()
    items, dropped = build(args.repo)
    out = {
        "bench": "bfcl",
        "source": {"name": "Berkeley Function Calling Leaderboard v4 (single-turn AST categories)",
                   "url": f"{URL}/tree/{SHA}/berkeley-function-call-leaderboard", "revision": SHA,
                   "license": "Apache-2.0", "license_url": f"{URL}/blob/{SHA}/LICENSE"},
        "selection": ("Seed 20261113, random sample per category from the BFCL v4 files "
                      + ", ".join(f"{c} {n}" for c, n in COUNTS.items())
                      + "; items whose prompt or possible answer contains an absolute calendar date were dropped first ("
                      + ", ".join(f"{c} {n}" for c, n in dropped.items() if n) + "); prompts unchanged, no system wrapper "
                      "(BFCL's function-calling mode); tools converted as BFCL convert_to_tool does (dots in names become "
                      "underscores, float params get format float); graded with a port of BFCL ast_checker, irrelevance "
                      "passes only with no tool call."),
        "items": items,
    }
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / "bfcl.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    lic = HERE / "licenses" / "bfcl"
    lic.mkdir(parents=True, exist_ok=True)
    if args.repo:
        shutil.copyfile(Path(args.repo) / "LICENSE", lic / "LICENSE")
    else:
        (lic / "LICENSE").write_text(fetch(None, "LICENSE"))
    print(len(items), "items; dropped for dates:", dropped)


if __name__ == "__main__":
    main()
