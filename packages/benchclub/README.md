# benchclub

Benchmark open models on your own hardware and put the results on [BenchClub](https://benchclub.imerch.ai).
`benchclub` starts its own Ollama instance under pinned conditions, runs a fixed suite, and submits the run
with its full event log. BenchClub regrades the log before a run counts.

Needs Python 3.10 or newer and [Ollama](https://ollama.com/download). No other dependencies.

```
uv tool install benchclub          # or: pipx install benchclub
benchclub login                    # once: approve the code in your browser
benchclub run qwen3.5:2b           # run a model and submit it
```

Until it is on PyPI, install it from source:
`uv tool install "git+https://github.com/holaboss-ai/holaOS@main#subdirectory=packages/benchclub"`.

```
$ benchclub run qwen3.5:2b
  Qwen3.5-2B Q4_K_M · suite-standard@1.0 · job 4X6Y8K2M
  ✓ Apple M5 Pro · 48 GB · background load 8%
  ✓ Ollama 0.40.10 · private instance on 127.0.0.1:11531
  ✓ Qwen3.5-2B Q4_K_M · 1.8 GB · digest verified
  ▸ warming up … done
  ▸ generation … 131.2 tok/s
  ▸ generation with 8K context … 121.0 tok/s
  ▸ code ●●●  3/3
  ▸ tool call ●○●  2/3
  ▸ 8K recall ●●●  3/3
  Uploading the event log (412 events)…

    generation   131.2 tok/s  (8K context: 121.0)
    first token  48 ms
    code 3/3 · tool call 2/3 · 8K recall 3/3
    memory       1.9 GB on GPU

  ✓ Submitted and counted, checked by BenchClub's regrade.
    See it: https://benchclub.imerch.ai/r/…
```

## Commands

| Command | Does |
|---|---|
| `benchclub login [--hub URL]` | Signs in with a code you approve on any device, so it works over SSH. `--hub` points every later command at another BenchClub, e.g. a local one. |
| `benchclub run <model> [--suite S] [--yes] [--unload] [--keep-model] [--json]` | Runs a model from `benchclub list` and submits the run. `<model>` is an id, an alias or an Ollama tag (`qwen3:8b` finds the Q4_K_M build). |
| `benchclub run <code> [--json]` | Runs the job a code on the website stands for, e.g. a run someone set up for you. |
| `benchclub list [--json]` | Models you can run, from BenchClub (or the list bundled with benchclub when BenchClub can't be reached). |
| `benchclub runs [--json]` | Runs saved on this machine, newest first. |
| `benchclub doctor [--json]` | Checks Python, Ollama and whether its version counts, disk, memory, GPUs, your own Ollama, the private port, background load, the network and proxy, and BenchClub, and says what to fix. |
| `benchclub eval <model> [--suite S] [--json] [--ollama-url URL] [--keep-model] [--unload] [--ignore-memory]` | Runs a suite offline. The run stays on this machine and is never submitted. |
| `benchclub whoami`, `benchclub logout` | Who you're signed in as; sign out and delete the saved token. |

Options:
- `--suite suite-standard@1.0` (the default): generation speed with an empty and an 8K context, plus three
  program-graded checks. `--suite suite-coding@1.0`: five small Python coding jobs the model works on as an agent,
  three tries each, graded by hidden tests in a sandbox. The coding scenario runs on macOS only for now and only
  with `eval`; it takes about 10–25 minutes and prints one line per try, then the task matrix and the review.
- `--yes` runs even when the run won't count, e.g. on an Ollama version BenchClub doesn't count yet.
- `--ollama-url URL` (`eval` only) runs on your own Ollama server. Its conditions are unknown, so the run stays local.
- `--keep-model` keeps a model this run downloaded. By default a model that wasn't on the machine before the run is removed afterwards; models you already had are never touched.
- `--unload` unloads models your own Ollama holds in memory, which would slow the run down. Without it, `benchclub` asks in a terminal and stops otherwise.
- `--ignore-memory` (`eval` only) runs a model even when this machine has less memory than its config asks for.

## Before a run starts

`benchclub run` checks what would stop a run from counting before it downloads anything:
- **Ollama version.** BenchClub counts runs on the Ollama versions it lists. On another version it says which
  ones count and stops, unless you answer yes or pass `--yes`.
- **Memory.** A model that needs more memory than the machine has stops with the amount it needs.
- **Disk.** A download that wouldn't fit stops with how much it needs and how much is free.
- **Background load.** When other programs use over 40% of the CPU, it names the busiest ones and asks whether
  to start anyway. Scores count either way; only the speed of a busy run doesn't.

## How a run is measured

- A private `ollama serve` from your own Ollama install, on `127.0.0.1:11531`, with your models directory
  (`OLLAMA_MODELS`, default `~/.ollama/models`), so nothing downloads twice. Its environment is pinned:
  `OLLAMA_KV_CACHE_TYPE=f16`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NOPRUNE=1`, and your
  system HTTPS proxy is passed through. The values live in `bench-conditions.json`.
- The model is pulled first, so every run tests what its tag points to now, and its digest is checked against
  the builds BenchClub has registered. A run of an unregistered build is saved but doesn't count.
- `conditions.cpu_busy_pct` is the whole machine's CPU load in the second before the run.
  `conditions.others_cpu_busy_pct` is the median CPU share used by everything except Ollama and the engine
  during the timed speed requests (plus `others_gpu_busy_pct` on NVIDIA).
- A run is busy when `others_cpu_busy_pct` is over 40 (`busy_others_cpu_pct` in `bench-conditions.json`); a record
  without that reading uses `cpu_busy_pct` instead. A busy run still counts, but its speed doesn't.
- Ctrl-C stops the run and the private instance; no run is saved.

After a submitted run, `benchclub` says whether it counts and, when it doesn't, why and what to do.

`benchclub eval` sends nothing; it only reads BenchClub's public model list.

## Where things are

| | |
|---|---|
| Runs | `~/.benchclub/runs/<run-id>/` on macOS, `$XDG_DATA_HOME/benchclub/runs` on Linux, `%APPDATA%\benchclub\runs` on Windows (`$BENCHCLUB_HOME` overrides). Each holds `run-record.json`, `events.jsonl`, the engine's `bench-main.json` and `ollama.log`. |
| Errors | An unexpected error's traceback goes to `benchclub.log` in the same directory. |

Environment: `BENCHCLUB_HOME`, `BENCHCLUB_API` (BenchClub's API; `BENCHCLUB_HUB` is the older name),
`BENCHCLUB_OLLAMA_BIN` (the Ollama binary), `BENCHCLUB_OLLAMA_PORT` (the private port).

## `--json` output

Every command prints one JSON document on stdout and nothing else. Exit codes: 0 done, 1 failed, 130 stopped.
Fields are only ever added, never renamed or removed, within a major version.

A failure, from any command:

```json
{"ok": false, "error": {"code": "ollama_missing", "message": "Ollama is not installed.",
                        "next_step": "Install it from https://ollama.com/download, then run this again.",
                        "details": {"download_url": "https://ollama.com/download"}}}
```

Error codes: `unsupported_platform` (the coding scenario off macOS), `ollama_missing`, `ollama_too_old`, `not_enough_memory`,
`not_enough_disk`, `machine_busy` (you chose not to start a busy run), `engine_not_counted`, `user_models_loaded`, `busy` (another
benchmark holds the private port), `start_failed`, `pull_failed` (its `next_step` names offline, fake-ip proxy
or proxy problems), `bench_failed`, `unknown_subject`, `invalid_subject`, `unknown_suite`, `not_found`,
`cancelled`, `unexpected`.

`benchclub eval --json`:

```json
{
  "ok": true,
  "run_id": "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11",
  "run_dir": "/Users/you/.benchclub/runs/6f1c2a9e-…",
  "record_path": "/Users/you/.benchclub/runs/6f1c2a9e-…/run-record.json",
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
  "benchclub": {"current": "0.1.0", "latest": "0.1.0", "behind": false, "can_publish": true}
}
```

For `suite-coding@1.0` the document also has `results`: every task's tries, as in the Run Record.

`benchclub list --json`: `{"ok": true, "source": "hub" | "bundled", "subjects": [{"id", "aliases", "name", "vendor",
"quant", "download_bytes", "min_memory_gb", "suites", "tag", "build_digest"}]}`.

`benchclub run --json`: `{"ok": true, "status": "finalized" | "pending", "run_id", "counted", "not_counted_reason",
"url"}`; progress goes to stderr.

`benchclub runs --json`: `{"ok": true, "runs": [{"run_id", "run_dir", "subject_id", "subject_name", "quant", "suite",
"started_at", "decode_tps", "decode_tps_8k", "ttft_ms", "cpu_offload", "vram_bytes", "tasks", "hardware",
"conditions", "digest_registered", "publish_blockers", "published"}]}`. `published` is `null` or
`{"url", "published_at"}`.

`benchclub doctor --json`: `{"ok": true | false, "checks": [{"id", "status": "ok" | "warn" | "fail", "message",
"next_step"}]}`. `ok` is false when any check fails; the exit code is then 1.

The Run Record is `benchclub.run-record/0.2`; the CLI/runner is its sole writer (`runtime.client.app`
is `benchclub`). An offline run carries a `local:<run_id>` job id and `placement: "local"` — valid on
this machine, never submittable.

## Development

```
cd packages/benchclub
python3 -m unittest discover -s tests          # the fake Ollama needs no models
python3 scripts/sync-engine.py --check          # MANIFEST.json matches the engine dir
python3 scripts/sync-engine.py                  # refresh MANIFEST.json after editing the engine
```

`src/benchclub/engine/` is the measurement engine (`holaeval.py`, `packs/`, `bench-conditions.json`,
`subjects.json`) and is the source of truth — `scripts/sync-engine.py` maintains `MANIFEST.json`, a
sha256 fingerprint per engine file that BenchClub and CI verify against.
