"""Build scripts/suite11/out/jsonschema.json from JSONSchemaBench at a pinned Hugging Face revision.

    uv run --with pyarrow --with 'jsonschema[format]' --with pyyaml python scripts/suite11/build_jsonschema.py

Prompts follow the lm-evaluation-harness `jsonschema_bench` task at a pinned commit: its description as the
system message, its first two few-shot examples as earlier turns, and its `doc_to_text` for the question.
"""

import json
import random
import sys
import tempfile
import urllib.request
from pathlib import Path

import jsonschema
import pyarrow.parquet as pq
import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "src"))

from benchclub.engine.suite11.jsonschema import SUPPORTED  # noqa: E402

SEED = 20261113
DATASET = "epfl-dlab/JSONSchemaBench"
REVISION = "5bd0f4640badc6f3f02df796421d21cb0ca0b141"
LM_EVAL = "EleutherAI/lm-evaluation-harness"
LM_EVAL_COMMIT = "d6de81643928d653435c431bae19945d41d32520"
TASK_YAML = f"https://raw.githubusercontent.com/{LM_EVAL}/{LM_EVAL_COMMIT}/lm_eval/tasks/jsonschema_bench/jsonschema_bench_easy.yaml"
# Subset → (count, where its schemas come from).
SUBSETS = {
    "Kubernetes": (4, "instrumenta/kubernetes-json-schema (Apache-2.0), generated from the Kubernetes OpenAPI spec"),
    "JsonSchemaStore": (4, "SchemaStore/schemastore (Apache-2.0)"),
    "Github_medium": (4, "sdbs-uni-p/json-schema-corpus (Apache-2.0 collection of schemas from public GitHub repos)"),
    "Github_hard": (3, "sdbs-uni-p/json-schema-corpus (Apache-2.0 collection of schemas from public GitHub repos)"),
}
MAX_SCHEMA_CHARS = 6000

ANNOTATIONS = {"$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated",
               "readOnly", "writeOnly"}
# Draft 2020-12 keywords that assert something and that our validator does not implement. A schema using any of
# them is skipped; anything else unknown is ignored by Draft 2020-12 and by us.
UNSUPPORTED = {"format", "if", "then", "else", "dependentRequired", "dependentSchemas", "propertyNames", "contains",
               "minContains", "maxContains", "prefixItems", "unevaluatedProperties", "unevaluatedItems", "$anchor",
               "$dynamicRef", "$dynamicAnchor", "contentEncoding", "contentMediaType", "contentSchema",
               "$recursiveRef", "$recursiveAnchor", "$vocabulary"}
# Keywords from older drafts that 2020-12 ignores: skip schemas using them so nobody is surprised.
LEGACY = {"dependencies", "additionalItems"}
SCHEMA_MAPS = {"properties", "patternProperties", "definitions", "$defs"}
SCHEMA_ONE = {"items", "additionalProperties", "not"}
SCHEMA_LISTS = {"allOf", "anyOf", "oneOf"}


def walk(node, used, refs, nested_ids, top=True):
    """Collect the keywords a schema uses, its $refs and any non-root $id."""
    if isinstance(node, bool):
        return
    if not isinstance(node, dict):
        raise ValueError("non-schema value")
    for key, value in node.items():
        used.add(key)
        if key == "$ref":
            refs.append(value)
        if key == "$id" and not top:
            nested_ids.append(value)
        if key in SCHEMA_MAPS:
            for sub in value.values():
                walk(sub, used, refs, nested_ids, False)
        elif key in SCHEMA_ONE:
            if isinstance(value, list):
                used.add("items-array")
            else:
                walk(value, used, refs, nested_ids, False)
        elif key in SCHEMA_LISTS:
            for sub in value:
                walk(sub, used, refs, nested_ids, False)


def resolves(schema, ref):
    if not ref.startswith("#"):
        return False
    node = schema
    try:
        for token in [t for t in ref[1:].split("/") if t]:
            node = node[token.replace("~1", "/").replace("~0", "~")]
    except (KeyError, TypeError):
        return False
    return isinstance(node, (dict, bool))


def eligible(schema):
    """Keywords used (assertion keywords only) if we can grade this schema exactly, else None."""
    if not isinstance(schema, dict) or not schema.get("required"):
        return None
    try:
        jsonschema.Draft202012Validator.check_schema(schema)
    except jsonschema.SchemaError:
        return None
    used, refs, nested_ids = set(), [], []
    try:
        walk(schema, used, refs, nested_ids)
    except (ValueError, AttributeError, TypeError):
        return None
    if used & (UNSUPPORTED | LEGACY) or "items-array" in used or nested_ids:
        return None
    if not all(resolves(schema, r) for r in refs):
        return None
    return sorted(k for k in used if k in SUPPORTED)


def fetch(url, dest):
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, dest)
    return dest


class _Loader(yaml.SafeLoader):
    pass


_Loader.add_constructor("!function", lambda loader, node: loader.construct_scalar(node))


def prompt_template(cache):
    task = yaml.load(fetch(TASK_YAML, cache / "jsonschema_bench_easy.yaml").read_text(), Loader=_Loader)
    assert task["fewshot_config"]["sampler"] == "first_n"
    shots = task["fewshot_config"]["samples"][: task["num_fewshot"]]
    return task["description"], task["doc_to_text"], shots


def render(doc_to_text, schema_text):
    return doc_to_text.replace("{{json_schema}}", schema_text)


def main():
    cache = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / "benchclub-suite11-jsonschema"
    description, doc_to_text, shots = prompt_template(cache)
    rng = random.Random(SEED)
    items, keywords = [], set()
    for subset, (count, provenance) in SUBSETS.items():
        url = f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/{subset}/test-00000-of-00001.parquet"
        rows = pq.read_table(fetch(url, cache / subset / "test.parquet")).to_pylist()
        pool = []
        for row in sorted(rows, key=lambda r: r["unique_id"]):
            if len(row["json_schema"]) > MAX_SCHEMA_CHARS:
                continue
            used = eligible(json.loads(row["json_schema"]))
            if used is not None:
                pool.append((row, used))
        for row, used in rng.sample(pool, count):
            keywords.update(used)
            messages = [{"role": "system", "content": description}]
            for shot in shots:
                messages.append({"role": "user", "content": render(doc_to_text, shot["json_schema"])})
                messages.append({"role": "assistant", "content": shot["json_object"]})
            messages.append({"role": "user", "content": render(doc_to_text, row["json_schema"])})
            items.append({
                "id": f"jsonschema/{subset}/{row['unique_id']}",
                "bench": "jsonschema",
                "category": subset,
                "messages": messages,
                "tools": None,
                "format": None,
                "max_tokens": 2048,
                "answer": {"schema": json.loads(row["json_schema"])},
            })
    out = {
        "bench": "jsonschema",
        "source": {
            "name": "JSONSchemaBench",
            "url": f"https://huggingface.co/datasets/{DATASET}",
            "revision": REVISION,
            "license": "MIT",
            "license_url": f"https://huggingface.co/datasets/{DATASET}/blob/{REVISION}/README.md",
            "prompt": f"https://github.com/{LM_EVAL}/blob/{LM_EVAL_COMMIT}/lm_eval/tasks/jsonschema_bench",
            "subsets": {name: provenance for name, (_, provenance) in SUBSETS.items()},
            "keywords": sorted(keywords),
        },
        "selection": (
            f"Test split; per subset ({', '.join(f'{n} {c}' for n, (c, _) in SUBSETS.items())}) a seeded sample "
            f"(seed {SEED}) of schemas that pass Draft 2020-12 check_schema, have a top-level `required`, are at "
            f"most {MAX_SCHEMA_CHARS} characters, use only local $refs and only keywords our validator implements "
            "(no `format`); prompt is lm-evaluation-harness jsonschema_bench verbatim (description as system, "
            "2 few-shot turns, doc_to_text with its literal \\n), graded with Draft 2020-12."
        ),
        "items": items,
    }
    dest = HERE / "out" / "jsonschema.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"wrote {len(items)} items to {dest}; keywords: {', '.join(sorted(keywords))}")


if __name__ == "__main__":
    main()
