import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  benchCatalog,
  benchLinkFromApp,
  benchSubjectUrl,
  isBenchRunDir,
  isCardName,
  loadBenchContext,
  parseBenchDeepLink,
  publishBenchRun,
  xIntentUrl,
} from "./bench-links.js";

const link = (value: string) => parseBenchDeepLink(new URL(value));

test("bench deep links carry a Radar subject id and default to the standard suite", () => {
  assert.deepEqual(link("ai.holaboss.app://bench?subject=openbmb-minicpm5-2b"), {
    subjectId: "openbmb-minicpm5-2b",
    suite: "suite-standard@1.0",
  });
  assert.deepEqual(link("ai.holaboss.app://bench?subject=qwen3-8b&suite=suite-standard@1.0"), {
    subjectId: "qwen3-8b",
    suite: "suite-standard@1.0",
  });
});

test("anything that is not a clean subject id or suite is ignored", () => {
  assert.equal(link("ai.holaboss.app://open-app?appId=x"), null);
  assert.equal(link("ai.holaboss.app://bench"), null);
  assert.equal(link("ai.holaboss.app://bench?subject=../../etc/passwd"), null);
  assert.equal(link("ai.holaboss.app://bench?subject=https://evil.example/x"), null);
  assert.equal(link("ai.holaboss.app://bench?subject=ok&suite=../x"), null);
  assert.equal(parseBenchDeepLink(null), null);
});

test("subject JSON lives under the configured base", () => {
  assert.equal(
    benchSubjectUrl("https://hub.holaos.ai/bench/subjects/", "openbmb-minicpm5-2b"),
    "https://hub.holaos.ai/bench/subjects/openbmb-minicpm5-2b.json",
  );
});

test("files are only written into <workspace>/bench/<run uuid>", () => {
  const root = path.join(path.sep, "sandbox", "workspace");
  const run = path.join(root, "ws-1", "bench", "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11");
  assert.equal(isBenchRunDir(root, run), true);
  assert.equal(isBenchRunDir(root, path.join(root, "ws-1", "evals", "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11")), false);
  assert.equal(isBenchRunDir(root, path.join(root, "ws-1", "bench", "x")), false);
  assert.equal(isBenchRunDir(root, path.join(run, "..", "..", "..", "..", "etc")), false);
  assert.equal(isBenchRunDir(root, path.join(path.sep, "tmp", "ws-1", "bench", "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11")), false);
});

test("card names and share links", () => {
  assert.equal(isCardName("benchmark-card"), true);
  assert.equal(isCardName("../card"), false);
  const url = new URL(xIntentUrl("MiniCPM5-2B: 102 tok/s", "https://hub.holaos.ai/bench/runs/1"));
  assert.equal(url.searchParams.get("text"), "MiniCPM5-2B: 102 tok/s");
  assert.equal(url.searchParams.get("url"), "https://hub.holaos.ai/bench/runs/1");
});

test("opens from inside the app go through the same validation as deep links", () => {
  assert.deepEqual(benchLinkFromApp("openbmb-minicpm5-2b"), { subjectId: "openbmb-minicpm5-2b", suite: "suite-standard@1.0" });
  assert.equal(benchLinkFromApp("../x"), null);
  assert.equal(benchLinkFromApp(42), null);
});

test("the bundled catalog lists every config so the bench works before HolaHub hosts them", () => {
  assert.deepEqual(
    benchCatalog().map((entry) => entry.id),
    ["openbmb-minicpm5-2b", "openbmb-minicpm5-2b-q8_0", "qwen-qwen3.5-2b", "qwen-qwen3.6-35b-a3b"],
  );
  assert.equal(benchCatalog().find((entry) => entry.id === "qwen-qwen3.6-35b-a3b")?.download_bytes, 23_938_333_577);
  const q8 = benchCatalog().find((entry) => entry.id === "openbmb-minicpm5-2b-q8_0");
  assert.equal(q8?.name, "MiniCPM5-2B");
  assert.equal(q8?.quant, "Q8_0");
});

const minicpm = { subjectId: "openbmb-minicpm5-2b", suite: "suite-standard@1.0" };
const deps = (fetchImpl: typeof fetch, subjectsBaseUrl = "https://hub.example/bench/subjects") => ({
  subjectsBaseUrl,
  resultBaseUrl: "https://hub.example/bench/runs",
  fetchImpl,
});

test("HolaHub's config wins when it loads", async () => {
  const remote = { type: "model", id: "openbmb-minicpm5-2b", name: "MiniCPM5-2B (HolaHub)", quant: "Q4_K_M" };
  const context = await loadBenchContext(minicpm, deps((async () => new Response(JSON.stringify(remote))) as typeof fetch));
  assert.equal(context.subject?.name, "MiniCPM5-2B (HolaHub)");
  assert.equal(context.error, null);
});

test("a missing, unconfigured or unreachable HolaHub falls back to the bundled config", async () => {
  const notFound = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  for (const context of [
    await loadBenchContext(minicpm, deps(notFound)),
    await loadBenchContext(minicpm, deps(offline)),
    await loadBenchContext(minicpm, deps(offline, "")),
  ]) {
    assert.equal(context.subject?.name, "MiniCPM5-2B");
    assert.equal(context.error, null);
  }
});

test("an unknown model with no HolaHub copy reports an error", async () => {
  const notFound = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  const context = await loadBenchContext({ subjectId: "nope", suite: "suite-standard@1.0" }, deps(notFound));
  assert.equal(context.subject, null);
  assert.match(context.error ?? "", /404/);
});

const RUN_ID = "65d4e76d-73d6-41a4-bd0a-d3faa38507d1";

async function runDirWithCards(cards: string[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-publish-"));
  await fs.writeFile(path.join(dir, "run-record.json"), JSON.stringify({ schema: "hola.run-record/0.1", run_id: RUN_ID }));
  for (const card of cards) {
    await fs.writeFile(path.join(dir, card), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
  return dir;
}

function hubStub(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const publishOptions = (overrides: Partial<Parameters<typeof publishBenchRun>[1]> = {}) => ({
  hubApiBaseUrl: "https://api.example/gateway/hub",
  resultBaseUrl: "https://hub.example/bench/runs/",
  cookie: "session=abc",
  submitterName: async () => "Ada",
  ...overrides,
});

test("publishing sends the record and the cards that exist, with the session", async () => {
  const dir = await runDirWithCards(["benchmark-card.png"]);
  const hub = hubStub(201, { id: RUN_ID });
  const result = await publishBenchRun(dir, publishOptions({ fetchImpl: hub.fetchImpl }));
  assert.deepEqual(result, { ok: true, id: RUN_ID, url: `https://hub.example/bench/runs/${RUN_ID}` });
  assert.equal(hub.calls[0]?.url, "https://api.example/gateway/hub/bench/runs");
  assert.equal((hub.calls[0]?.init.headers as Record<string, string>).cookie, "session=abc");
  const sent = JSON.parse(String(hub.calls[0]?.init.body));
  assert.equal(sent.run_record.run_id, RUN_ID);
  assert.deepEqual(Object.keys(sent.cards), ["benchmark"]);
  assert.equal(sent.submitter_name, "Ada");
});

test("publishing without a session or a hub never calls out", async () => {
  const dir = await runDirWithCards([]);
  const hub = hubStub(201, { id: RUN_ID });
  assert.deepEqual(await publishBenchRun(dir, publishOptions({ cookie: "", fetchImpl: hub.fetchImpl })), {
    ok: false,
    reason: "signed_out",
  });
  assert.deepEqual(await publishBenchRun(dir, publishOptions({ hubApiBaseUrl: "", fetchImpl: hub.fetchImpl })), {
    ok: false,
    reason: "not_configured",
  });
  assert.equal(hub.calls.length, 0);
});

test("an expired session reads as signed out, and a refusal says why", async () => {
  const dir = await runDirWithCards([]);
  assert.deepEqual(await publishBenchRun(dir, publishOptions({ fetchImpl: hubStub(401, { error: "unauthorized" }).fetchImpl })), {
    ok: false,
    reason: "signed_out",
  });
  await assert.rejects(
    publishBenchRun(dir, publishOptions({ fetchImpl: hubStub(409, { error: "run_id_taken" }).fetchImpl })),
    /Another account already published this run/,
  );
  await assert.rejects(
    publishBenchRun(dir, publishOptions({ fetchImpl: hubStub(201, { id: "../../x" }).fetchImpl })),
    /could not publish/,
  );
});
