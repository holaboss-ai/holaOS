"""JSONSchemaBench: the model writes a JSON object for a schema; it passes when the object validates.

Validation follows JSON Schema Draft 2020-12, which is what the upstream grader (lm-evaluation-harness,
jsonschema.Draft202012Validator) uses whatever draft a schema declares. Only the keywords in SUPPORTED are
implemented; every item was chosen so its schema uses nothing else (the tests check this). Keywords that
Draft 2020-12 does not define are ignored, as the upstream validator ignores them.
"""

import json
import math
import re
from fractions import Fraction
from urllib.parse import unquote

from .common import FORMAT_ERROR, PASS, WRONG, verdict

SUPPORTED = frozenset({
    "$ref", "$defs", "definitions", "type", "enum", "const", "properties", "required", "additionalProperties",
    "patternProperties", "minProperties", "maxProperties", "items", "minItems", "maxItems", "uniqueItems",
    "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "multipleOf", "allOf", "anyOf", "oneOf", "not",
})

_FENCE = re.compile(r"```[ \t]*(json|JSON)?[ \t]*\n(.*?)```", re.DOTALL)
_MAX_DEPTH = 200


def _reject_constant(name):
    raise ValueError(f"{name} is not JSON")


def _loads(text):
    try:
        return True, json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return False, None


def extract_json(content):
    """The JSON value in a response: the whole content, or the one ```json (or bare ```) fenced block."""
    text = content.strip()
    if not text:
        return False, None, "the response is empty"
    ok, value = _loads(text)
    if ok:
        return True, value, ""
    blocks = [m.group(2) for m in _FENCE.finditer(text)]
    if len(blocks) > 1:
        return False, None, f"found {len(blocks)} fenced code blocks, expected one JSON object"
    if blocks:
        ok, value = _loads(blocks[0].strip())
        if ok:
            return True, value, ""
        return False, None, "the fenced code block is not valid JSON"
    return False, None, "no JSON found: the reply is neither JSON nor a ```json block"


def _equal(a, b):
    if isinstance(a, str) or isinstance(b, str):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_equal(a[k], b[k]) for k in a)
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (list, dict)) or isinstance(b, (list, dict)):
        return False
    return a == b


def _is_number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _is_type(x, name):
    if name == "object":
        return isinstance(x, dict)
    if name == "array":
        return isinstance(x, list)
    if name == "string":
        return isinstance(x, str)
    if name == "boolean":
        return isinstance(x, bool)
    if name == "null":
        return x is None
    if name == "number":
        return _is_number(x)
    if name == "integer":
        return _is_number(x) and (isinstance(x, int) or x.is_integer())
    return False


def _type_name(x):
    for name in ("null", "boolean", "integer", "number", "string", "array", "object"):
        if _is_type(x, name):
            return name
    return type(x).__name__


def _show(value, limit=40):
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _where(path):
    out = "$"
    for part in path:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out


def _not_multiple(x, d):
    if isinstance(d, float):
        quotient = x / d
        try:
            return int(quotient) != quotient
        except OverflowError:
            return (Fraction(x) / Fraction(d)).denominator != 1
    return bool(x % d)


class _Validator:
    def __init__(self, root):
        self.root = root

    def resolve(self, ref):
        if not ref.startswith("#"):
            raise ValueError(f"unsupported $ref {ref!r}")
        node = self.root
        pointer = unquote(ref[1:])
        if pointer:
            for token in pointer.lstrip("/").split("/"):
                token = token.replace("~1", "/").replace("~0", "~")
                node = node[int(token)] if isinstance(node, list) else node[token]
        return node

    def first_error(self, schema, x, path=(), depth=0):
        """The first violation as (path, message), or None when x is valid."""
        if depth > _MAX_DEPTH:
            return path, "the schema nests too deeply to check"
        if schema is True:
            return None
        if schema is False:
            return path, "no value is allowed here"
        for key in schema:
            check = _CHECKS.get(key)
            if check is None:
                continue
            err = check(self, schema[key], schema, x, path, depth)
            if err:
                return err
        return None

    def valid(self, schema, x, depth):
        return self.first_error(schema, x, (), depth + 1) is None


def _ref(v, ref, schema, x, path, depth):
    return v.first_error(v.resolve(ref), x, path, depth + 1)


def _type(v, types, schema, x, path, depth):
    names = [types] if isinstance(types, str) else types
    if not any(_is_type(x, t) for t in names):
        return path, f"expected {' or '.join(names)}, got {_type_name(x)} {_show(x)}"
    return None


def _enum(v, options, schema, x, path, depth):
    if not any(_equal(x, o) for o in options):
        return path, f"{_show(x)} is not one of {_show(options, 60)}"
    return None


def _const(v, const, schema, x, path, depth):
    if not _equal(x, const):
        return path, f"expected {_show(const)}, got {_show(x)}"
    return None


def _properties(v, props, schema, x, path, depth):
    if isinstance(x, dict):
        for name, sub in props.items():
            if name in x:
                err = v.first_error(sub, x[name], path + (name,), depth + 1)
                if err:
                    return err
    return None


def _pattern_properties(v, patterns, schema, x, path, depth):
    if isinstance(x, dict):
        for pattern, sub in patterns.items():
            for name, value in x.items():
                if re.search(pattern, name):
                    err = v.first_error(sub, value, path + (name,), depth + 1)
                    if err:
                        return err
    return None


def _additional_properties(v, extra_schema, schema, x, path, depth):
    if not isinstance(x, dict):
        return None
    props = schema.get("properties", {})
    patterns = "|".join(schema.get("patternProperties", {}))
    for name, value in x.items():
        if name in props or (patterns and re.search(patterns, name)):
            continue
        if extra_schema is False:
            return path, f"property '{name}' is not allowed"
        err = v.first_error(extra_schema, value, path + (name,), depth + 1)
        if err:
            return err
    return None


def _required(v, names, schema, x, path, depth):
    if isinstance(x, dict):
        for name in names:
            if name not in x:
                return path, f"missing required property '{name}'"
    return None


def _min_properties(v, n, schema, x, path, depth):
    if isinstance(x, dict) and len(x) < n:
        return path, f"has {len(x)} properties, needs at least {n}"
    return None


def _max_properties(v, n, schema, x, path, depth):
    if isinstance(x, dict) and len(x) > n:
        return path, f"has {len(x)} properties, allows at most {n}"
    return None


def _items(v, sub, schema, x, path, depth):
    if isinstance(x, list):
        for i, item in enumerate(x):
            err = v.first_error(sub, item, path + (i,), depth + 1)
            if err:
                return err
    return None


def _min_items(v, n, schema, x, path, depth):
    if isinstance(x, list) and len(x) < n:
        return path, f"has {len(x)} items, needs at least {n}"
    return None


def _max_items(v, n, schema, x, path, depth):
    if isinstance(x, list) and len(x) > n:
        return path, f"has {len(x)} items, allows at most {n}"
    return None


def _unique_items(v, unique, schema, x, path, depth):
    if unique and isinstance(x, list):
        for i, a in enumerate(x):
            for b in x[i + 1:]:
                if _equal(a, b):
                    return path, f"items must be unique, {_show(a)} repeats"
    return None


def _min_length(v, n, schema, x, path, depth):
    if isinstance(x, str) and len(x) < n:
        return path, f"string {_show(x)} is shorter than {n} characters"
    return None


def _max_length(v, n, schema, x, path, depth):
    if isinstance(x, str) and len(x) > n:
        return path, f"string {_show(x)} is longer than {n} characters"
    return None


def _pattern(v, pattern, schema, x, path, depth):
    if isinstance(x, str) and not re.search(pattern, x):
        return path, f"string {_show(x)} does not match {pattern}"
    return None


def _bound(op, words):
    def check(v, limit, schema, x, path, depth):
        if _is_number(x) and not op(x, limit):
            return path, f"{_show(x)} {words} {_show(limit)}"
        return None
    return check


def _multiple_of(v, d, schema, x, path, depth):
    if _is_number(x) and _not_multiple(x, d):
        return path, f"{_show(x)} is not a multiple of {_show(d)}"
    return None


def _all_of(v, subs, schema, x, path, depth):
    for sub in subs:
        err = v.first_error(sub, x, path, depth + 1)
        if err:
            return err
    return None


def _any_of(v, subs, schema, x, path, depth):
    if not any(v.valid(sub, x, depth) for sub in subs):
        return path, f"{_show(x)} matches none of the anyOf options"
    return None


def _one_of(v, subs, schema, x, path, depth):
    matches = sum(1 for sub in subs if v.valid(sub, x, depth))
    if matches == 0:
        return path, f"{_show(x)} matches none of the oneOf options"
    if matches > 1:
        return path, f"{_show(x)} matches {matches} oneOf options, expected exactly one"
    return None


def _not(v, sub, schema, x, path, depth):
    if v.valid(sub, x, depth):
        return path, f"{_show(x)} matches a schema it must not match"
    return None


_CHECKS = {
    "$ref": _ref,
    "type": _type,
    "enum": _enum,
    "const": _const,
    "required": _required,
    "properties": _properties,
    "patternProperties": _pattern_properties,
    "additionalProperties": _additional_properties,
    "minProperties": _min_properties,
    "maxProperties": _max_properties,
    "items": _items,
    "minItems": _min_items,
    "maxItems": _max_items,
    "uniqueItems": _unique_items,
    "minLength": _min_length,
    "maxLength": _max_length,
    "pattern": _pattern,
    "minimum": _bound(lambda x, m: x >= m, "is less than the minimum"),
    "maximum": _bound(lambda x, m: x <= m, "is more than the maximum"),
    "exclusiveMinimum": _bound(lambda x, m: x > m, "must be more than"),
    "exclusiveMaximum": _bound(lambda x, m: x < m, "must be less than"),
    "multipleOf": _multiple_of,
    "allOf": _all_of,
    "anyOf": _any_of,
    "oneOf": _one_of,
    "not": _not,
}


def validate(schema, instance):
    """First violation as one readable line, or None when instance is valid under Draft 2020-12."""
    err = _Validator(schema).first_error(schema, instance)
    if err is None:
        return None
    path, message = err
    return f"at {_where(path)}: {message}"


def grade(item, resp):
    found, value, why = extract_json(resp["content"])
    if not found:
        return verdict(FORMAT_ERROR, why)
    if isinstance(value, float) and not math.isfinite(value):
        return verdict(FORMAT_ERROR, "no JSON found")
    problem = validate(item["answer"]["schema"], value)
    if problem:
        return verdict(WRONG, problem)
    return verdict(PASS, "the JSON matches the schema")
