import fs from "node:fs";
import path from "node:path";

import type {
  EvaluationProposalRecord,
  EvaluationRecord,
  EvaluationRunRecord,
} from "@holaboss/runtime-state-store";

import { type BarChartSpec, groupedBarSvg, svgToPng } from "./evaluation-charts.js";
import { escapeHtml, renderMarkdownToHtml } from "./evaluation-markdown.js";
import { redactPublicText, redactPublicValue, type RedactionIdentity } from "./evaluation-redact.js";

export const EVAL_DATA_SCHEMA = "holaos-eval-data/1";
export const EVAL_REPORT_SCHEMA = "holaos-eval-report/1";

export interface Stat {
  passed: number;
  n: number;
  rate: number;
}

export interface SpeedDepthRow {
  depth: number;
  ttft_s: number | null;
  prefill_tps: number | null;
  decode_tps: number | null;
  decode_tps_sd: number | null;
  skipped: string | null;
}

export interface DataLayerRun {
  key: string;
  label: string;
  kinds: string[];
  origin: "plan" | "followup";
  proposal_title: string | null;
  engine: string | null;
  engine_version: string | null;
  model: string;
  context_window: number | null;
  sampling: Record<string, unknown>;
  samples: number | null;
}

export interface AgentConditionResult extends Stat {
  prompt_tokens_avg: number | null;
  first_response_s_avg: number | null;
  tool_count: number | null;
  skipped: string | null;
  failures: Array<{ task: string; reasons: Record<string, number> }>;
}

export interface PlaceholderValue {
  value: number | string;
  label: string;
}

export interface EvalDataLayer {
  schema: typeof EVAL_DATA_SCHEMA;
  generated_at: string;
  runs: DataLayerRun[];
  speed: Array<{ key: string; label: string; depths: SpeedDepthRow[] }>;
  capability: Array<{
    key: string;
    label: string;
    pack: string | null;
    pack_version: number | string | null;
    overall: Stat;
    by_category: Record<string, Stat>;
    failures: Array<{ task: string; category: string; failed: number; n: number; reasons: Record<string, number> }>;
    skipped: Array<{ id: string; reason: string }>;
  }>;
  agent: Array<{
    key: string;
    label: string;
    pack: string | null;
    pack_version: number | string | null;
    conditions: Record<string, AgentConditionResult>;
  }>;
  followups: Array<{ title: string; rationale: string; status: string; run_keys: string[] }>;
  failed_runs: Array<{ key: string; label: string; kind: string; error: string }>;
  machine: Record<string, unknown> | null;
  brain: { model: string | null; local: boolean };
  limitations: string[];
  values: Record<string, PlaceholderValue>;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(filePath: string): JsonObject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stat(passed: number, n: number): Stat {
  return { passed, n, rate: n > 0 ? Math.round((1000 * passed) / n) / 10 : 0 };
}

function depthLabel(depth: number): string {
  return depth === 0 ? "empty context" : `${Math.round(depth / 1024)}K context`;
}

export function runTarget(run: EvaluationRunRecord): JsonObject {
  return isRecord(run.spec.target) ? run.spec.target : {};
}

export function dataDirFor(evalDir: string): string {
  return path.join(evalDir, "data");
}

function lastByKey(runs: EvaluationRunRecord[], kind: string): EvaluationRunRecord[] {
  const byKey = new Map<string, EvaluationRunRecord>();
  for (const run of runs) {
    if (run.kind === kind && run.status === "done") {
      byKey.set(run.runKey, run);
    }
  }
  return [...byKey.values()];
}

export function buildDataLayer(params: {
  evaluation: EvaluationRecord;
  runs: EvaluationRunRecord[];
  proposals: EvaluationProposalRecord[];
  dataDir: string;
  brainIsLocal: boolean;
  now?: string;
}): EvalDataLayer {
  const { runs, dataDir } = params;
  const proposalTitles = new Map(params.proposals.map((proposal) => [proposal.proposalId, proposal.title]));
  const values: Record<string, PlaceholderValue> = {};
  const setValue = (key: string, value: number | string | null, label: string) => {
    if (value !== null && value !== "") {
      values[key] = { value, label };
    }
  };

  const runEntries = new Map<string, DataLayerRun>();
  const manifests = new Map<string, JsonObject>();
  for (const run of runs) {
    const manifest = readJson(path.join(dataDir, `manifest-${run.runKey}.json`));
    if (manifest) {
      manifests.set(run.runKey, manifest);
    }
    const target = runTarget(run);
    const existing = runEntries.get(run.runKey);
    if (existing) {
      if (!existing.kinds.includes(run.kind)) {
        existing.kinds.push(run.kind);
      }
      continue;
    }
    const contextWindow =
      num(run.spec.context_window) ??
      (manifest && Array.isArray(manifest.models)
        ? num(
            (manifest.models as unknown[]).filter(isRecord).find((model) => model.id === target.model_id)
              ?.context_window,
          )
        : null);
    runEntries.set(run.runKey, {
      key: run.runKey,
      label: run.label,
      kinds: [run.kind],
      origin: run.proposalId ? "followup" : "plan",
      proposal_title: run.proposalId ? (proposalTitles.get(run.proposalId) ?? null) : null,
      engine: str(target.engine) ?? str(manifest?.engine),
      engine_version: str(manifest?.engine_version),
      model: str(target.model_id) ?? "unknown",
      context_window: contextWindow,
      sampling: isRecord(run.spec.sampling) ? run.spec.sampling : {},
      samples: num(run.spec.samples),
    });
  }
  for (const entry of runEntries.values()) {
    setValue(`run.${entry.key}.model`, entry.model, `Model, ${entry.label}`);
    setValue(`run.${entry.key}.engine`, entry.engine, `Engine, ${entry.label}`);
    setValue(`run.${entry.key}.context_window`, entry.context_window, `Served context, ${entry.label}`);
  }

  const speed: EvalDataLayer["speed"] = [];
  for (const run of lastByKey(runs, "speed")) {
    const file = readJson(path.join(dataDir, `speed-${run.runKey}.json`));
    if (!file || !Array.isArray(file.depths)) {
      continue;
    }
    const depths: SpeedDepthRow[] = (file.depths as unknown[]).filter(isRecord).map((row) => ({
      depth: num(row.depth) ?? 0,
      ttft_s: num(row.ttft_s),
      prefill_tps: num(row.engine_prefill_tps) ?? num(row.prefill_tps),
      decode_tps: num(row.engine_decode_tps) ?? num(row.decode_tps),
      decode_tps_sd: num(row.engine_decode_tps_sd) ?? num(row.decode_tps_sd),
      skipped: str(row.skipped),
    }));
    speed.push({ key: run.runKey, label: run.label, depths });
    for (const row of depths) {
      if (row.skipped) {
        continue;
      }
      const where = `${run.label}, ${depthLabel(row.depth)}`;
      setValue(`speed.${run.runKey}.decode_tps@${row.depth}`, row.decode_tps, `Decode tok/s, ${where}`);
      setValue(`speed.${run.runKey}.prefill_tps@${row.depth}`, row.prefill_tps, `Prefill tok/s, ${where}`);
      setValue(`speed.${run.runKey}.ttft_s@${row.depth}`, row.ttft_s, `Time to first token (s), ${where}`);
    }
  }

  const capability: EvalDataLayer["capability"] = [];
  for (const run of lastByKey(runs, "capability")) {
    const file = readJson(path.join(dataDir, `summary-${run.runKey}.json`));
    if (!file || !isRecord(file.by_category)) {
      continue;
    }
    const byCategory: Record<string, Stat> = {};
    let passed = 0;
    let total = 0;
    for (const [category, entry] of Object.entries(file.by_category)) {
      if (!isRecord(entry)) {
        continue;
      }
      const categoryStat = stat(num(entry.passed) ?? 0, num(entry.n) ?? 0);
      byCategory[category] = categoryStat;
      passed += categoryStat.passed;
      total += categoryStat.n;
      setValue(`capability.${run.runKey}.${category}.rate`, `${categoryStat.rate}%`, `${category} pass rate, ${run.label}`);
      setValue(
        `capability.${run.runKey}.${category}.passed`,
        `${categoryStat.passed}/${categoryStat.n}`,
        `${category} passed, ${run.label}`,
      );
    }
    const overall = stat(passed, total);
    setValue(`capability.${run.runKey}.overall.rate`, `${overall.rate}%`, `Overall pass rate, ${run.label}`);
    setValue(`capability.${run.runKey}.overall.passed`, `${overall.passed}/${overall.n}`, `Overall passed, ${run.label}`);
    const failures: EvalDataLayer["capability"][number]["failures"] = [];
    if (isRecord(file.by_task)) {
      for (const [task, entry] of Object.entries(file.by_task)) {
        if (!isRecord(entry)) {
          continue;
        }
        const n = num(entry.n) ?? 0;
        const taskPassed = num(entry.passed) ?? 0;
        if (taskPassed < n) {
          failures.push({
            task,
            category: str(entry.category) ?? "",
            failed: n - taskPassed,
            n,
            reasons: isRecord(entry.reasons)
              ? Object.fromEntries(Object.entries(entry.reasons).map(([reason, count]) => [reason, num(count) ?? 0]))
              : {},
          });
        }
      }
    }
    capability.push({
      key: run.runKey,
      label: run.label,
      pack: str(file.pack),
      pack_version: num(file.pack_version) ?? str(file.pack_version),
      overall,
      by_category: byCategory,
      failures,
      skipped: Array.isArray(file.skipped)
        ? (file.skipped as unknown[]).filter(isRecord).map((entry) => ({
            id: str(entry.id) ?? "",
            reason: str(entry.reason) ?? "",
          }))
        : [],
    });
  }

  const agent: EvalDataLayer["agent"] = [];
  for (const run of lastByKey(runs, "agent")) {
    const file = readJson(path.join(dataDir, `agent-summary-${run.runKey}.json`));
    if (!file || !isRecord(file.conditions)) {
      continue;
    }
    const skippedByCondition = new Map<string, string>();
    if (Array.isArray(file.skipped)) {
      for (const entry of (file.skipped as unknown[]).filter(isRecord)) {
        const condition = str(entry.condition);
        if (condition) {
          skippedByCondition.set(condition, str(entry.reason) ?? "skipped");
        }
      }
    }
    const conditions: Record<string, AgentConditionResult> = {};
    for (const [condition, entry] of Object.entries(file.conditions)) {
      if (!isRecord(entry)) {
        continue;
      }
      const base = stat(num(entry.passed) ?? 0, num(entry.n) ?? 0);
      const failures: AgentConditionResult["failures"] = [];
      if (isRecord(entry.by_task)) {
        for (const [task, taskEntry] of Object.entries(entry.by_task)) {
          if (isRecord(taskEntry) && (num(taskEntry.passed) ?? 0) < (num(taskEntry.n) ?? 0)) {
            failures.push({
              task,
              reasons: isRecord(taskEntry.reasons)
                ? Object.fromEntries(
                    Object.entries(taskEntry.reasons).map(([reason, count]) => [reason, num(count) ?? 0]),
                  )
                : {},
            });
          }
        }
      }
      conditions[condition] = {
        ...base,
        prompt_tokens_avg: num(entry.prompt_tokens_avg),
        first_response_s_avg: num(entry.first_response_s_avg),
        tool_count: num(entry.tool_count),
        skipped: skippedByCondition.get(condition) ?? null,
        failures,
      };
      if (base.n > 0) {
        setValue(`agent.${run.runKey}.${condition}.rate`, `${base.rate}%`, `Agent success (${condition}), ${run.label}`);
        setValue(`agent.${run.runKey}.${condition}.passed`, `${base.passed}/${base.n}`, `Agent passed (${condition}), ${run.label}`);
      }
      setValue(
        `agent.${run.runKey}.${condition}.prompt_tokens`,
        conditions[condition]?.prompt_tokens_avg ?? null,
        `Agent prompt tokens (${condition}), ${run.label}`,
      );
    }
    for (const [condition, reason] of skippedByCondition) {
      if (!conditions[condition]) {
        conditions[condition] = {
          ...stat(0, 0),
          prompt_tokens_avg: null,
          first_response_s_avg: null,
          tool_count: null,
          skipped: reason,
          failures: [],
        };
      }
    }
    agent.push({
      key: run.runKey,
      label: run.label,
      pack: str(file.pack),
      pack_version: num(file.pack_version) ?? str(file.pack_version),
      conditions,
    });
  }

  const firstManifest = [...manifests.values()][0] ?? null;
  const machine = firstManifest && isRecord(firstManifest.machine) ? { ...firstManifest.machine } : null;
  if (machine) {
    setValue("machine.cpu", str(machine.cpu) ?? str(machine.machine), "CPU");
    setValue("machine.memory_gb", num(machine.memory_gb), "Memory (GB)");
  }

  const followups = params.proposals
    .filter((proposal) => proposal.status === "approved" || proposal.status === "done")
    .map((proposal) => ({
      title: proposal.title,
      rationale: proposal.rationale,
      status: proposal.status,
      run_keys: [...new Set(runs.filter((run) => run.proposalId === proposal.proposalId).map((run) => run.runKey))],
    }));

  const failedRuns = runs
    .filter((run) => run.status === "failed")
    .map((run) => ({ key: run.runKey, label: run.label, kind: run.kind, error: run.error ?? "failed" }));

  const limitations: string[] = [];
  if (capability.length > 0) {
    const pack = capability[0];
    limitations.push(
      `Capability is a fixed spot check (${packLabel(pack?.pack, pack?.pack_version)}), not a benchmark score; small differences are within sampling noise.`,
    );
  }
  if (agent.length > 0) {
    limitations.push(
      "Agent fitness replays holaOS agent conditions (a fixed tool and prompt snapshot) against a sandboxed virtual file system; it is not a live holaOS agent run.",
    );
  }
  for (const entry of speed) {
    for (const row of entry.depths) {
      if (row.skipped) {
        limitations.push(`Speed for ${entry.label} at ${depthLabel(row.depth)} was not measured: ${row.skipped}.`);
      }
    }
  }
  if (machine && machine.power === "battery") {
    limitations.push("Measured on battery power; speeds on AC power may be higher.");
  }
  if (params.brainIsLocal) {
    limitations.push(
      "The analyst model ran on the same machine; speed tests waited until it was idle, but other tests may have overlapped with it.",
    );
  }
  if (failedRuns.length > 0) {
    limitations.push(`${failedRuns.length} run(s) failed and are excluded from the results.`);
  }

  return {
    schema: EVAL_DATA_SCHEMA,
    generated_at: params.now ?? new Date().toISOString(),
    runs: [...runEntries.values()],
    speed,
    capability,
    agent,
    followups,
    failed_runs: failedRuns,
    machine,
    brain: { model: params.evaluation.brainModel, local: params.brainIsLocal },
    limitations,
    values,
  };
}

function formatPlaceholder(value: number | string): string {
  if (typeof value === "string") {
    return value;
  }
  if (Number.isInteger(value)) {
    return value.toLocaleString("en-US");
  }
  return String(Math.round(value * 100) / 100);
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.@:-]+)\s*\}\}/g;

export function resolvePlaceholders(
  markdown: string,
  values: Record<string, PlaceholderValue>,
): { text: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  const text = markdown.replace(PLACEHOLDER, (match, key: string) => {
    const entry = values[key];
    if (!entry) {
      unresolved.add(key);
      return match;
    }
    return formatPlaceholder(entry.value);
  });
  return { text, unresolved: [...unresolved] };
}

function knownNumbers(values: Record<string, PlaceholderValue>): number[] {
  const numbers: number[] = [];
  for (const entry of Object.values(values)) {
    if (typeof entry.value === "number") {
      numbers.push(entry.value);
      continue;
    }
    for (const match of entry.value.matchAll(/\d+(?:\.\d+)?/g)) {
      numbers.push(Number(match[0]));
    }
  }
  return numbers;
}

export function findUnverifiedNumbers(markdown: string, values: Record<string, PlaceholderValue>): string[] {
  const stripped = markdown
    .replace(PLACEHOLDER, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const known = knownNumbers(values);
  const flagged = new Set<string>();
  const pattern = /(?<![\w.,\-/])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(%?)(?![\w.\-/]|,\d)/g;
  for (const match of stripped.matchAll(pattern)) {
    const raw = match[1] ?? "";
    const isPercent = match[2] === "%";
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      continue;
    }
    const significant = raw.includes(".") || isPercent || value >= 10;
    if (!significant || (/^(19|20)\d{2}$/.test(raw) && !isPercent)) {
      continue;
    }
    const matches = known.some((candidate) => Math.abs(candidate - value) <= Math.max(0.051, Math.abs(candidate) * 0.005));
    if (!matches) {
      flagged.add(`${raw}${match[2] ?? ""}`);
    }
  }
  return [...flagged];
}

function machineLine(machine: Record<string, unknown> | null): string | null {
  if (!machine) {
    return null;
  }
  const parts = [
    str(machine.cpu) ?? str(machine.machine),
    num(machine.memory_gb) ? `${num(machine.memory_gb)} GB memory` : null,
    str(machine.model),
    Array.isArray(machine.gpus) ? (machine.gpus as unknown[]).filter((gpu) => typeof gpu === "string").join(", ") : null,
    str(machine.power) ? `${str(machine.power)} power` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function samplingText(sampling: Record<string, unknown>): string {
  const parts = Object.entries(sampling)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key} ${value}`);
  return parts.length > 0 ? parts.join(", ") : "pack default";
}

function cell(value: number | null, digits = 1): string {
  if (value === null) {
    return "–";
  }
  return digits === 0
    ? Math.round(value).toLocaleString("en-US")
    : String(Math.round(value * 10 ** digits) / 10 ** digits);
}

export function packLabel(pack: string | null | undefined, version: number | string | null | undefined): string {
  if (!pack) {
    return version != null ? `v${version}` : "unknown pack";
  }
  return version != null && !pack.endsWith(`-v${version}`) ? `${pack} v${version}` : pack;
}

export function dataLayerMarkdown(layer: EvalDataLayer, options: { chartRefs?: Record<string, string> } = {}): string {
  const out: string[] = [];
  const chartRef = (id: string, title: string) => {
    const ref = options.chartRefs?.[id];
    if (ref) {
      out.push(`![${title}](${ref})`, "");
    }
  };
  out.push("## Setup", "", "| Run | Engine | Model | Served context | Sampling | Samples |", "|---|---|---|---|---|---|");
  for (const run of layer.runs) {
    const origin = run.origin === "followup" ? " (follow-up)" : "";
    out.push(
      `| ${run.label}${origin} | ${[run.engine, run.engine_version].filter(Boolean).join(" ") || "–"} | ${run.model} | ${run.context_window?.toLocaleString("en-US") ?? "–"} | ${samplingText(run.sampling)} | ${run.samples ?? "pack default"} |`,
    );
  }
  out.push("");
  const machine = machineLine(layer.machine);
  if (machine) {
    out.push(`Machine: ${machine}`, "");
  }

  if (layer.speed.length > 0) {
    out.push("## Speed", "", "Streaming over HTTP, temperature 0, averaged over repeated runs.", "");
    chartRef("speed", "Decode speed");
    out.push("| Run | Context | Time to first token (s) | Prefill tok/s | Decode tok/s |", "|---|---|---|---|---|");
    for (const entry of layer.speed) {
      for (const row of entry.depths) {
        if (row.skipped) {
          out.push(`| ${entry.label} | ${depthLabel(row.depth)} | not measured: ${row.skipped} | | |`);
          continue;
        }
        const sd = row.decode_tps_sd ? ` ± ${cell(row.decode_tps_sd)}` : "";
        out.push(
          `| ${entry.label} | ${depthLabel(row.depth)} | ${cell(row.ttft_s, 2)} | ${cell(row.prefill_tps)} | ${cell(row.decode_tps)}${sd} |`,
        );
      }
    }
    out.push("");
  }

  if (layer.capability.length > 0) {
    const pack = layer.capability[0];
    out.push(`## Capability (${packLabel(pack?.pack, pack?.pack_version)})`, "");
    chartRef("capability", "Capability pass rate");
    const categories = [...new Set(layer.capability.flatMap((entry) => Object.keys(entry.by_category)))];
    out.push(`| Category | ${layer.capability.map((entry) => entry.label).join(" | ")} |`);
    out.push(`|---|${layer.capability.map(() => "---").join("|")}|`);
    for (const category of [...categories, "overall"]) {
      const cells = layer.capability.map((entry) => {
        const value = category === "overall" ? entry.overall : entry.by_category[category];
        return value ? `${value.passed}/${value.n} (${value.rate}%)` : "–";
      });
      out.push(`| ${category === "overall" ? "**Overall**" : category} | ${cells.join(" | ")} |`);
    }
    out.push("");
    const failures = layer.capability.flatMap((entry) =>
      entry.failures.map((failure) => {
        const reasons = Object.entries(failure.reasons)
          .map(([reason, count]) => `${reason} ×${count}`)
          .join("; ");
        return `- ${entry.label} · ${failure.task}: failed ${failure.failed}/${failure.n}${reasons ? ` (${reasons})` : ""}`;
      }),
    );
    if (failures.length > 0) {
      out.push("Failures:", "", ...failures, "");
    }
  }

  if (layer.agent.length > 0) {
    const pack = layer.agent[0];
    out.push(`## Agent fitness (${packLabel(pack?.pack, pack?.pack_version)})`, "");
    out.push(
      "`full` sends the real holaOS tool set and system prompt; `lean` sends 8 core tools and a short prompt.",
      "",
    );
    chartRef("agent", "Agent fitness");
    out.push("| Run | Condition | Success | Avg prompt tokens | First response (s) |", "|---|---|---|---|---|");
    for (const entry of layer.agent) {
      for (const [condition, result] of Object.entries(entry.conditions)) {
        if (result.skipped) {
          out.push(`| ${entry.label} | ${condition} | not run: ${result.skipped} | | |`);
          continue;
        }
        out.push(
          `| ${entry.label} | ${condition} | ${result.passed}/${result.n} (${result.rate}%) | ${cell(result.prompt_tokens_avg, 0)} | ${cell(result.first_response_s_avg, 2)} |`,
        );
      }
    }
    out.push("");
  }

  if (layer.followups.length > 0) {
    out.push("## Follow-up experiments", "");
    for (const followup of layer.followups) {
      const labels = layer.runs.filter((run) => followup.run_keys.includes(run.key)).map((run) => run.label);
      out.push(`- **${followup.title}** — ${followup.rationale}${labels.length > 0 ? ` Runs: ${labels.join(", ")}.` : ""}`);
    }
    out.push("");
  }

  if (layer.failed_runs.length > 0) {
    out.push("## Failed runs", "");
    for (const run of layer.failed_runs) {
      out.push(`- ${run.label} · ${run.kind}: ${run.error.split("\n")[0]}`);
    }
    out.push("");
  }

  if (layer.limitations.length > 0) {
    out.push("## Limitations", "", ...layer.limitations.map((line) => `- ${line}`), "");
  }
  return out.join("\n").trim();
}

function chartFootnote(layer: EvalDataLayer): string {
  const machine = machineLine(layer.machine);
  const date = layer.generated_at.slice(0, 10);
  return [machine, date].filter(Boolean).join(" · ");
}

export function chartSpecs(layer: EvalDataLayer, title: string): Array<{ id: string; title: string; spec: BarChartSpec }> {
  const charts: Array<{ id: string; title: string; spec: BarChartSpec }> = [];
  const footnote = chartFootnote(layer);
  if (layer.speed.length > 0) {
    const depths = [...new Set(layer.speed.flatMap((entry) => entry.depths.map((row) => row.depth)))].sort((a, b) => a - b);
    charts.push({
      id: "speed",
      title: "Decode speed",
      spec: {
        title,
        subtitle: "Decode speed by context depth",
        unit: "tokens / second (higher is faster)",
        footnote,
        series: layer.speed.map((entry) => entry.label),
        groups: depths.map((depth) => ({
          label: depthLabel(depth),
          values: layer.speed.map((entry) => {
            const row = entry.depths.find((candidate) => candidate.depth === depth);
            return row && !row.skipped ? row.decode_tps : null;
          }),
        })),
      },
    });
  }
  if (layer.capability.length > 0) {
    const categories = [...new Set(layer.capability.flatMap((entry) => Object.keys(entry.by_category)))];
    charts.push({
      id: "capability",
      title: "Capability pass rate",
      spec: {
        title,
        subtitle: "Capability spot check, pass rate by category",
        unit: "% of samples passed",
        footnote,
        series: layer.capability.map((entry) => entry.label),
        groups: [...categories, "overall"].map((category) => ({
          label: category,
          values: layer.capability.map((entry) =>
            category === "overall" ? entry.overall.rate : (entry.by_category[category]?.rate ?? null),
          ),
        })),
        vmax: 100,
        valueSuffix: "%",
      },
    });
  }
  if (layer.agent.length > 0) {
    const conditions = [...new Set(layer.agent.flatMap((entry) => Object.keys(entry.conditions)))];
    charts.push({
      id: "agent",
      title: "Agent fitness",
      spec: {
        title,
        subtitle: "Agent task success, full holaOS tool set vs lean",
        unit: "% of agent tasks completed",
        footnote,
        series: conditions,
        groups: layer.agent.map((entry) => ({
          label: entry.label,
          values: conditions.map((condition) => {
            const result = entry.conditions[condition];
            return result && !result.skipped && result.n > 0 ? result.rate : null;
          }),
        })),
        vmax: 100,
        valueSuffix: "%",
      },
    });
  }
  return charts;
}

export function writeCharts(params: {
  layer: EvalDataLayer;
  title: string;
  chartsDir: string;
  identity?: RedactionIdentity;
  png?: boolean;
  env?: NodeJS.ProcessEnv;
}): Array<{ id: string; title: string; svgPath: string; pngPath: string | null; svg: string }> {
  fs.mkdirSync(params.chartsDir, { recursive: true });
  return chartSpecs(params.layer, params.title).map((chart) => {
    const svg = redactPublicText(groupedBarSvg(chart.spec), params.identity);
    const svgPath = path.join(params.chartsDir, `${chart.id}.svg`);
    const existing = fs.existsSync(svgPath) ? fs.readFileSync(svgPath, "utf8") : null;
    const pngPath = path.join(params.chartsDir, `${chart.id}.png`);
    if (existing !== svg) {
      fs.writeFileSync(svgPath, svg, "utf8");
      fs.rmSync(pngPath, { force: true });
    }
    let resolvedPng: string | null = fs.existsSync(pngPath) ? pngPath : null;
    if (params.png && !resolvedPng) {
      resolvedPng = svgToPng(svgPath, pngPath, params.env) ? pngPath : null;
    }
    return { id: chart.id, title: chart.title, svgPath, pngPath: resolvedPng, svg };
  });
}

export function dataLayerCsv(layer: EvalDataLayer): string {
  const rows: string[][] = [["run_key", "run_label", "kind", "dimension", "metric", "value"]];
  for (const entry of layer.speed) {
    for (const row of entry.depths) {
      if (row.skipped) {
        continue;
      }
      for (const metric of ["ttft_s", "prefill_tps", "decode_tps"] as const) {
        if (row[metric] !== null) {
          rows.push([entry.key, entry.label, "speed", `depth=${row.depth}`, metric, String(row[metric])]);
        }
      }
    }
  }
  for (const entry of layer.capability) {
    for (const [category, value] of [...Object.entries(entry.by_category), ["overall", entry.overall] as const]) {
      rows.push([entry.key, entry.label, "capability", `category=${category}`, "passed", String(value.passed)]);
      rows.push([entry.key, entry.label, "capability", `category=${category}`, "n", String(value.n)]);
      rows.push([entry.key, entry.label, "capability", `category=${category}`, "rate_pct", String(value.rate)]);
    }
  }
  for (const entry of layer.agent) {
    for (const [condition, value] of Object.entries(entry.conditions)) {
      if (value.skipped) {
        continue;
      }
      rows.push([entry.key, entry.label, "agent", `condition=${condition}`, "passed", String(value.passed)]);
      rows.push([entry.key, entry.label, "agent", `condition=${condition}`, "n", String(value.n)]);
      rows.push([entry.key, entry.label, "agent", `condition=${condition}`, "rate_pct", String(value.rate)]);
      if (value.prompt_tokens_avg !== null) {
        rows.push([entry.key, entry.label, "agent", `condition=${condition}`, "prompt_tokens_avg", String(value.prompt_tokens_avg)]);
      }
    }
  }
  const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return `${rows.map((row) => row.map(quote).join(",")).join("\n")}\n`;
}

export interface ReportDocumentInput {
  evaluation: EvaluationRecord;
  layer: EvalDataLayer;
  opinionMarkdown: string;
  charts: Array<{ id: string; title: string; svg: string }>;
  plan: Record<string, unknown> | null;
  rawData: Record<string, unknown> | null;
  generator: string;
}

const REPORT_CSS = `
:root{color-scheme:light;--ink:#0b0b0b;--ink2:#52514e;--muted:#8a8984;--line:#e6e5e0;--surface:#fcfcfb;--panel:#ffffff}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:16px/1.6 Inter,Helvetica,Arial,"PingFang SC",sans-serif}
main{max-width:860px;margin:0 auto;padding:48px 20px 80px}h1{font-size:32px;line-height:1.2;margin:0 0 8px;letter-spacing:-.01em}
h2{font-size:22px;margin:40px 0 12px;letter-spacing:-.005em}h3{font-size:18px;margin:28px 0 8px}.question{color:var(--ink2);font-size:18px;margin:0 0 24px}
.meta{color:var(--muted);font-size:13px;margin-bottom:32px}.layer-label{text-transform:uppercase;letter-spacing:.06em;font-size:12px;color:var(--muted);margin:48px 0 0;border-top:1px solid var(--line);padding-top:16px}
table{border-collapse:collapse;width:100%;margin:12px 0 20px;font-size:14px;background:var(--panel)}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f4f3ef;font-weight:600}figure{margin:16px 0 24px}figure svg{width:100%;height:auto;border:1px solid var(--line);border-radius:8px}
code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:#f4f3ef;padding:1px 4px;border-radius:4px}pre{background:#f4f3ef;padding:12px;border-radius:8px;overflow:auto}
blockquote{margin:12px 0;padding:4px 16px;border-left:3px solid var(--line);color:var(--ink2)}footer{margin-top:56px;color:var(--muted);font-size:13px}
@media (max-width:600px){main{padding:28px 16px 56px}h1{font-size:26px}table{font-size:13px}}
`;

function jsonScript(id: string, value: unknown): string {
  const json = JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<script type="application/json" id="${id}">${json}</script>`;
}

export function renderReportHtml(input: ReportDocumentInput): string {
  const { evaluation, layer } = input;
  const chartFigures = new Map(input.charts.map((chart) => [chart.id, `<figure>${chart.svg}</figure>`]));
  const dataHtml = renderMarkdownToHtml(dataLayerMarkdown(layer, { chartRefs: {} }));
  const withCharts = dataHtml
    .replace(/(<h2>Speed<\/h2>\s*<p>[^<]*<\/p>)/, `$1${chartFigures.get("speed") ?? ""}`)
    .replace(/(<h2>Capability[^<]*<\/h2>)/, `$1${chartFigures.get("capability") ?? ""}`)
    .replace(/(<h2>Agent fitness[^<]*<\/h2>\s*<p>.*?<\/p>)/s, `$1${chartFigures.get("agent") ?? ""}`);
  const version = evaluation.relation === "version" && evaluation.parentEvalId ? " · new version of an earlier report" : "";
  const reproduction =
    evaluation.relation === "reproduction" && evaluation.source
      ? ` · reproduction of “${escapeHtml(String(evaluation.source.title ?? "another report"))}”${
          typeof evaluation.source.url === "string"
            ? ` (<a href="${escapeHtml(evaluation.source.url)}" rel="noopener noreferrer">source</a>)`
            : ""
        }`
      : "";
  const rawNote = input.rawData ? "" : "<p class=\"meta\">Raw data not public.</p>";
  const meta = {
    schema: EVAL_REPORT_SCHEMA,
    title: evaluation.title,
    question: evaluation.question,
    question_type: evaluation.questionType,
    plan: input.plan,
    packs: {
      capability: layer.capability[0] ? packLabel(layer.capability[0].pack, layer.capability[0].pack_version) : null,
      agent: layer.agent[0] ? packLabel(layer.agent[0].pack, layer.agent[0].pack_version) : null,
    },
    generated_at: layer.generated_at,
    relation: evaluation.relation,
    source: evaluation.source,
  };
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(evaluation.title)}</title><style>${REPORT_CSS}</style></head><body><main>`,
    `<h1>${escapeHtml(evaluation.title)}</h1>`,
    `<p class="question">${escapeHtml(evaluation.question)}</p>`,
    `<p class="meta">Evaluated ${escapeHtml(layer.generated_at.slice(0, 10))}${version}${reproduction}</p>`,
    input.opinionMarkdown.trim() ? `<section>${renderMarkdownToHtml(input.opinionMarkdown)}</section>` : "",
    '<p class="layer-label">Results — generated from the recorded runs</p>',
    `<section>${withCharts}</section>`,
    rawNote,
    `<footer>${escapeHtml(input.generator)}</footer>`,
    jsonScript("holaos-eval-report", meta),
    jsonScript("holaos-eval-data", { ...layer }),
    input.rawData ? jsonScript("holaos-eval-raw", input.rawData) : "",
    "</main></body></html>",
  ].join("\n");
}

export function renderReportMarkdown(input: Omit<ReportDocumentInput, "rawData" | "plan"> & { chartRefs: Record<string, string> }): string {
  const parts = [`# ${input.evaluation.title}`, "", `> ${input.evaluation.question}`, ""];
  if (input.opinionMarkdown.trim()) {
    parts.push(input.opinionMarkdown.trim(), "");
  }
  parts.push("---", "", "_Results below are generated from the recorded runs._", "");
  parts.push(dataLayerMarkdown(input.layer, { chartRefs: input.chartRefs }), "", `_${input.generator}_`, "");
  return parts.join("\n");
}

const RAW_FIELD_LIMIT = 4000;
const RAW_TOTAL_LIMIT = 5_000_000;

function trimRawValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > RAW_FIELD_LIMIT ? `${value.slice(0, RAW_FIELD_LIMIT)}… [truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.map(trimRawValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trimRawValue(entry)]));
  }
  return value;
}

export function collectRawData(dataDir: string, runKeys: Set<string>, identity?: RedactionIdentity): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  let size = 0;
  if (!fs.existsSync(dataDir)) {
    return raw;
  }
  for (const name of fs.readdirSync(dataDir).sort()) {
    const key = name.match(/^(?:speed|summary|agent-summary|tasks|agent-tasks|manifest)-(.+)\.(?:json|jsonl)$/)?.[1];
    if (!key || !runKeys.has(key)) {
      continue;
    }
    const text = fs.readFileSync(path.join(dataDir, name), "utf8");
    let parsed: unknown;
    if (name.endsWith(".jsonl")) {
      parsed = text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        })
        .filter((entry) => entry !== null);
    } else {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        continue;
      }
    }
    const cleaned = redactPublicValue(trimRawValue(parsed), identity);
    const encoded = JSON.stringify(cleaned).length;
    if (size + encoded > RAW_TOTAL_LIMIT) {
      raw[name] = "omitted: raw data size limit reached";
      continue;
    }
    size += encoded;
    raw[name] = cleaned;
  }
  return raw;
}

export function parseReportHtml(html: string): {
  title: string;
  question: string;
  question_type: string;
  plan: Record<string, unknown> | null;
  source: Record<string, unknown> | null;
} | null {
  const match = html.match(/<script type="application\/json" id="holaos-eval-report">([\s\S]*?)<\/script>/);
  if (!match?.[1]) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schema !== EVAL_REPORT_SCHEMA) {
    return null;
  }
  const title = str(parsed.title);
  const question = str(parsed.question);
  const questionType = str(parsed.question_type);
  if (!title || !question || !questionType) {
    return null;
  }
  return {
    title,
    question,
    question_type: questionType,
    plan: isRecord(parsed.plan) ? parsed.plan : null,
    source: isRecord(parsed.source) ? parsed.source : null,
  };
}

export function shareBody(params: {
  evaluation: EvaluationRecord;
  layer: EvalDataLayer;
  opinionMarkdown: string;
  limit?: number;
}): string {
  const limit = params.limit ?? 8000;
  const highlights: string[] = [];
  for (const entry of params.layer.speed) {
    const empty = entry.depths.find((row) => row.depth === 0 && !row.skipped);
    if (empty?.decode_tps) {
      highlights.push(`- ${entry.label}: ${cell(empty.decode_tps)} tok/s decode, ${cell(empty.ttft_s, 2)} s to first token`);
    }
  }
  for (const entry of params.layer.capability) {
    highlights.push(`- ${entry.label}: capability ${entry.overall.passed}/${entry.overall.n} (${entry.overall.rate}%)`);
  }
  for (const entry of params.layer.agent) {
    const parts = Object.entries(entry.conditions)
      .filter(([, result]) => !result.skipped && result.n > 0)
      .map(([condition, result]) => `${condition} ${result.rate}%`);
    if (parts.length > 0) {
      highlights.push(`- ${entry.label}: agent tasks ${parts.join(", ")}`);
    }
  }
  const footer = "\n\nFull report with tables, method and data: report.html (attached).";
  const opinion = params.opinionMarkdown.trim();
  const keyNumbers = highlights.length > 0 ? ["Key numbers:", ...highlights].join("\n") : "";
  let body = [params.evaluation.question, opinion, keyNumbers].filter(Boolean).join("\n\n");
  if (body.length + footer.length > limit) {
    body = `${body.slice(0, Math.max(0, limit - footer.length - 1)).trimEnd()}…`;
  }
  return `${body.trimEnd()}${footer}`;
}
