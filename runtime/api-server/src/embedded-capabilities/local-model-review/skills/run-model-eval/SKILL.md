---
name: run-model-eval
description: Test a local model server that is already running (Ollama, LM Studio, llama.cpp, MLX, vLLM, SGLang) for speed and practical capability, and dig into anything that looks off.
---

# Run a Local Model Eval

Use this when the user wants to test, benchmark, or compare a model running on their own machine or LAN ("测一下我本地的模型", "how fast is my LM Studio model", "Q4 vs Q8").

The tool is `holaeval.py` in this skill's directory (`skills/run-model-eval/holaeval.py` from the workspace root). It needs only the Python that ships with holaOS. Run `python3 skills/run-model-eval/holaeval.py selftest` once if unsure the install is intact.

holaOS does not install engines or download models. If nothing is running, tell the user what to start and wait for them.

## 1. Find the target

1. Call `local_models_discover` (pass `base_url` if the user named an address). It lists servers on the usual ports with their models and context windows.
2. If several models are listed and the user did not say which, ask once with `ask_user_question`.
3. Pick a run directory: `outputs/model-evals/<YYYY-MM-DD>-<model-slug>/`. Everything for this eval goes there.

## 2. Probe

```bash
python3 skills/run-model-eval/holaeval.py probe --base-url <url> --model <id> --out <run_dir>
```

Read the result before testing anything:

- `smoke.ok` must be true. If not, report the error; do not continue.
- `context_window`: Ollama often serves with a small default context (check `loaded[].context_length`). Tasks that need more context are skipped automatically; tell the user how to raise it (for example `OLLAMA_CONTEXT_LENGTH`) if long-context results matter to them.
- `server_defaults`: the server's own sampling defaults. They do not affect this eval (holaeval always sends explicit sampling), but if they conflict with the model's official recommendation, note it for the report: users who chat with the server directly will hit it.
- Identity keywords: decide what the model should call itself, from its name or model card (for example `MiniCPM,OpenBMB,ModelBest,面壁` or `Qwen,Alibaba,通义`). Pass them as `--identity`; without them the identity tasks are skipped.
- Sampling: use the model card's recommended settings when known (`--temperature`, `--top-p`, `--min-p`); otherwise the pack default (temperature 1.0, top_p 0.95, min_p 0) applies. Record which you used.

## 3. Speed

```bash
python3 skills/run-model-eval/holaeval.py speed --base-url <url> --model <id> --out <run_dir> --label <label>
```

Measures time to first token, prefill and decode speed at empty, 8K and 32K context over the server's HTTP API (what an app actually gets). Add `--concurrency 1,4` when the user cares about serving several requests. Depths larger than the context window are skipped. Takes a few minutes.

## 4. Capability

Start with a quick pass, then the full pack if the user wants numbers worth publishing:

```bash
python3 skills/run-model-eval/holaeval.py run --base-url <url> --model <id> --out <run_dir> --label <label> --identity "<keywords>" --quick --samples 1
python3 skills/run-model-eval/holaeval.py run --base-url <url> --model <id> --out <run_dir> --label <label> --identity "<keywords>"
```

The general pack (`packs/general-v1.json`) has 20 program-graded tasks: identity, math, code checked by unit tests, instruction following (including Chinese), tool calling, and long-context retrieval. A vendor may supply its own pack; pass it with `--pack`, and read its unit tests before running them because code tasks execute model-written code locally (in a temp dir, 10 s timeout).

Runs are long. Use `terminal_session_start` for anything over a couple of minutes and check on it with `terminal_session_wait` / `terminal_session_read`; each run also appends to `<run_dir>/progress-<label>.log`, ending with a `DONE` line. If the full pack will take more than about 20 minutes (large models, slow hardware, three samples), hand the exact commands to a subagent with `delegate_task` so the conversation is not blocked; it reports back when done.

To compare quantizations, engines, or machines, run each with its own `--label` into the same run directory.

## 5. Agent fitness

When the user wants to know whether the model can run as the holaOS agent itself:

```bash
python3 skills/run-model-eval/holaeval.py agent --base-url <url> --model <id> --out <run_dir> --label <label> --samples 1
python3 skills/run-model-eval/holaeval.py chart --dir <run_dir> --kind agent --title "<model>: holaOS agent fitness"
```

`packs/agent-v1.json` runs 8 multi-turn tasks (read a value, edit JSON, count rows, create a file, pick web search, answer without tools, ask when the request is ambiguous, strict output format) against a simulated workspace: files live in memory and no real command runs. Each task runs twice: `full` sends the real holaOS system prompt and tool list (about 15K tokens before the task), `lean` sends 8 core tools and a short prompt. If the context window cannot hold the full request, `full` is skipped and the summary says why. Results go to `agent-tasks-<label>.jsonl` and `agent-summary-<label>.json`; `tables` adds an "Agent fitness" section.

The gap between `full` and `lean` is the finding: it shows whether the model fails at agent work or only at the size of the holaOS request. "tool call written as text" means the model wrote the call into its reply instead of using the tool-calling protocol; check the engine's chat template before blaming the model.

## 6. Read the results properly

```bash
python3 skills/run-model-eval/holaeval.py tables --dir <run_dir>
```

A pass rate alone is not a finding. For every failed task, open `<run_dir>/tasks-<label>.jsonl` (or `agent-tasks-<label>.jsonl`) and read the actual output (`content`, `reasoning`, `tool_calls`, `finish_reason`, `reason`). Name the cause: wrong answer, broken format, ran out of tokens while thinking, right tool with a wrongly formatted argument, prompt truncated by the server, request error.

## 7. Follow up on anything surprising

The most useful findings usually come from a second, targeted run. When something looks off, design a small experiment that changes one variable, write it as a custom pack in the run directory (same JSON shape as `packs/general-v1.json`; tasks may set `system`), and run it with a new `--label`. Examples:

- The model names another company when asked who it is → rerun the identity tasks 10 times with and without a one-line system prompt.
- Answers loop or never finish → compare temperature 0 against the recommended sampling.
- A tool call has the right intent but a wrong argument format → vary the parameter description.

Use enough samples to say something (10 is a good default for a yes/no behavior) and report both conditions.

## 8. Hand off

When the numbers are in, continue with the `write-conclusion-pack` skill. Stop any terminal sessions you started.
