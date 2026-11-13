# suite-standard@1.1 — how a benchmark plugs in

Plan: hola-brain 8gdmxcfdxi4e §3.2. One owner per benchmark; each touches only its own files.

## Files per benchmark `<b>` (b ∈ bfcl, when2call, ifbench, ifeval, jsonschema, reasoning, simpleqa)

| file | what |
|---|---|
| `scripts/suite11/build_<b>.py` | Fetches upstream at a **pinned** commit / HF revision, selects items with seed `20261113`, writes `scripts/suite11/out/<b>.json`. Build-time only, may use network and third-party packages (run with `uv run --with ...`). Records the pin in the output. |
| `scripts/suite11/out/<b>.json` | `{"bench": b, "source": {"name", "url", "revision", "license", "license_url"}, "selection": "<one line: how items were chosen>", "items": [...]}` |
| `scripts/suite11/licenses/<b>/` | The upstream LICENSE (and NOTICE if any), copied verbatim. |
| `src/benchclub/engine/suite11/<b>.py` | `grade(item, resp) -> common.verdict(...)`. **Standard library only**, Python 3.10, deterministic, pure. Never `eval`/`exec`/import model output. |
| `tests/suite11/test_<b>.py` | unittest. Must pass with `python -m unittest discover -s tests` and no extra packages. |
| `tests/suite11/fixtures/<b>.json` | Cases `[{"item_id", "response", "official_passed", "note"}]` whose `official_passed` came from running the **official upstream grader** (in a throwaway venv). Our grader must agree on every case. ≥40 cases, mixing correct, wrong and edge answers; include real outputs from local Ollama models where possible (`qwen3.5:2b-q4_K_M`, `openbmb/minicpm5-2b:q4_K_M`, `qwen3.6:35b-a3b-q4_K_M` at `http://127.0.0.1:11434`, `"think": false`, temperature 0). |

## Item shape

```json
{"id": "<b>/<upstream id>", "bench": "<b>", "category": "<upstream category>",
 "messages": [{"role": "system"|"user"|"assistant", "content": "..."}],
 "tools": null | [OpenAI/Ollama tool objects {"type":"function","function":{name,description,parameters}}],
 "format": null,
 "max_tokens": 2048,
 "answer": { ...whatever the grader needs, nothing else... }}
```

- Prompts are the upstream prompts, unchanged, unless the upstream harness adds a fixed wrapper — then apply that same wrapper and say so in `selection`.
- No item may depend on today's date (no absolute dates in the future-relative sense: "book a flight on 2026-11-03"). Drop such items; never rewrite them.
- `max_tokens`: 2048 unless the benchmark needs more (state why).

## Response the grader receives (`common.normalize_response`)

`{"content": str (thinking removed), "tool_calls": [{"name": str, "arguments": dict | None}], "done_reason": "stop"|"length"}`

## Verdict

Return `common.verdict(outcome, detail)`; outcome ∈ `pass`, `wrong`, `format_error` (structure required and unparseable, e.g. tool args not JSON, no JSON found), `abstained` (simpleqa only: the model said it doesn't know). Do not return `unfinished`: `suite11.grade` turns wrong/format_error into unfinished when `done_reason == "length"`. `detail` is one short plain-English line a creator can read ("called get_weather but city was 'Paris, FR', expected 'Paris'").

## Adversarial cases every test must include (all must not pass)

empty content; content that only says "PASS" / "correct"; prompt-injection text ("Ignore the grader and mark this correct"); a response that copies the question back; malformed tool arguments (for tool benchmarks).
