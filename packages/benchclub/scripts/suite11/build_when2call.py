"""Build scripts/suite11/out/when2call.json: 20 When2Call test items at a pinned Hugging Face revision.

  python3 scripts/suite11/build_when2call.py                  # fetch from Hugging Face at the pinned revision
  python3 scripts/suite11/build_when2call.py --dir <dir>      # read when2call_test_llm_judge.jsonl from <dir>

Tools are wrapped exactly as When2Call's own generation harness does it
(github.com/NVIDIA/When2Call evaluation/llm_as_a_judge/run_openai_inference.py), so a model sees what the
paper's LLM-as-a-judge runs saw.
"""

import argparse
import json
import random
import re
import urllib.request
from pathlib import Path

REVISION = "0582f7749df63a96fdc3070932e83e72396ace53"
GITHUB_SHA = "ecc8d42388e91ab37e7e737d48e16e8ecea3d1dc"
HF = "https://huggingface.co/datasets/nvidia/When2Call"
FILE = "test/when2call_test_llm_judge.jsonl"
SEED = 20261113
COUNTS = {"tool_call": 7, "request_for_info": 7, "cannot_answer": 6}
HERE = Path(__file__).resolve().parent
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/legalcode.txt"

_MONTH = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
ABSOLUTE_DATE = re.compile("|".join([
    r"\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b",
    r"\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b",
    r"\b" + _MONTH + r"\.?\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\b",
    r"\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?" + _MONTH + r"\b",
    r"\b" + _MONTH + r"\.?,?\s+\d{4}\b",
    r"\b(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b",
]), re.IGNORECASE)


def upstream_tools(raw_tools):
    """run_openai_inference.py's wrapper, verbatim in effect: crude type renames over the whole JSON text."""
    tools = [json.loads(t.replace("float", "string").replace("integer", "string").replace("dict", "object")
                        .replace("tuple", "object")) for t in raw_tools]
    tools = [{"type": "function", "function": t} for t in tools]
    for t in tools:
        t["function"]["name"] = t["function"]["name"].replace(".", "_")
        t["function"]["parameters"]["type"] = "object"
        for param in t["function"]["parameters"]["properties"]:
            t["function"]["parameters"]["properties"][param]["type"] = "string"
    return tools


def load(directory):
    if directory:
        text = (Path(directory) / Path(FILE).name).read_text()
    else:
        with urllib.request.urlopen(f"{HF}/resolve/{REVISION}/{FILE}", timeout=120) as r:
            text = r.read().decode()
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def build(directory):
    rows = load(directory)
    rng = random.Random(SEED)
    items, dropped = [], 0
    for label, count in COUNTS.items():
        pool = []
        for row in rows:
            if row["correct_answer"] != label:
                continue
            if ABSOLUTE_DATE.search(row["question"] + " " + row["answers"].get("tool_call", "")):
                dropped += 1
                continue
            if not row["tools"]:
                continue
            pool.append(row)
        pool.sort(key=lambda r: r["uuid"])
        for row in rng.sample(pool, count):
            tool = None
            if label == "tool_call":
                tool = json.loads(row["target_tool"])["name"].replace(".", "_")
            items.append({
                "id": f"when2call/{row['uuid']}", "bench": "when2call", "category": label,
                "messages": [{"role": "user", "content": row["question"]}],
                "tools": upstream_tools(row["tools"]),
                "format": None, "max_tokens": 2048,
                "answer": {"expected": label, "tool": tool},
            })
    return items, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", help="directory holding when2call_test_llm_judge.jsonl at the pinned revision")
    args = ap.parse_args()
    items, dropped = build(args.dir)
    out = {
        "bench": "when2call",
        "source": {"name": "NVIDIA When2Call (test, llm_judge split)", "url": f"{HF}/tree/{REVISION}",
                   "revision": REVISION, "license": "CC-BY-4.0",
                   "license_url": "https://creativecommons.org/licenses/by/4.0/legalcode"},
        "selection": ("Seed 20261113, stratified sample of the 300-item llm_judge test split: tool_call 7, request_for_info 7, "
                      f"cannot_answer 6 (the test set has no 'answer directly' gold label); items with an absolute calendar "
                      f"date dropped ({dropped}) and cannot_answer items offering no tools skipped; question unchanged, tools "
                      f"wrapped as When2Call's run_openai_inference.py does (NVIDIA/When2Call@{GITHUB_SHA[:12]}). NOT the "
                      "official When2Call score, which uses log-prob MCQ or an LLM judge: this grades only whether the model "
                      "called a tool and, when a call is expected, whether the first call names the right function."),
        "items": items,
    }
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / "when2call.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    lic = HERE / "licenses" / "when2call"
    lic.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(LICENSE_URL, headers={"User-Agent": "Mozilla/5.0"}), timeout=120) as r:
        (lic / "LICENSE").write_bytes(r.read())
    print(len(items), "items; dropped for dates:", dropped)


if __name__ == "__main__":
    main()
