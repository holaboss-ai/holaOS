import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  type CapabilityDefinition,
  installCapability,
  installWorkspaceAuthoredCapability,
  loadCapabilityCatalog,
  setCapabilityEnabled,
  uninstallCapability,
} from "./workspace-capabilities.js";
import { importPluginAsCapability } from "./import-plugin.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStore(): { store: RuntimeStateStore; root: string } {
  const root = makeTempDir("hb-capabilities-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  return { store, root };
}

function competitorWatchCapability(): CapabilityDefinition {
  return loadCapabilityCatalog().find((capability) => capability.id === "competitor-watch")!;
}

test("B1: loadCapabilityCatalog parses bundled capabilities", async () => {
  const catalog = loadCapabilityCatalog();
  assert.ok(catalog.length >= 2, "expected at least two bundled capabilities");

  const competitor = catalog.find((capability) => capability.id === "competitor-watch");
  assert.ok(competitor, "competitor-watch capability should be present");
  assert.equal(competitor.name, "Competitor Watch");
  assert.equal(competitor.version, undefined);
  assert.equal(competitor.skills.length, 1);
  assert.ok("path" in competitor.skills[0]);
  assert.equal(competitor.integrations[0].provider, "twitter");
  assert.equal(competitor.integrations[0].required, true);

  const inbox = catalog.find((capability) => capability.id === "inbox-triage");
  assert.ok(inbox, "inbox-triage capability should be present");
  assert.ok("ref" in inbox.skills[0]);
  assert.equal(inbox.integrations[0].provider, "gmail");
});

test("B1: malformed capability.yaml throws naming the file", async () => {
  const dir = makeTempDir("hb-capability-bad-");
  const badDir = path.join(dir, "broken");
  fs.mkdirSync(badDir, { recursive: true });
  const manifestPath = path.join(badDir, "capability.yaml");
  fs.writeFileSync(manifestPath, "name: Missing Id\nversion: 1.0.0\n", "utf8");

  assert.throws(
    () => loadCapabilityCatalog({ dir }),
    (error: unknown) => error instanceof Error && error.message.includes(manifestPath) && /id is required/.test(error.message),
  );
});

test("B2: installCapability writes SKILL.md, records row, needs_connection without connection", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-1";
  const workspaceDir = path.join(root, "workspace", workspaceId);
  const capability = competitorWatchCapability();

  const result = await installCapability({ store, workspaceId, workspaceDir, capability });

  const skillPath = path.join(workspaceDir, "skills", "competitor-analysis", "SKILL.md");
  assert.ok(fs.existsSync(skillPath), "SKILL.md should be written");
  const content = fs.readFileSync(skillPath, "utf8");
  assert.ok(content.includes("name: competitor-analysis"));

  assert.equal(result.integrationStatus.twitter, "needs_connection");
  assert.deepEqual(result.record.installedSkillIds, ["competitor-analysis"]);
  assert.equal(result.record.status, "active");

  assert.equal(
    fs.existsSync(path.join(workspaceDir, "AGENTS.md")),
    false,
    "capability install must not write into AGENTS.md",
  );

  const row = store.getWorkspaceCapability({ workspaceId, capabilityId: "competitor-watch" });
  assert.ok(row);
  assert.equal(row.integrationStatus.twitter, "needs_connection");

  store.close();
});

test("B2: installCapability reports connected when an active connection exists", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-2";
  const workspaceDir = path.join(root, "workspace", workspaceId);

  store.upsertIntegrationConnection({
    connectionId: "conn-twitter-1",
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "Team X",
    authMode: "oauth_app",
    grantedScopes: ["tweet.read"],
    status: "active",
  });

  const result = await installCapability({ store, workspaceId, workspaceDir, capability: competitorWatchCapability() });
  assert.equal(result.integrationStatus.twitter, "connected");

  store.close();
});

test("B2: re-install is idempotent (one row, one skill dir)", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-3";
  const workspaceDir = path.join(root, "workspace", workspaceId);
  const capability = competitorWatchCapability();

  await installCapability({ store, workspaceId, workspaceDir, capability });
  await installCapability({ store, workspaceId, workspaceDir, capability });

  assert.equal(store.listWorkspaceCapabilities({ workspaceId }).length, 1);
  const skillsRoot = path.join(workspaceDir, "skills");
  assert.deepEqual(fs.readdirSync(skillsRoot), ["competitor-analysis"]);

  assert.equal(fs.existsSync(path.join(workspaceDir, "AGENTS.md")), false);

  store.close();
});

test("B3: uninstallCapability removes skill dir and row", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-4";
  const workspaceDir = path.join(root, "workspace", workspaceId);
  const capability = competitorWatchCapability();

  await installCapability({ store, workspaceId, workspaceDir, capability });
  const removed = uninstallCapability({ store, workspaceId, workspaceDir, capabilityId: "competitor-watch" });

  assert.equal(removed, true);
  assert.equal(fs.existsSync(path.join(workspaceDir, "skills", "competitor-analysis")), false);
  assert.equal(store.getWorkspaceCapability({ workspaceId, capabilityId: "competitor-watch" }), null);

  store.close();
});

test("B4: capability MCP is written to workspace.yaml and removed on uninstall", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-mcp";
  const workspaceDir = path.join(root, "workspace", workspaceId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const capability: CapabilityDefinition = {
    id: "mcp-cap",
    name: "MCP Cap",
    description: "cap with mcp",
    skills: [],
    integrations: [],
    sourceDir: workspaceDir,
    mcp: {
      servers: [
        { id: "srv", type: "remote", url: "https://example.com/mcp", tools: ["do_thing"] },
      ],
    },
  };

  await installCapability({ store, workspaceId, workspaceDir, capability });

  const yamlPath = path.join(workspaceDir, "workspace.yaml");
  let doc = fs.readFileSync(yamlPath, "utf8");
  assert.match(doc, /mcp-cap__srv/, "server namespaced by capability id");
  assert.match(doc, /mcp-cap__srv\.do_thing/, "tool allowlisted");
  assert.match(doc, /example\.com\/mcp/, "remote url written");

  const row = store.getWorkspaceCapability({ workspaceId, capabilityId: "mcp-cap" });
  assert.ok(row);
  assert.equal(
    (row.config as Record<string, unknown>).mcp,
    undefined,
    "record no longer stores config.mcp",
  );

  uninstallCapability({ store, workspaceId, workspaceDir, capabilityId: "mcp-cap" });
  doc = fs.readFileSync(yamlPath, "utf8");
  assert.doesNotMatch(doc, /mcp-cap__srv/, "server + tools removed on uninstall");

  store.close();
});

test("B3: uninstall preserves shared skill dir (refcount)", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-5";
  const workspaceDir = path.join(root, "workspace", workspaceId);
  const capability = competitorWatchCapability();

  await installCapability({ store, workspaceId, workspaceDir, capability });

  store.createWorkspaceCapability({
    workspaceId,
    capabilityId: "other-capability",
    version: "0.1.0",
    name: "Other",
    installedSkillIds: ["competitor-analysis"],
  });

  uninstallCapability({ store, workspaceId, workspaceDir, capabilityId: "competitor-watch" });

  assert.ok(
    fs.existsSync(path.join(workspaceDir, "skills", "competitor-analysis", "SKILL.md")),
    "shared skill dir should survive while another capability references it",
  );
  assert.equal(store.getWorkspaceCapability({ workspaceId, capabilityId: "competitor-watch" }), null);

  store.close();
});

test("installWorkspaceAuthoredCapability installs a manifest written into the workspace", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-authored";
  const workspaceDir = path.join(root, "workspace", workspaceId);
  const capDir = path.join(workspaceDir, "capabilities", "linkedin-pipeline");
  fs.mkdirSync(capDir, { recursive: true });
  fs.writeFileSync(
    path.join(capDir, "capability.yaml"),
    [
      "id: linkedin-pipeline",
      "name: LinkedIn Pipeline",
      "description: LinkedIn content pipeline",
      "skills:",
      "  - ref: linkedin-weekly",
      "integrations:",
      "  - provider: linkedin",
      "    required: true",
      "    reason: Publishes the posts",
    ].join("\n"),
    "utf8",
  );

  const result = await installWorkspaceAuthoredCapability({
    store, workspaceId, workspaceDir, capabilityId: "linkedin-pipeline",
  });

  assert.equal(result.record.capabilityId, "linkedin-pipeline");
  assert.deepEqual(result.record.installedSkillIds, ["linkedin-weekly"]);
  assert.equal(result.integrationStatus.linkedin, "needs_connection");
  assert.equal(fs.existsSync(path.join(workspaceDir, "AGENTS.md")), false);
  store.close();
});

test("mcp: writes servers into workspace.yaml mcp_registry on install", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-mcp";
  const workspaceDir = path.join(root, "workspace", workspaceId);
  const capDir = path.join(workspaceDir, "capabilities", "x-poster");
  fs.mkdirSync(capDir, { recursive: true });
  fs.writeFileSync(
    path.join(capDir, "capability.yaml"),
    [
      "id: x-poster",
      "name: X Poster",
      "description: Post to X via MCP",
      "version: 0.1.0",
      "skills: []",
      "mcp:",
      "  servers:",
      "    - id: x",
      "      type: remote",
      "      url: https://mcp.example/sse",
      "      headers:",
      "        Authorization: Bearer abc",
      "      tools: [create_post, list_posts]",
      "    - id: local-helper",
      "      type: local",
      "      command: [node, server.js]",
      "      tools: [ping]",
    ].join("\n"),
    "utf8",
  );

  const result = await installWorkspaceAuthoredCapability({ store, workspaceId, workspaceDir, capabilityId: "x-poster" });

  // MCP is unified into workspace.yaml's mcp_registry (namespaced by capability
  // id), not stored on the record config.
  assert.equal((result.record.config as Record<string, unknown>).mcp, undefined);
  const doc = fs.readFileSync(path.join(workspaceDir, "workspace.yaml"), "utf8");
  assert.match(doc, /x-poster__x/, "remote server namespaced");
  assert.match(doc, /x-poster__x\.create_post/);
  assert.match(doc, /x-poster__x\.list_posts/);
  assert.match(doc, /Bearer abc/, "headers preserved");
  assert.match(doc, /x-poster__local-helper/, "local server namespaced");
  assert.match(doc, /x-poster__local-helper\.ping/);

  store.close();
});

test("mcp: remote server without url throws naming the field", async () => {
  const dir = makeTempDir("hb-capability-mcp-bad-");
  const badDir = path.join(dir, "broken");
  fs.mkdirSync(badDir, { recursive: true });
  const manifestPath = path.join(badDir, "capability.yaml");
  fs.writeFileSync(
    manifestPath,
    [
      "id: broken",
      "name: Broken",
      "description: missing url",
      "version: 1.0.0",
      "skills: []",
      "mcp:",
      "  servers:",
      "    - id: x",
      "      type: remote",
      "      tools: [a]",
    ].join("\n"),
    "utf8",
  );

  assert.throws(
    () => loadCapabilityCatalog({ dir }),
    (error: unknown) => error instanceof Error && /mcp.servers\[0\].url is required/.test(error.message),
  );
});

test("mcp: a malformed {env:...} placeholder is rejected at install, naming the field", async () => {
  const dir = makeTempDir("hb-capability-mcp-badenv-");
  const badDir = path.join(dir, "badenv");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(
    path.join(badDir, "capability.yaml"),
    [
      "id: badenv",
      "name: Bad Env",
      "description: invalid env placeholder",
      "version: 1.0.0",
      "skills: []",
      "mcp:",
      "  servers:",
      "    - id: x",
      "      type: remote",
      "      url: https://mcp.example/sse",
      "      headers:",
      '        Authorization: "{env:MY-TOKEN}"', // hyphen is not a valid env var name
      "      tools: [a]",
    ].join("\n"),
    "utf8",
  );

  assert.throws(
    () => loadCapabilityCatalog({ dir }),
    (error: unknown) =>
      error instanceof Error &&
      /invalid env placeholder/.test(error.message) &&
      /headers\.Authorization/.test(error.message),
  );
});

test("mcp: a valid {env:...} placeholder and a literal value install fine", async () => {
  const dir = makeTempDir("hb-capability-mcp-okenv-");
  const okDir = path.join(dir, "okenv");
  fs.mkdirSync(okDir, { recursive: true });
  fs.writeFileSync(
    path.join(okDir, "capability.yaml"),
    [
      "id: okenv",
      "name: Ok Env",
      "description: valid env placeholder plus literal header",
      "version: 1.0.0",
      "skills: []",
      "mcp:",
      "  servers:",
      "    - id: x",
      "      type: remote",
      "      url: https://mcp.example/sse",
      "      headers:",
      '        Authorization: "{env:MY_TOKEN}"', // valid
      '        X-Static: "literal-value"', // literal pass-through
      "      tools: [a]",
    ].join("\n"),
    "utf8",
  );

  const catalog = loadCapabilityCatalog({ dir });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].id, "okenv");
});

test("import-plugin: materializes a Claude plugin's skills as a capability", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-import";
  const workspaceDir = path.join(root, "workspace", workspaceId);

  const pluginDir = makeTempDir("hb-plugin-");
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "sales-pack",
      displayName: "Sales Pack",
      description: "Sales tooling",
    }),
    "utf8",
  );
  const skillDir = path.join(pluginDir, "skills", "prep-meeting");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: prep-meeting\ndescription: Prep for a meeting.\n---\n\n# Prep\n",
    "utf8",
  );

  const result = await importPluginAsCapability({
    store,
    workspaceId,
    workspaceDir,
    pluginPath: pluginDir,
  });

  assert.equal(result.record.name, "Sales Pack");
  assert.deepEqual(result.record.installedSkillIds, ["prep-meeting"]);
  assert.ok(
    fs.existsSync(path.join(workspaceDir, "skills", "prep-meeting", "SKILL.md")),
    "the plugin's skill should be materialized into the workspace",
  );

  store.close();
});

test("import-plugin: throws when there is no plugin manifest", async () => {
  const { store, root } = makeStore();
  const workspaceDir = path.join(root, "workspace", "ws-import-2");
  const emptyDir = makeTempDir("hb-plugin-empty-");
  assert.throws(
    () =>
      importPluginAsCapability({
        store,
        workspaceId: "ws-import-2",
        workspaceDir,
        pluginPath: emptyDir,
      }),
    /no plugin manifest/,
  );
  store.close();
});

test("B4: setCapabilityEnabled flips status without touching files", async () => {
  const { store, root } = makeStore();
  const workspaceId = "ws-6";
  const workspaceDir = path.join(root, "workspace", workspaceId);
  const capability = competitorWatchCapability();

  await installCapability({ store, workspaceId, workspaceDir, capability });

  const disabled = setCapabilityEnabled({ store, workspaceId, capabilityId: "competitor-watch", enabled: false });
  assert.equal(disabled?.status, "disabled");
  assert.ok(
    fs.existsSync(path.join(workspaceDir, "skills", "competitor-analysis", "SKILL.md")),
    "files should be untouched on disable",
  );

  const enabled = setCapabilityEnabled({ store, workspaceId, capabilityId: "competitor-watch", enabled: true });
  assert.equal(enabled?.status, "active");

  store.close();
});
