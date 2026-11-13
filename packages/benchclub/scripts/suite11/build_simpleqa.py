"""Build scripts/suite11/out/simpleqa.json from SimpleQA Verified at a pinned Hugging Face revision.

    python scripts/suite11/build_simpleqa.py

Standard library only. The prompt is the question alone, as in openai/simple-evals.
"""

import csv
import io
import json
import random
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "src"))

from benchclub.engine.suite11 import simpleqa  # noqa: E402

SEED = 20261113
DATASET = "google/simpleqa-verified"
REVISION = "0dc97e0d28d8233463e005cdc4475cc2a13ba2dc"
CSV_URL = f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/simpleqa_verified.csv"
PER_TOPIC = 3
TYPES = ("Number", "Date", "Person", "Place")
TIME_RELATIVE = re.compile(r"\b(current|currently|today|now|latest|recent|recently|this year|as of now)\b", re.I)
NUMBER_GOLD = re.compile(r"^\d[\d,]*(\.\d+)?%?( [A-Za-z]+){0,2}( \(acceptable range: anything between .+\))?$")
DATE_GOLD = re.compile(r"^(\d{1,2}(st|nd|rd|th)? [A-Z][a-z]+,? \d{4}|[A-Z][a-z]+ \d{1,2},? \d{4}|[A-Z][a-z]+ \d{4}|\d{4})$")
NAME_GOLD = re.compile(r"^[^\W\d_]+(?:[ .'-]+[^\W\d_]+){0,4}\.?$")
PLACE_GOLD = re.compile(r"^[^\W\d_]+(?:[ .'-]+[^\W\d_]+){0,4}(?:, [^\W\d_]+(?: [^\W\d_]+){0,2})?$")


def gradable(row):
    """True when the gold is a single number, date, name or place we can match by rule."""
    gold, kind, question = row["answer"].strip(), row["answer_type"], row["problem"]
    if kind not in TYPES or TIME_RELATIVE.search(question):
        return False
    if kind == "Number":
        ok = bool(NUMBER_GOLD.match(gold))
    elif kind == "Date":
        ok = bool(DATE_GOLD.match(gold))
    elif kind == "Person":
        ok = bool(NAME_GOLD.match(gold)) and " and " not in gold and len(gold.split()) >= 2
    else:
        ok = bool(PLACE_GOLD.match(gold)) and " and " not in gold and " or " not in gold
    if not ok:
        return False
    item = {"messages": [{"role": "user", "content": question}], "answer": {"gold": gold, "type": kind}}
    try:
        simpleqa.target(item["answer"])
    except (ValueError, IndexError):
        return False
    # A reply that only repeats the question must never pass.
    return simpleqa.grade(item, {"content": question})["outcome"] != "pass"


def main():
    with urllib.request.urlopen(CSV_URL) as r:
        rows = list(csv.DictReader(io.StringIO(r.read().decode("utf-8"))))
    by_topic = defaultdict(list)
    for row in rows:
        if gradable(row):
            by_topic[row["topic"]].append(row)
    rng = random.Random(SEED)
    items = []
    for topic in sorted(by_topic):
        pool = sorted(by_topic[topic], key=lambda r: int(r["original_index"]))
        for row in sorted(rng.sample(pool, PER_TOPIC), key=lambda r: int(r["original_index"])):
            items.append({
                "id": f"simpleqa/{row['original_index']}",
                "bench": "simpleqa",
                "category": topic,
                "messages": [{"role": "user", "content": row["problem"]}],
                "tools": None,
                "format": None,
                "max_tokens": 2048,
                "answer": {"gold": row["answer"].strip(), "type": row["answer_type"]},
            })
    out = {
        "bench": "simpleqa",
        "source": {
            "name": "SimpleQA Verified",
            "url": f"https://huggingface.co/datasets/{DATASET}",
            "revision": REVISION,
            "license": "MIT",
            "license_url": f"https://huggingface.co/datasets/{DATASET}/blob/{REVISION}/README.md",
        },
        "selection": (
            f"{PER_TOPIC} per topic ({len(by_topic)} topics), seed {SEED}, from questions whose gold is a single "
            "number (optionally with its acceptable range), date, person or place that rule matching can check, "
            "with no time-relative wording and no gold already in the question; prompt is the question alone."
        ),
        "items": items,
    }
    dest = HERE / "out" / "simpleqa.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"wrote {len(items)} items to {dest}; eligible per topic: "
          + ", ".join(f"{t} {len(v)}" for t, v in sorted(by_topic.items())))


if __name__ == "__main__":
    main()
