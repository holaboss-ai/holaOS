#!/usr/bin/env python3
"""Build scripts/suite11/out/reasoning.json from Reasoning Gym at a pinned release.

    uv run --no-project --python 3.11 --with reasoning-gym==0.1.25 python scripts/suite11/build_reasoning.py

Items are generated, not sampled: each task's dataset is created with seed 20261113 and the
difficulty below, and the first N indices are taken. Prompts are upstream's: the eval harness's
"default" system prompt plus the task question as the user message.
"""

import dataclasses
import importlib.metadata
import json
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
import reasoning_gym  # noqa: E402
from reasoning_gym.utils import SYSTEM_PROMPTS  # noqa: E402

VERSION = "0.1.25"
REVISION = "v0.1.25 (21e6d2a9a581b3e11aafe711abfd37402f8482d5)"
SEED = 20261113
OUT = Path(__file__).resolve().parent / "out" / "reasoning.json"

# (dataset, difficulty overrides, items taken)
TASKS = [
    ("gsm_symbolic", {}, 4),
    ("knights_knaves", {"n_people": 3}, 3),
    ("shortest_path", {"min_rows": 5, "max_rows": 6, "min_cols": 5, "max_cols": 6}, 3),
    ("number_sequence", {"max_complexity": 3}, 3),
    ("zebra_puzzles", {"num_people": 4, "num_characteristics": 4}, 4),
    ("mini_sudoku", {"min_empty": 10, "max_empty": 12}, 3),
]


def answer_spec(task, entry):
    spec = {"task": task, "oracle": entry["answer"]}
    if task == "shortest_path":
        spec["matrix"] = entry["metadata"]["matrix"]
    if task == "mini_sudoku":
        spec["solution"] = entry["metadata"]["solution"]
    return spec


def main():
    installed = importlib.metadata.version("reasoning-gym")
    if installed != VERSION:
        sys.exit(f"reasoning-gym {installed} installed, this build is pinned to {VERSION}")
    system = SYSTEM_PROMPTS["default"]
    items, provenance = [], []
    for task, overrides, count in TASKS:
        ds = reasoning_gym.create_dataset(task, seed=SEED, size=count, **overrides)
        config = {k: v for k, v in dataclasses.asdict(ds.config).items() if k not in ("seed", "size")}
        for index in range(count):
            entry = ds[index]
            item_id = f"reasoning/{task}/{SEED}/{index}"
            items.append({
                "id": item_id,
                "bench": "reasoning",
                "category": task,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": entry["question"]}],
                "tools": None,
                "format": None,
                "max_tokens": 2048,
                "answer": answer_spec(task, entry),
            })
            provenance.append({"id": item_id, "generator": task, "config": config, "seed": SEED, "index": index})
    doc = {
        "bench": "reasoning",
        "source": {
            "name": "Reasoning Gym",
            "url": "https://github.com/open-thought/reasoning-gym",
            "revision": f"reasoning-gym=={VERSION}, tag {REVISION}",
            "license": "Apache-2.0",
            "license_url": "https://github.com/open-thought/reasoning-gym/blob/v0.1.25/LICENSE",
        },
        "selection": (
            f"Generated with reasoning-gym {VERSION}, seed {SEED}, first N indices per task: "
            + ", ".join(f"{t} x{n}" for t, _, n in TASKS)
            + "; upstream eval wrapper applied (system prompt SYSTEM_PROMPTS['default']); "
            "partial-credit scores count as a pass only at 1.0."
        ),
        "provenance": provenance,
        "items": items,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT.name}: {len(items)} items")


if __name__ == "__main__":
    main()
