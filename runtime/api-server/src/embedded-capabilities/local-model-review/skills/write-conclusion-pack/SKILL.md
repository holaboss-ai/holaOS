---
name: write-conclusion-pack
description: Turn a finished local model eval into a conclusion pack (conclusions, data tables, charts, run manifest, limitations, raw data) that someone else can check and reproduce.
---

# Write the Conclusion Pack

Use this after `run-model-eval` has produced results in a run directory (`outputs/model-evals/<date>-<model>/`).

The pack is what reviews, posts and vendor feedback are built from, so every claim in it must trace back to a number in the same folder.

## Build the data

```bash
python3 skills/run-model-eval/holaeval.py tables --dir <run_dir>
python3 skills/run-model-eval/holaeval.py chart --dir <run_dir> --kind speed --title "<Model> on <machine>"
python3 skills/run-model-eval/holaeval.py chart --dir <run_dir> --kind capability --title "<Model> spot check"
```

Charts come out as SVG and, where the system can convert it, PNG (posts need PNG). If only SVG is produced, say so.

## Write `<run_dir>/report.md`

Four sections, in the user's language:

1. **Conclusions**: three to five one-line judgments, each with the condition it holds under ("on a 48GB M5 Pro, Q4 decodes at 141 tok/s"). Every one cites a number from the data section. Lead with what a reader deciding whether to use this model needs to know. Include surprises found in follow-up experiments, with both conditions of the experiment.
2. **Data**: paste `tables.md`; reference the chart files.
3. **Run manifest**: from `manifest.json` and the summaries: machine (chip, memory, power), engine and version, model id and file digest or quantization, sampling actually sent, the server's own defaults if they differ from the recommendation, pack id and version, samples per task, date.
4. **Limitations**: one machine; samples per task; the task set is a spot check and not comparable to official benchmark scores; skipped tasks and why; anything not tested (other engines, thinking off, concurrency).

If a vendor supplied part of the task pack, label those tasks as vendor-specified wherever their results appear.

Small samples are fine as long as they are stated ("2 of 3"). Do not round a 3-sample result into a general claim.

## Finish

Tell the user where the pack is, which files it contains, and the two or three findings worth acting on. Keep the raw `tasks-*.jsonl` and `speed-*.json` files in the folder so the numbers can be checked later.

Then offer to draft posts with `draft-review-posts`.
