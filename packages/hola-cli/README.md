# hola

Run holaOS's local-model benchmark from a terminal. `hola` starts its own Ollama instance under the
same pinned conditions as the holaOS desktop app, runs the same engine (`holaeval.py`) and packs, and
writes the same Run Record, so a run from either one means the same thing.

Needs Python 3.10 or newer and [Ollama](https://ollama.com/download). No other dependencies.

```
uvx hola-cli eval minicpm5-2b                 # run once without installing
pipx install hola-cli && hola eval minicpm5-2b
uvx --from "git+https://github.com/holaboss-ai/holaOS@main#subdirectory=packages/hola-cli" hola eval minicpm5-2b
```

The distribution is `hola-cli`; it installs the command as both `hola` and `hola-cli`.

```
$ hola eval minicpm5-2b
  ✓ Apple M5 Pro · 48 GB · background load 8%
  ✓ Ollama 0.40.10 · private instance on 127.0.0.1:11531
  ✓ MiniCPM5-2B Q4_K_M · 1.5 GB · digest verified
  ▸ warming up … done
  ▸ generation … 102.3 tok/s
  ▸ generation with 8K context … 97.1 tok/s
  ▸ code ●●○  2/3
  ▸ tool call ○○○  0/3
  ▸ 8K recall ●●●  3/3

    generation   102.3 tok/s  (8K context: 97.1)
    first token  62 ms
    code 2/3 · tool call 0/3 · 8K recall 3/3
    memory       1.4 GB on GPU

  Saved ~/.hola/runs/6f1c2a9e-…/run-record.json
```

## Commands

| Command | Does |
|---|---|
| `hola eval <model> [--suite S] [--json] [--ollama-url URL] [--keep-model] [--unload] [--ignore-memory]` | Runs a suite on one model and saves the run. `<model>` is an id, an alias or an Ollama tag from `hola list`. |
| `hola list [--json]` | Models you can test, from HolaHub (or the list bundled with hola when HolaHub can't be reached). |
| `hola runs [--json]` | Runs saved on this machine, newest first. |
| `hola doctor [--json]` | Checks Python, Ollama, disk, memory, GPUs, your own Ollama, the private port, background load, the network and proxy, and HolaHub, and says what to fix. |

`hola eval` options:
- `--suite suite-standard@1.0` (the default): generation speed with an empty and an 8K context, plus three
  program-graded checks. `--suite suite-coding@1.0`: five small Python coding jobs the model works on as an agent,
  three tries each, graded by hidden tests in a sandbox. The coding scenario runs on macOS only for now; it takes
  about 10–25 minutes and prints one line per try, then the task matrix and the generated review.
- `--ollama-url URL` runs on your own Ollama server. Its conditions are unknown, so the run stays local.
- `--keep-model` keeps a model this run downloaded. By default a model that wasn't on the machine before the run is removed afterwards; models you already had are never touched.
- `--unload` unloads models your own Ollama holds in memory, which would slow the run down. Without it, `hola` asks in a terminal and stops otherwise.
- `--ignore-memory` runs a model even when this machine has less memory than its config asks for.

## How a run is measured

- A private `ollama serve` from your own Ollama install, on `127.0.0.1:11531`, with your models directory
  (`OLLAMA_MODELS`, default `~/.ollama/models`), so nothing downloads twice. Its environment is pinned:
  `OLLAMA_KV_CACHE_TYPE=f16`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NOPRUNE=1`, and your
  system HTTPS proxy is passed through. The values live in `bench-conditions.json`, shared with the desktop.
- The model is pulled first, so every run tests what its tag points to now, and its digest is checked against
  the builds HolaHub has registered. An unregistered build still runs but stays local.
- `conditions.cpu_busy_pct` is the whole machine's CPU load in the second before the run, as on the desktop.
  `conditions.others_cpu_busy_pct` is the median CPU share used by everything except Ollama and the engine
  during the timed speed requests (plus `others_gpu_busy_pct` on NVIDIA).
- A run is busy when `others_cpu_busy_pct` is over 40 (`busy_others_cpu_pct` in `bench-conditions.json`); a record
  without that reading uses `cpu_busy_pct` instead. A busy run's card doesn't count in HolaHub's charts, and
  `hola eval` says so after the run.
- Ctrl-C stops the run and the private instance; no run is saved.

Nothing leaves the machine except reads of HolaHub's public model list and version policy.

## Where things are

| | |
|---|---|
| Runs | `~/.hola/runs/<run-id>/` on macOS, `$XDG_DATA_HOME/hola/runs` on Linux, `%APPDATA%\hola\runs` on Windows (`$HOLA_HOME` overrides). Each holds `run-record.json`, `events.jsonl`, the engine's `bench-main.json` and `ollama.log`. |
| Errors | An unexpected error's traceback goes to `hola.log` in the same directory. |

Environment: `HOLA_HOME`, `HOLA_HUB` and `HOLA_API` (HolaHub's site and API), `HOLA_OLLAMA_BIN` (the Ollama
binary), `HOLA_OLLAMA_PORT` (the private port).

## `--json` output

Every command prints one JSON document on stdout and nothing else. Exit codes: 0 done, 1 failed, 130 stopped.
Fields are only ever added, never renamed or removed, within a major version.

A failure, from any command:

```json
{"ok": false, "error": {"code": "ollama_missing", "message": "Ollama is not installed.",
                        "next_step": "Install it from https://ollama.com/download, then run this again.",
                        "details": {"download_url": "https://ollama.com/download"}}}
```

Error codes: `unsupported_platform` (the coding scenario off macOS), `ollama_missing`, `ollama_too_old`, `not_enough_memory`, `user_models_loaded`, `busy` (another
benchmark holds the private port), `start_failed`, `pull_failed` (its `next_step` names offline, fake-ip proxy
or proxy problems), `bench_failed`, `unknown_subject`, `invalid_subject`, `unknown_suite`, `not_found`,
`cancelled`, `unexpected`.

`hola eval --json`:

```json
{
  "ok": true,
  "run_id": "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11",
  "run_dir": "/Users/you/.hola/runs/6f1c2a9e-…",
  "record_path": "/Users/you/.hola/runs/6f1c2a9e-…/run-record.json",
  "suite": "suite-standard@1.0",
  "subject": {"id": "openbmb-minicpm5-2b", "name": "MiniCPM5-2B", "quant": "Q4_K_M",
              "tag": "openbmb/minicpm5-2b:q4_K_M", "digest": "71a44e98…", "digest_registered": true},
  "summary": {"decode_tps": 102.3, "decode_tps_8k": 97.1, "ttft_ms": 62, "cpu_offload": false,
              "vram_bytes": 1503238553,
              "tasks": {"code-intervals": {"status": "ok", "passed": 2, "samples": 3},
                        "tool-flight": {"status": "unsupported", "passed": 0, "samples": 0},
                        "needle-8k": {"status": "ok", "passed": 3, "samples": 3}}},
  "conditions": {"cpu_busy_pct": 8, "others_cpu_busy_pct": 2.5},
  "publishable": true,
  "publish_blockers": [],
  "config_source": "hub",
  "hola": {"current": "0.1.0", "latest": "0.1.0", "behind": false, "can_publish": true}
}
```

For `suite-coding@1.0` the document also has `results`: every task's tries, as in the Run Record.

`hola list --json`: `{"ok": true, "source": "hub" | "bundled", "subjects": [{"id", "aliases", "name", "vendor",
"quant", "download_bytes", "min_memory_gb", "suites"}]}`.

`hola runs --json`: `{"ok": true, "runs": [{"run_id", "run_dir", "subject_id", "subject_name", "quant", "suite",
"started_at", "decode_tps", "decode_tps_8k", "ttft_ms", "cpu_offload", "vram_bytes", "tasks", "hardware",
"conditions", "digest_registered", "publish_blockers", "published"}]}`. `published` is `null` or
`{"url", "published_at"}`.

`hola doctor --json`: `{"ok": true | false, "checks": [{"id", "status": "ok" | "warn" | "fail", "message",
"next_step"}]}`. `ok` is false when any check fails; the exit code is then 1.

The Run Record itself is `hola.run-record/0.1`, the same schema the desktop writes; only `runtime.client` differs
(`{"app": "hola-cli", "version"}`).

## Development

```
cd packages/hola-cli
python3 -m unittest discover -s tests          # the fake Ollama needs no models
python3 scripts/sync-engine.py --check          # the engine copy matches the desktop's
python3 scripts/sync-engine.py                  # after holaeval.py, packs/ or bundled subjects change
```

`src/hola/engine/` is a copy, never edited by hand: `holaeval.py` and `packs/` from
`runtime/api-server/src/embedded-capabilities/local-model-review/skills/run-model-eval/`,
`bench-conditions.json` from `runtime/api-server/src/`, and `subjects.json` from
`apps/desktop/shared/bench-subjects.ts`.
