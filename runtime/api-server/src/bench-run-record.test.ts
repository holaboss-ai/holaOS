import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  BenchSubjectError,
  RUN_RECORD_SCHEMA,
  buildRunRecord,
  minOllamaVersion,
  parseBenchSubject,
  type BenchSubject,
  type HolaevalBenchOutput,
} from "./bench-run-record.js";
import { benchHighlights } from "./bench-runner.js";
import { OLLAMA_BENCH_ENV, compareOllamaVersions } from "./ollama-instance.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bench = JSON.parse(
  fs.readFileSync(path.join(here, "__fixtures__", "holaeval-bench-output.json"), "utf8"),
) as HolaevalBenchOutput;

const subject: BenchSubject = {
  type: "model",
  id: "openbmb-minicpm5-2b",
  name: "MiniCPM5-2B",
  vendor: "OpenBMB",
  quant: "Q4_K_M",
  ollama: { tag: "openbmb/minicpm5-2b:q4_k_m", known_digests: ["d1"], min_version: "0.12.6" },
  sampling: { temperature: 0.7, top_p: 0.8 },
};

const evidence = {
  kind: "local" as const,
  provider: {
    engine: "ollama" as const,
    version: "0.12.6",
    env: { ...OLLAMA_BENCH_ENV },
    flash_attention: "auto" as const,
    managed: true,
  },
};

function record(digest: string | null) {
  return buildRunRecord({
    runId: "run-1",
    bench,
    subject,
    digest,
    evidence,
    client: { app: "holaOS" as const, version: "0.9.0" },
    artifacts: { recording: null, cards: [], highlights: [] },
    conditions: { cpu_busy_pct: 4 },
  });
}

test("a run record carries suite, subject, test agent and runtime from their sources", () => {
  const rr = record("d1");
  assert.equal(rr.schema, RUN_RECORD_SCHEMA);
  assert.deepEqual(rr.suite, bench.suite);
  assert.equal(rr.subject.version, "d1");
  assert.equal(rr.subject.digest_registered, true);
  assert.deepEqual(rr.subject.capabilities, ["completion", "tools", "thinking"]);
  assert.equal(rr.test_agent.executor, bench.test_agent.executor);
  assert.equal(rr.test_agent.settings.num_ctx, 16384);
  assert.equal(rr.runtime.hardware, bench.machine);
  assert.equal(rr.runtime.provider.env.OLLAMA_KV_CACHE_TYPE, "f16");
  assert.deepEqual(rr.runtime.conditions, { cpu_busy_pct: 4 });
  assert.deepEqual(
    rr.results.map((r) => r.task),
    ["speed@0", "speed@8k", "code-intervals", "tool-flight", "needle-8k"],
  );
});

test("an unlisted digest is flagged but still recorded", () => {
  const rr = record("d2");
  assert.equal(rr.subject.version, "d2");
  assert.equal(rr.subject.digest_registered, false);
  assert.equal(record(null).subject.digest_registered, false);
});

test("HolaHub fills trust fields; the client never sets them", () => {
  const rr = record("d1");
  assert.equal(rr.verification, null);
  assert.equal(rr.provenance, null);
  assert.equal(rr.submitter, null);
  assert.equal(rr.signature, null);
});

test("subjects must name a Radar id, a quant and an Ollama tag", () => {
  assert.equal(parseBenchSubject(subject).id, subject.id);
  assert.throws(() => parseBenchSubject({ ...subject, type: "agent" }), BenchSubjectError);
  assert.throws(() => parseBenchSubject({ ...subject, ollama: {} }), /ollama\.tag/);
  assert.throws(() => parseBenchSubject({ ...subject, quant: "" }), /quant/);
});

test("the Ollama floor is the higher of the suite's and the model's", () => {
  assert.equal(minOllamaVersion("0.12.0", subject, compareOllamaVersions), "0.12.6");
  assert.equal(minOllamaVersion("0.13.1", subject, compareOllamaVersions), "0.13.1");
  assert.equal(minOllamaVersion(undefined, { ...subject, ollama: { tag: "x" } }, compareOllamaVersions), null);
});

/** JSON.stringify with every object's keys sorted, so key order can't make two equal records differ. */
function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(sortKeys);
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((key) => [key, sortKeys((v as Record<string, unknown>)[key])]));
    }
    return v;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

for (const fixture of ["parity", "parity/coding"]) {
  test(`parity golden (${fixture}): the desktop builds the exact Run Record the hola CLI's test expects`, () => {
    const dir = path.join(here, "__fixtures__", fixture);
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const inputs = read("inputs.json");
    const built = buildRunRecord({
      runId: inputs.run_id,
      bench: read("bench-output.json"),
      subject: read("subject.json"),
      digest: inputs.digest,
      evidence: read("evidence.json"),
      client: inputs.client,
      artifacts: { recording: null, cards: [], highlights: benchHighlights(inputs.events), ...inputs.artifacts },
      conditions: inputs.conditions,
    });
    assert.equal(canonicalJson(built), fs.readFileSync(path.join(dir, "run-record.json"), "utf8"));
  });
}
