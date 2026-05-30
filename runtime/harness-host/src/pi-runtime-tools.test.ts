import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { RUNTIME_AGENT_TOOL_IDS } from "../../harnesses/src/runtime-agent-tools.js";
import { resolvePiRuntimeToolDefinitions } from "./pi-runtime-tools.js";

test("resolvePiRuntimeToolDefinitions returns empty when runtime api url is unavailable", async () => {
  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "",
  });

  assert.deepEqual(tools, []);
});

test("resolvePiRuntimeToolDefinitions returns empty when runtime tools capability is unavailable", async () => {
  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    fetchImpl: async () =>
      new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  });

  assert.deepEqual(tools, []);
});

test("Pi runtime tools execute through the local runtime capability API", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    selectedModel: string;
    resultMode: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      selectedModel: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-selected-model"] ?? ""
      ),
      resultMode: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-tool-result-mode"] ?? ""
      ),
      body,
    });

    if (url.endsWith("/api/v1/capabilities/runtime-tools/onboarding/complete")) {
      return new Response(JSON.stringify({ onboarding_status: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    selectedModel: "openai/gpt-5.4",
    fetchImpl,
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...RUNTIME_AGENT_TOOL_IDS]
  );

  const completeTool = tools.find((tool) => tool.name === "holaboss_onboarding_complete");
  assert.ok(completeTool);
  const result = await completeTool.execute(
    "call-1",
    { summary: "ready to work", requested_by: "workspace_agent" },
    undefined,
    undefined,
    {} as never
  );

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/onboarding/complete",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      resultMode: "preview",
      body: JSON.stringify({ summary: "ready to work", requested_by: "workspace_agent" }),
    },
  ]);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, JSON.stringify({ onboarding_status: "completed" }, null, 2));
  assert.deepEqual(result.details, { tool_id: "holaboss_onboarding_complete" });
});

test("Pi runtime tools compact large capability results and preserve raw details", async () => {
  const largeBody = "search-result ".repeat(4000);
  const payload = { ok: true, results: [{ title: "Large result", body: largeBody }] };
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.endsWith("/api/v1/capabilities/runtime-tools/web-search")) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    fetchImpl,
  });
  const searchTool = tools.find((tool) => tool.name === "web_search");
  assert.ok(searchTool);

  const result = await searchTool.execute("call-1", { query: "large" }, undefined, undefined, {} as never);
  assert.equal(result.content[0]?.type, "text");
  assert.ok((result.content[0]?.text.length ?? 0) < largeBody.length);

  const envelope = JSON.parse(String(result.content[0]?.text ?? "")) as {
    tool_result_format?: string;
    status?: string;
    ok?: boolean;
    serialized_bytes?: number;
    raw_result?: { stored_in?: string };
  };
  assert.equal(envelope.tool_result_format, "compact_envelope");
  assert.equal(envelope.status, "truncated");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.raw_result?.stored_in, "tool_result.details.raw");
  assert.equal(typeof envelope.serialized_bytes, "number");
  assert.ok((envelope.serialized_bytes ?? 0) > 32768);

  const details = result.details as {
    tool_id?: string;
    raw?: unknown;
    raw_result_bytes?: number;
    model_result_bytes?: number;
  };
  assert.equal(details.tool_id, "web_search");
  assert.deepEqual(details.raw, payload);
  assert.equal(details.raw_result_bytes, envelope.serialized_bytes);
  assert.equal(details.model_result_bytes, new TextEncoder().encode(result.content[0]?.text ?? "").length);
});

test("Pi memory_retrieve tool executes through the local runtime capability API", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    selectedModel: string;
    resultMode: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      selectedModel: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-selected-model"] ?? ""
      ),
      resultMode: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-tool-result-mode"] ?? ""
      ),
      body,
    });

    if (url.endsWith("/api/v1/capabilities/runtime-tools/memory/retrieve")) {
      return new Response(JSON.stringify({ tool_id: "memory_retrieve", hits: [{ title: "Orchid customer escalation contact" }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    selectedModel: "openai/gpt-5.4",
    fetchImpl,
  });

  const memoryTool = tools.find((tool) => tool.name === "memory_retrieve");
  assert.ok(memoryTool);
  const result = await memoryTool.execute(
    "call-1",
    {
      query: "Orchid customer escalation contact",
      mode: "mixed",
      max_results: 10,
    },
    undefined,
    undefined,
    {} as never
  );

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/memory/retrieve",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      resultMode: "preview",
      body: JSON.stringify({
        query: "Orchid customer escalation contact",
        mode: "mixed",
        max_results: 10,
      }),
    },
  ]);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(
    result.content[0]?.text,
    JSON.stringify({ tool_id: "memory_retrieve", hits: [{ title: "Orchid customer escalation contact" }] }, null, 2),
  );
  assert.deepEqual(result.details, { tool_id: "memory_retrieve" });
});

test("Pi runtime cronjob tools send instruction separately from description", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    selectedModel: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      selectedModel: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-selected-model"] ?? ""
      ),
      body,
    });

    return new Response(JSON.stringify({ delivery: { channel: "session_run", mode: "announce" } }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    selectedModel: "openai/gpt-5.4",
    fetchImpl,
  });

  const createTool = tools.find((tool) => tool.name === "cronjobs_create");
  assert.ok(createTool);

  const result = await createTool.execute(
    "call-1",
    {
      cron: "*/5 * * * *",
      teammate_id: "general",
      description: "Say hello every 5 minutes.",
      instruction: "Say hello.",
      delivery_channel: "session_run",
      delivery_mode: "deliver",
    },
    undefined,
    undefined,
    {} as never
  );

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/cronjobs",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      body: JSON.stringify({
        cron: "*/5 * * * *",
        description: "Say hello every 5 minutes.",
        instruction: "Say hello.",
        teammate_id: "general",
        delivery: { channel: "session_run", mode: "announce" },
      }),
    },
  ]);
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : undefined,
    JSON.stringify({ delivery: { channel: "session_run", mode: "deliver" } }, null, 2),
  );
});

test("Pi runtime cronjob tools expose only allowed delivery enum values", async () => {
  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    fetchImpl: async () =>
      new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  });

  const createTool = tools.find((tool) => tool.name === "cronjobs_create");
  const updateTool = tools.find((tool) => tool.name === "cronjobs_update");
  assert.ok(createTool);
  assert.ok(updateTool);

  const createDeliveryModeValues =
    (
      (createTool.parameters.properties.delivery_mode as { anyOf?: Array<{ const?: string }> } | undefined)?.anyOf ?? []
    ).map((item) => item.const);
  const createDeliveryChannelValues =
    (
      (createTool.parameters.properties.delivery_channel as { anyOf?: Array<{ const?: string }> } | undefined)
        ?.anyOf ?? []
    ).map((item) => item.const);
  const updateDeliveryModeValues =
    (
      (updateTool.parameters.properties.delivery_mode as { anyOf?: Array<{ const?: string }> } | undefined)?.anyOf ?? []
    ).map((item) => item.const);
  const updateDeliveryChannelValues =
    (
      (updateTool.parameters.properties.delivery_channel as { anyOf?: Array<{ const?: string }> } | undefined)
        ?.anyOf ?? []
    ).map((item) => item.const);

  assert.deepEqual(createDeliveryModeValues, ["deliver", "none"]);
  assert.deepEqual(createDeliveryChannelValues, ["system_notification", "session_run"]);
  assert.deepEqual(updateDeliveryModeValues, ["deliver", "none"]);
  assert.deepEqual(updateDeliveryChannelValues, ["system_notification", "session_run"]);
});

test("Pi runtime teammate_skills_create schema avoids top-level combinators for provider compatibility", async () => {
  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    fetchImpl: async () =>
      new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  });

  const createSkillTool = tools.find((tool) => tool.name === "teammate_skills_create");
  assert.ok(createSkillTool);
  assert.equal(createSkillTool.parameters.type, "object");
  assert.ok(!("anyOf" in createSkillTool.parameters));
  assert.ok(!("oneOf" in createSkillTool.parameters));
  assert.ok(!("allOf" in createSkillTool.parameters));
  assert.deepEqual(createSkillTool.parameters.required, ["teammate_id"]);
  assert.equal(
    (createSkillTool.parameters.properties.payload_mode as { description?: string } | undefined)?.description?.includes("SKILL.md"),
    true,
  );
});

test("Pi runtime subagent tools normalize delegated task bodies and control routes", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      body: init?.body ? String(init.body) : "",
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    fetchImpl,
  });

  const delegateTool = tools.find((tool) => tool.name === "delegate_task");
  const getTaskTool = tools.find((tool) => tool.name === "get_task");
  const listTasksTool = tools.find((tool) => tool.name === "list_tasks");
  const replyTaskTool = tools.find((tool) => tool.name === "reply_task");
  const cancelTaskTool = tools.find((tool) => tool.name === "cancel_task");
  const rerunTaskTool = tools.find((tool) => tool.name === "rerun_task");
  assert.ok(delegateTool);
  assert.ok(getTaskTool);
  assert.ok(listTasksTool);
  assert.ok(replyTaskTool);
  assert.ok(cancelTaskTool);
  assert.ok(rerunTaskTool);
  assert.deepEqual(delegateTool.parameters.required, ["tasks"]);
  assert.deepEqual(
    (
      delegateTool.parameters.properties.tasks as {
        items?: { required?: string[] };
      }
    ).items?.required,
    ["teammate_id", "goal"],
  );

  await delegateTool.execute(
    "call-1",
    {
      teammate_id: "general",
      goal: "Research topic A",
      context: "Focus on recent changes.",
      tools: ["web", "browser"],
    },
    undefined,
    undefined,
    {} as never,
  );
  await getTaskTool.execute(
    "call-2b",
    {
      task_id: "HOL-1",
    },
    undefined,
    undefined,
    {} as never,
  );
  await listTasksTool.execute(
    "call-2c",
    {
      statuses: ["todo", "blocked"],
      limit: 10,
    },
    undefined,
    undefined,
    {} as never,
  );
  await replyTaskTool.execute(
    "call-2d",
    {
      task_id: "HOL-1",
      text: "Use the user's answer and continue.",
      priority: 3,
    },
    undefined,
    undefined,
    {} as never,
  );
  await cancelTaskTool.execute(
    "call-3b",
    {
      task_id: "HOL-1",
    },
    undefined,
    undefined,
    {} as never,
  );
  await rerunTaskTool.execute(
    "call-4b",
    {
      task_id: "HOL-1",
      model: "openai/gpt-5.5",
      priority: 7,
    },
    undefined,
    undefined,
    {} as never,
  );
  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/subagents",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      body: JSON.stringify({
        tasks: [
          {
            teammate_id: "general",
            goal: "Research topic A",
            context: "Focus on recent changes.",
            tools: ["web", "browser"],
          },
        ],
      }),
    },
    {
      method: "GET",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/tasks/HOL-1",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      body: "",
    },
    {
      method: "GET",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/tasks?statuses=todo&statuses=blocked&limit=10",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      body: "",
    },
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/tasks/HOL-1/reply",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      body: JSON.stringify({
        text: "Use the user's answer and continue.",
        priority: 3,
      }),
    },
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/tasks/HOL-1/cancel",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      body: JSON.stringify({}),
    },
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/tasks/HOL-1/rerun",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      body: JSON.stringify({
        model: "openai/gpt-5.5",
        priority: 7,
      }),
    },
  ]);
});

test("Pi runtime image generation tool forwards prompt and optional output settings", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    selectedModel: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      selectedModel: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-selected-model"] ?? ""
      ),
      body,
    });

    return new Response(JSON.stringify({ file_path: "outputs/images/cover.png" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    selectedModel: "openai/gpt-5.4",
    fetchImpl,
  });

  const generateTool = tools.find((tool) => tool.name === "image_generate");
  assert.ok(generateTool);

  await generateTool.execute(
    "call-1",
    {
      prompt: "A product hero image with a clean studio background.",
      filename: "cover-shot",
      size: "1024x1024",
    },
    undefined,
    undefined,
    {} as never
  );

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/images/generate",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      body: JSON.stringify({
        prompt: "A product hero image with a clean studio background.",
        filename: "cover-shot",
        size: "1024x1024",
      }),
    },
  ]);
});

test("Pi runtime image generation tool uses an extended timeout budget", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeoutCalls: number[] = [];
  const timeoutSignal = new AbortController().signal;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    writable: true,
    value: (ms: number) => {
      timeoutCalls.push(ms);
      return timeoutSignal;
    },
  });

  try {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
        return new Response(JSON.stringify({ available: true }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify({ file_path: "outputs/images/dog.png" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };

    const tools = await resolvePiRuntimeToolDefinitions({
      runtimeApiBaseUrl: "http://127.0.0.1:5060",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      fetchImpl,
    });

    const generateTool = tools.find((tool) => tool.name === "image_generate");
    assert.ok(generateTool);

    await generateTool.execute(
      "call-1",
      {
        prompt: "A friendly dog portrait.",
      },
      undefined,
      undefined,
      {} as never,
    );

    assert.ok(timeoutCalls.includes(180000));
  } finally {
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      writable: true,
      value: originalTimeout,
    });
  }
});

test("Pi runtime download_url tool forwards remote download parameters and guidance", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    selectedModel: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      selectedModel: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-selected-model"] ?? ""
      ),
      body,
    });

    return new Response(JSON.stringify({ file_path: "Downloads/cover.png" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    selectedModel: "openai/gpt-5.4",
    fetchImpl,
  });

  const downloadTool = tools.find((tool) => tool.name === "download_url");
  assert.ok(downloadTool);

  await downloadTool.execute(
    "call-1",
    {
      url: "https://example.com/assets/cover.png",
      output_path: "assets/reference/cover",
      expected_mime_prefix: "image/",
      overwrite: true,
    },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/downloads",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      body: JSON.stringify({
        url: "https://example.com/assets/cover.png",
        output_path: "assets/reference/cover",
        expected_mime_prefix: "image/",
        overwrite: true,
      }),
    },
  ]);

  assert.match(
    (downloadTool.promptGuidelines ?? []).join("\n"),
    /Use `download_url` when you already have a direct asset URL and need the file saved into the workspace\./,
  );
  assert.match(
    (downloadTool.promptGuidelines ?? []).join("\n"),
    /Prefer `download_url` over browser-only downloads or ad hoc shell fetches for straightforward remote file saves\./,
  );
});

test("Pi runtime update_workspace_instructions tool exposes exact op guidance", async () => {
  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    fetchImpl: async () =>
      new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  });

  const updateTool = tools.find((tool) => tool.name === "update_workspace_instructions");
  assert.ok(updateTool);
  assert.match(
    updateTool.description ?? "",
    /Valid `op` values are `read_current`, `append_rule`, `remove_rule`, and `replace_managed_section`; use `read_current` for reads, not `read`\./,
  );
  const promptGuidelines = (updateTool.promptGuidelines ?? []).join("\n");
  assert.match(
    promptGuidelines,
    /Valid `op` values are exactly `read_current`, `append_rule`, `remove_rule`, and `replace_managed_section`\./,
  );
  assert.match(
    promptGuidelines,
    /Do not invent alias op names such as `read`; the read operation is `read_current`\./,
  );
});

test("Pi runtime write_report tool forwards report content and current run headers", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    inputId: string;
    selectedModel: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      inputId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-input-id"] ?? ""),
      selectedModel: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-selected-model"] ?? ""
      ),
      body,
    });

    return new Response(JSON.stringify({ file_path: "outputs/reports/tariffs.md" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    selectedModel: "openai/gpt-5.4",
    fetchImpl,
  });

  const writeReportTool = tools.find((tool) => tool.name === "write_report");
  assert.ok(writeReportTool);

  await writeReportTool.execute(
    "call-1",
    {
      title: "Tariff brief",
      filename: "tariffs",
      summary: "Short current tariff summary.",
      content: "# Tariff brief\n\n- Court cases continue.\n",
    },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/reports",
  );
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.workspaceId, "workspace-1");
  assert.equal(requests[0]?.sessionId, "session-main");
  assert.equal(requests[0]?.inputId, "input-1");
  assert.equal(requests[0]?.selectedModel, "openai/gpt-5.4");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    title: "Tariff brief",
    filename: "tariffs",
    summary: "Short current tariff summary.",
    content: "# Tariff brief\n\n- Court cases continue.\n",
  });

  assert.match(
    (writeReportTool.promptGuidelines ?? []).join("\n"),
    /Use `write_report` for research summaries, investigations, audits, plans, reviews, comparisons, timelines, and other long or evidence-heavy answers/
  );
  assert.match(
    (writeReportTool.promptGuidelines ?? []).join("\n"),
    /Do not use `write_report` for a simple fact lookup, definition, brief clarification, current-page answer, or any other reply that is naturally short and self-contained/
  );
  assert.match(
    (writeReportTool.promptGuidelines ?? []).join("\n"),
    /Prefer `write_report` when you are synthesizing multiple sources, summarizing current or latest developments, or producing findings the user may want to reference later/
  );
  assert.match(
    (writeReportTool.promptGuidelines ?? []).join("\n"),
    /If the user explicitly asked for research, latest news, analysis, comparison, or a timeline and you gathered findings from multiple sources, call `write_report` before your final answer/
  );
  assert.match(
    (writeReportTool.promptGuidelines ?? []).join("\n"),
    /A step like 'summarize findings for the user' still means: save the full findings with `write_report`, then keep the chat reply brief/
  );
});

test("Pi runtime tools fall back to node http when no fetch implementation is provided", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    selectedModel: string;
    body: string;
  }> = [];
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url === "/api/v1/capabilities/runtime-tools") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ available: true }));
      return;
    }

    if (request.method === "POST" && url === "/api/v1/capabilities/runtime-tools/onboarding/complete") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          method: request.method ?? "GET",
          url,
          workspaceId: String(request.headers["x-holaboss-workspace-id"] ?? ""),
          sessionId: String(request.headers["x-holaboss-session-id"] ?? ""),
          selectedModel: String(request.headers["x-holaboss-selected-model"] ?? ""),
          body,
        });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ onboarding_status: "completed" }));
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ detail: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runtimeApiBaseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const tools = await resolvePiRuntimeToolDefinitions({
      runtimeApiBaseUrl,
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
    });
    const completeTool = tools.find((tool) => tool.name === "holaboss_onboarding_complete");
    assert.ok(completeTool);

    const result = await completeTool.execute(
      "call-1",
      { summary: "ready to work" },
      undefined,
      undefined,
      {} as never
    );

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/api/v1/capabilities/runtime-tools/onboarding/complete",
        workspaceId: "workspace-1",
        sessionId: "session-main",
        selectedModel: "openai/gpt-5.4",
        body: JSON.stringify({ summary: "ready to work" }),
      },
    ]);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, JSON.stringify({ onboarding_status: "completed" }, null, 2));
    assert.deepEqual(result.details, { tool_id: "holaboss_onboarding_complete" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Pi runtime terminal session tools proxy terminal session routes and include terminal guidance", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    selectedModel: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      selectedModel: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-selected-model"] ?? ""
      ),
      body,
    });

    return new Response(JSON.stringify({ terminal_id: "term-1", timed_out: false, count: 1 }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    selectedModel: "openai/gpt-5.4",
    fetchImpl,
  });

  const startTool = tools.find((tool) => tool.name === "terminal_session_start");
  const waitTool = tools.find((tool) => tool.name === "terminal_session_wait");
  const sendInputTool = tools.find((tool) => tool.name === "terminal_session_send_input");
  assert.ok(startTool);
  assert.ok(waitTool);
  assert.ok(sendInputTool);

  await startTool.execute(
    "call-1",
    {
      command: "npm run dev",
      title: "Dev server",
      cwd: "apps/web",
      cols: 140,
      rows: 40,
    },
    undefined,
    undefined,
    {} as never,
  );
  await waitTool.execute(
    "call-2",
    {
      terminal_id: "term-1",
      after_sequence: 2,
      timeout_ms: 5000,
    },
    undefined,
    undefined,
    {} as never,
  );
  await sendInputTool.execute(
    "call-3",
    {
      terminal_id: "term-1",
      data: "rs\n",
    },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/terminal-sessions",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      body: JSON.stringify({
        command: "npm run dev",
        title: "Dev server",
        cwd: "apps/web",
        cols: 140,
        rows: 40,
      }),
    },
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/terminal-sessions/term-1/wait",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      body: JSON.stringify({
        after_sequence: 2,
        timeout_ms: 5000,
      }),
    },
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/terminal-sessions/term-1/input",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      body: JSON.stringify({
        data: "rs\n",
      }),
    },
  ]);

  assert.match(
    (startTool.promptGuidelines ?? []).join("\n"),
    /Prefer `bash` for short one-shot commands that should complete within the current tool call\./,
  );
  assert.match(
    (startTool.promptGuidelines ?? []).join("\n"),
    /Prefer background terminal sessions for long-running commands, dev servers, watch processes, interactive prompts, or work you may need to revisit later in the run\./,
  );
  assert.match(
    (startTool.promptGuidelines ?? []).join("\n"),
    /After starting a terminal session, use `terminal_session_read` or `terminal_session_wait` to inspect output before claiming success\./,
  );
});

test("Pi runtime web_search tool forwards pagination window params", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    selectedModel: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      selectedModel: String(
        (init?.headers as Record<string, string> | undefined)?.["x-holaboss-selected-model"] ?? ""
      ),
      body,
    });

    return new Response(JSON.stringify({ text: "ok", tool_id: "web_search" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const tools = await resolvePiRuntimeToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    selectedModel: "openai/gpt-5.4",
    fetchImpl,
  });

  const webSearchTool = tools.find((tool) => tool.name === "web_search");
  assert.ok(webSearchTool);

  await webSearchTool.execute(
    "call-1",
    {
      query: "trade policy updates 2026",
      num_results: 6,
      text_offset: 8000,
      text_limit: 2000,
    },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/web-search",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      selectedModel: "openai/gpt-5.4",
      body: JSON.stringify({
        query: "trade policy updates 2026",
        num_results: 6,
        text_offset: 8000,
        text_limit: 2000,
      }),
    },
  ]);
});
