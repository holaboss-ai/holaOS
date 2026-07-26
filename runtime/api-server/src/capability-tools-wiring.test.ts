import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_AGENT_TOOL_DEFINITIONS as HARNESS_DEFS,
  RUNTIME_AGENT_TOOL_IDS,
} from "../../harnesses/src/runtime-agent-tools.js";
import { buildAgentCapabilityManifest } from "./agent-capability-registry.js";
import { RUNTIME_AGENT_TOOL_DEFINITIONS as ROUTE_DEFS } from "./runtime-agent-tools.js";

const CAPABILITY_INSTALL_PATH =
  "/api/v1/capabilities/runtime-tools/capability-install";

test("capability_install is registered with the correct route and policy", () => {
  const harnessEntry = HARNESS_DEFS.find(
    (tool) => tool.id === "capability_install",
  );
  assert.ok(harnessEntry, "harness definition for capability_install should exist");
  assert.equal(harnessEntry?.policy, "mutate", "capability_install policy");
  assert.ok(
    (harnessEntry?.description ?? "").length > 20,
    "capability_install should have a non-trivial description for the model",
  );

  const routeEntry = ROUTE_DEFS.find((tool) => tool.id === "capability_install");
  assert.ok(routeEntry, "route registration for capability_install should exist");
  assert.equal(routeEntry?.method, "POST", "capability_install method");
  assert.equal(routeEntry?.path, CAPABILITY_INSTALL_PATH, "capability_install path");
});

test("main_session manifest surfaces capability_install", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "main_session",
    runtimeToolIds: [...RUNTIME_AGENT_TOOL_IDS],
    defaultTools: ["read"],
    extraTools: ["capability_install"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const tool = manifest.runtime_tools.find((t) => t.id === "capability_install");
  assert.ok(tool, "capability_install should be surfaced to main_session");
  assert.equal(
    tool?.callable_name,
    "capability_install",
    "capability_install should be callable",
  );
});

test("ts-runner gates capability_install to front-of-house controllers", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./ts-runner.ts", import.meta.url), "utf8");

  const allowListMatch = source.match(
    /const MAIN_SESSION_RUNTIME_TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(allowListMatch, "could not find MAIN_SESSION_RUNTIME_TOOL_IDS");
  assert.ok(
    allowListMatch[1].includes('"capability_install"'),
    "capability_install should be allow-listed for the main session in ts-runner.ts",
  );

  const subagentOnlyBlockedMatch = source.match(
    /const SUBAGENT_ONLY_BLOCKED_RUNTIME_TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(
    subagentOnlyBlockedMatch,
    "could not find SUBAGENT_ONLY_BLOCKED_RUNTIME_TOOL_IDS",
  );
  assert.ok(
    subagentOnlyBlockedMatch[1].includes('"capability_install"'),
    "capability_install should be in SUBAGENT_ONLY_BLOCKED_RUNTIME_TOOL_IDS so subagents cannot author capabilities while main_session retains it",
  );

  const subagentBlockedMatch = source.match(
    /const SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(subagentBlockedMatch, "could not find SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS");
  assert.ok(
    !subagentBlockedMatch[1].includes('"capability_install"'),
    "capability_install must NOT be in SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS — that set is applied to main_session and would strip the tool from the controller",
  );
});
