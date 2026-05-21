import assert from "node:assert/strict";
import test from "node:test";

import {
  collectWorkspaceRuntimePlanReferences,
  compileWorkspaceRuntimePlan,
  runWorkspaceRuntimePlanCli
} from "./workspace-runtime-plan.js";
import { parseResolvedAppRuntime } from "./workspace-apps.js";

test("collectWorkspaceRuntimePlanReferences returns AGENTS and app configs", () => {
  const references = collectWorkspaceRuntimePlanReferences({
    workspace_yaml: `
template_id: social_operator
applications:
  - app_id: app-a
    config_path: apps/app-a/app.runtime.yaml
  - app_id: app-b
    config_path: apps/app-b/app.runtime.yaml
`
  });

  assert.deepEqual(references, ["AGENTS.md", "apps/app-a/app.runtime.yaml", "apps/app-b/app.runtime.yaml"]);
});

test("compileWorkspaceRuntimePlan resolves workspace catalog tools", () => {
  const plan = compileWorkspaceRuntimePlan({
    workspace_id: "workspace-1",
    workspace_yaml: `
template_id: demo
name: Demo
agents:
  id: workspace.general
  model: gpt-5.2
mcp_registry:
  allowlist:
    tool_ids:
      - workspace.echo
  servers:
    workspace:
      type: local
      enabled: true
      timeout_ms: 10000
  catalog:
    workspace.echo:
      module_path: tools.echo
      symbol: echo_tool
`,
    references: {}
  });

  assert.deepEqual(plan.resolved_mcp_tool_refs.map((toolRef) => toolRef.tool_id), ["workspace.echo"]);
  assert.deepEqual(plan.resolved_mcp_servers.map((server) => server.server_id), ["workspace"]);
  assert.deepEqual(plan.workspace_mcp_catalog.map((entry) => entry.module_path), ["tools.echo"]);
  assert.deepEqual(plan.schema_aliases, {});
});

test("compileWorkspaceRuntimePlan accepts the minimal empty workspace scaffold", () => {
  const plan = compileWorkspaceRuntimePlan({
    workspace_id: "workspace-empty",
    workspace_yaml: `
agents:
  id: workspace.general
  model: openai/gpt-5
mcp_registry:
  allowlist:
    tool_ids: []
  servers: {}
`,
    references: {}
  });

  assert.equal(plan.general_config.type, "single");
  assert.equal(plan.general_config.agent.id, "workspace.general");
  assert.equal(plan.general_config.agent.model, "openai/gpt-5");
  assert.deepEqual(plan.mcp_tool_allowlist, []);
  assert.deepEqual(plan.resolved_mcp_servers.map((server) => server.server_id), []);
});

test("compileWorkspaceRuntimePlan exposes configured remote MCP servers when no allowlist is indicated", () => {
  const plan = compileWorkspaceRuntimePlan({
    workspace_id: "workspace-remote-mcp",
    workspace_yaml: `
agents:
  id: workspace.general
  model: openai/gpt-5
mcp_registry:
  allowlist:
    tool_ids: []
  servers:
    context7:
      type: remote
      url: "https://mcp.context7.com/mcp"
      enabled: true
`,
    references: {}
  });

  assert.deepEqual(plan.mcp_tool_allowlist, []);
  assert.deepEqual(plan.resolved_mcp_tool_refs, []);
  assert.deepEqual(plan.resolved_mcp_servers.map((server) => server.server_id), ["context7"]);
});

test("compileWorkspaceRuntimePlan exposes workspace catalog tools when no allowlist is indicated", () => {
  const plan = compileWorkspaceRuntimePlan({
    workspace_id: "workspace-local-mcp",
    workspace_yaml: `
agents:
  id: workspace.general
  model: openai/gpt-5
mcp_registry:
  servers: {}
  catalog:
    workspace.echo:
      module_path: tools.echo
      symbol: echo_tool
`,
    references: {}
  });

  assert.deepEqual(plan.mcp_tool_allowlist, []);
  assert.deepEqual(plan.resolved_mcp_tool_refs, []);
  assert.deepEqual(plan.resolved_mcp_servers.map((server) => server.server_id), ["workspace"]);
  assert.deepEqual(plan.workspace_mcp_catalog, [
    {
      tool_id: "workspace.echo",
      tool_name: "echo",
      module_path: "tools.echo",
      symbol_name: "echo_tool"
    }
  ]);
});

test("compileWorkspaceRuntimePlan loads prompt and applications", () => {
  const plan = compileWorkspaceRuntimePlan({
    workspace_id: "ws-test",
    workspace_yaml: `
template_id: social_operator
name: Social Operator
agents:
  id: workspace.general
  model: gpt-4o
applications:
  - app_id: holaposter-ts-lite
    config_path: apps/holaposter-ts-lite/app.runtime.yaml
mcp_registry:
  allowlist:
    tool_ids:
      - holaposter.create_post
  servers:
    holaposter:
      type: remote
      url: "http://localhost:3099/mcp"
      enabled: true
`,
    references: {
      "AGENTS.md": "You are concise.",
      "apps/holaposter-ts-lite/app.runtime.yaml": `
app_id: holaposter-ts-lite
healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 60
    interval_s: 5
mcp:
  transport: http-sse
  port: 3099
  path: /mcp
env_contract:
  - HOLABOSS_USER_ID
`
    }
  });

  assert.equal(plan.general_config.type, "single");
  assert.equal(plan.general_config.agent.prompt, "You are concise.");
  assert.equal(plan.resolved_applications.length, 1);
  assert.equal(plan.resolved_applications[0]?.mcp.port, 3099);
  assert.deepEqual(plan.mcp_tool_allowlist, ["holaposter.create_post"]);
  assert.deepEqual(plan.schema_aliases, {});
});

test("compileWorkspaceRuntimePlan keeps other enabled remote MCP servers even when some tool ids are explicitly allowlisted", () => {
  const plan = compileWorkspaceRuntimePlan({
    workspace_id: "ws-mixed-mcp",
    workspace_yaml: `
agents:
  id: workspace.general
  model: openai/gpt-5
mcp_registry:
  allowlist:
    tool_ids:
      - gmail.gmail_search
  servers:
    gmail:
      type: remote
      url: "http://localhost:3099/mcp"
      enabled: true
    context7:
      type: remote
      url: "https://mcp.context7.com/mcp"
      enabled: true
`,
    references: {}
  });

  assert.deepEqual(plan.mcp_tool_allowlist, ["gmail.gmail_search"]);
  assert.deepEqual(plan.resolved_mcp_tool_refs, [
    {
      tool_id: "gmail.gmail_search",
      server_id: "gmail",
      tool_name: "gmail_search",
    },
  ]);
  assert.deepEqual(plan.resolved_mcp_servers.map((server) => server.server_id), ["gmail", "context7"]);
});

test("compileWorkspaceRuntimePlan parses application integrations", () => {
  const plan = compileWorkspaceRuntimePlan({
    workspace_id: "ws-integrations",
    workspace_yaml: `
template_id: gmail_workspace
agents:
  id: workspace.general
  model: openai/gpt-5
mcp_registry:
  allowlist:
    tool_ids: []
  servers: {}
applications:
  - app_id: gmail
    config_path: apps/gmail/app.runtime.yaml
`,
    references: {
      "apps/gmail/app.runtime.yaml": `
app_id: gmail
mcp:
  port: 3099
integrations:
  - key: primary_google
    provider: google
    capability: gmail
    scopes:
      - gmail.send
      - gmail.readonly
    required: true
    credential_source: broker
    holaboss_user_id_required: true
`
    }
  });

  assert.deepEqual(plan.resolved_applications[0]?.integrations, [
    {
      key: "primary_google",
      provider: "google",
      capability: "gmail",
      scopes: ["gmail.send", "gmail.readonly"],
      required: true,
      credentialSource: "broker",
      holabossUserIdRequired: true
    }
  ]);
});

test("parseResolvedAppRuntime parses a legacy single integration block", () => {
  const resolved = parseResolvedAppRuntime(
    `
app_id: gmail
mcp:
  port: 3099
integration:
  destination: google
  credential_source: platform
  holaboss_user_id_required: true
env_contract:
  - HOLABOSS_USER_ID
`,
    "gmail",
    "apps/gmail/app.runtime.yaml"
  );

  assert.deepEqual(resolved.integrations, [
    {
      key: "google",
      provider: "google",
      capability: null,
      scopes: [],
      required: true,
      credentialSource: "platform",
      holabossUserIdRequired: true
    }
  ]);
});

test("parseResolvedAppRuntime parses list-based integrations", () => {
  const resolved = parseResolvedAppRuntime(
    `
app_id: gmail
mcp:
  port: 3099
integrations:
  - key: primary_google
    provider: google
    capability: gmail
    scopes:
      - gmail.send
      - gmail.readonly
    required: true
    credential_source: broker
    holaboss_user_id_required: true
`,
    "gmail",
    "apps/gmail/app.runtime.yaml"
  );

  assert.deepEqual(resolved.integrations, [
    {
      key: "primary_google",
      provider: "google",
      capability: "gmail",
      scopes: ["gmail.send", "gmail.readonly"],
      required: true,
      credentialSource: "broker",
      holabossUserIdRequired: true
    }
  ]);
});

test("parseResolvedAppRuntime preserves the selected healthcheck target", () => {
  const mcpResolved = parseResolvedAppRuntime(
    `
app_id: gmail
mcp:
  port: 3099
healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 30
    interval_s: 1
`,
    "gmail",
    "apps/gmail/app.runtime.yaml"
  );
  assert.equal(mcpResolved.healthCheck.target, "mcp");
  assert.equal(mcpResolved.healthCheck.path, "/mcp/health");

  const apiResolved = parseResolvedAppRuntime(
    `
app_id: gmail
mcp:
  port: 3099
healthchecks:
  api:
    path: /healthz
    timeout_s: 45
    interval_s: 2
`,
    "gmail",
    "apps/gmail/app.runtime.yaml"
  );
  assert.equal(apiResolved.healthCheck.target, "api");
  assert.equal(apiResolved.healthCheck.path, "/healthz");
});

test("parseResolvedAppRuntime rejects unknown credential_source values", () => {
  assert.throws(
    () =>
      parseResolvedAppRuntime(
        `
app_id: gmail
mcp:
  port: 3099
integration:
  destination: google
  credential_source: not-a-real-mode
`,
        "gmail",
        "apps/gmail/app.runtime.yaml"
      ),
    /credential_source/i
  );
});

test("parseResolvedAppRuntime rejects non-canonical integration provider aliases", () => {
  assert.throws(
    () =>
      parseResolvedAppRuntime(
        `
app_id: x-demo
mcp:
  port: 3099
integrations:
  - key: primary_x
    provider: x
    capability: api
`,
        "x-demo",
        "apps/x-demo/app.runtime.yaml"
      ),
    /Use canonical provider_id 'twitter'/
  );
});

test("compileWorkspaceRuntimePlan rejects mixed legacy and list-based integration forms", () => {
  assert.throws(
    () =>
      compileWorkspaceRuntimePlan({
        workspace_id: "ws-integrations",
        workspace_yaml: `
template_id: gmail_workspace
agents:
  id: workspace.general
  model: openai/gpt-5
mcp_registry:
  allowlist:
    tool_ids: []
  servers: {}
applications:
  - app_id: gmail
    config_path: apps/gmail/app.runtime.yaml
`,
        references: {
          "apps/gmail/app.runtime.yaml": `
app_id: gmail
mcp:
  port: 3099
integration:
  destination: google
  credential_source: platform
integrations:
  - key: primary_google
    provider: google
    capability: gmail
`
        }
      }),
    /both integration and integrations/i
  );
});

test("compileWorkspaceRuntimePlan rejects list-based agents definitions", () => {
  assert.throws(
    () =>
      compileWorkspaceRuntimePlan({
        workspace_id: "workspace-1",
        workspace_yaml: `
agents:
  - id: agent-1
    model: gpt-5.2
  - id: agent-2
    model: gpt-5.2
mcp_registry:
  allowlist:
    tool_ids: []
  servers: {}
`,
        references: {}
      }),
    /missing object field 'agents'/
  );
});

test("compileWorkspaceRuntimePlan rejects legacy agents.general definitions", () => {
  assert.throws(
    () =>
      compileWorkspaceRuntimePlan({
        workspace_id: "workspace-1",
        workspace_yaml: `
agents:
  general:
    type: team
    coordinator:
      id: coordinator
      model: gpt-5.2
    members:
      - id: writer
        model: gpt-5.2-mini
mcp_registry:
  allowlist:
    tool_ids: []
  servers: {}
`,
        references: {}
      }),
    /missing required fields 'agents.id' and 'agents.model'/
  );
});

test("runWorkspaceRuntimePlanCli collects structured references", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runWorkspaceRuntimePlanCli(
    [
      "collect-references",
      "--request-base64",
      Buffer.from(
        JSON.stringify({
          workspace_yaml: `
template_id: social_operator
applications:
  - app_id: app-a
    config_path: apps/app-a/app.runtime.yaml
`
        }),
        "utf8"
      ).toString("base64")
    ],
    {
      io: {
        stdout: {
          write(chunk: string) {
            stdout.push(chunk);
            return true;
          }
        } as NodeJS.WritableStream,
        stderr: {
          write(chunk: string) {
            stderr.push(chunk);
            return true;
          }
        } as NodeJS.WritableStream
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
  assert.deepEqual(JSON.parse(stdout.join("")), {
    ok: true,
    references: ["AGENTS.md", "apps/app-a/app.runtime.yaml"]
  });
});

test("runWorkspaceRuntimePlanCli returns structured compiler errors", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runWorkspaceRuntimePlanCli(
    [
      "compile",
      "--request-base64",
      Buffer.from(
        JSON.stringify({
          workspace_id: "workspace-1",
          workspace_yaml: `
template_id: demo
agents:
  id: workspace.general
  model: gpt-5.2
mcp_registry:
  allowlist:
    tool_ids:
      - workspace.memory_search
  servers:
    workspace:
      type: local
  catalog: {}
`
        }),
        "utf8"
      ).toString("base64")
    ],
    {
      io: {
        stdout: {
          write(chunk: string) {
            stdout.push(chunk);
            return true;
          }
        } as NodeJS.WritableStream,
        stderr: {
          write(chunk: string) {
            stderr.push(chunk);
            return true;
          }
        } as NodeJS.WritableStream
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
  assert.deepEqual(JSON.parse(stdout.join("")), {
    ok: false,
    error: {
      code: "workspace_mcp_catalog_missing",
      path: "mcp_registry.allowlist.tool_ids[0]",
      message: "workspace tool 'workspace.memory_search' is missing catalog entry in mcp_registry.catalog",
      hint: null
    }
  });
});
