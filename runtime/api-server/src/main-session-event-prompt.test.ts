import assert from "node:assert/strict";
import test from "node:test";

import { queuedMainSessionEventPromptEntry } from "./main-session-event-prompt.js";

test("queued main-session event prompt entry ignores raw child assistant text", () => {
  const entry = queuedMainSessionEventPromptEntry({
    event_id: "event-1",
    event_type: "completed",
    delivery_bucket: "background_update",
    status: "pending",
    subagent_id: "subagent-1",
    created_at: "2026-04-29T00:00:00.000Z",
    payload: {
      status: "completed",
      summary: "Repo scan finished.",
      assistant_text:
        "<html><body><h1>Full report body</h1><p>This should stay out of the main-session prompt.</p></body></html>",
    },
  });

  const payload = entry.payload as Record<string, unknown>;

  assert.equal(payload.assistant_text, undefined);
  assert.equal(payload.summary, "Repo scan finished.");
});

test("queued main-session event prompt entry forwards summary and deliverables without child assistant text", () => {
  const entry = queuedMainSessionEventPromptEntry({
    event_id: "event-2",
    event_type: "completed",
    delivery_bucket: "background_update",
    status: "pending",
    subagent_id: "subagent-2",
    created_at: "2026-04-29T00:00:00.000Z",
    payload: {
      status: "completed",
      summary: "Hourly AI news run came in.",
      assistant_text:
        "Here are the items I found:\n1. OpenAI expands on AWS Bedrock.\n2. AI regulation is still unsettled.\n3. Government AI deployment keeps moving.",
      forwardable_deliverables: [
        {
          output_id: "output-1",
          type: "report",
          title: "hourly-ai-news.md",
          module_id: "twitter",
          module_resource_id: "post-123",
          platform: "twitter",
          metadata: {
            artifact_type: "draft",
            presentation: {
              kind: "app_resource",
              view: "posts",
              path: "/posts/post-123",
            },
            resource: {
              entity_type: "post",
              entity_id: "post-123",
              label: "hello",
            },
          },
        },
      ],
    },
  });

  const payload = entry.payload as Record<string, unknown>;

  assert.equal(payload.assistant_text, undefined);
  assert.equal(payload.summary, "Hourly AI news run came in.");
  assert.deepEqual(payload.forwardable_deliverables, [
    {
      output_id: "output-1",
      type: "report",
      title: "hourly-ai-news.md",
      module_id: "twitter",
      module_resource_id: "post-123",
      platform: "twitter",
      metadata: {
        artifact_type: "draft",
        presentation: {
          kind: "app_resource",
          view: "posts",
          path: "/posts/post-123",
        },
        resource: {
          entity_type: "post",
          entity_id: "post-123",
          label: "hello",
        },
      },
    },
  ]);
});

test("queued main-session event prompt entry preserves task references for follow-up inspection", () => {
  const entry = queuedMainSessionEventPromptEntry({
    event_id: "event-3",
    event_type: "completed",
    delivery_bucket: "background_update",
    status: "pending",
    subagent_id: "subagent-3",
    created_at: "2026-04-29T00:00:00.000Z",
    payload: {
      source_type: "delegate_task",
      source_id: "HOL-7",
      issue_id: "HOL-7",
      status: "completed",
      summary: "Dashboard polish finished.",
    },
  });

  const payload = entry.payload as Record<string, unknown>;

  assert.equal(payload.source_type, "delegate_task");
  assert.equal(payload.source_id, "HOL-7");
  assert.equal(payload.issue_id, "HOL-7");
  assert.equal(payload.summary, "Dashboard polish finished.");
});

test("queued main-session event prompt entry preserves edited file paths for follow-up routing", () => {
  const entry = queuedMainSessionEventPromptEntry({
    event_id: "event-4",
    event_type: "completed",
    delivery_bucket: "background_update",
    status: "pending",
    subagent_id: "subagent-4",
    created_at: "2026-04-29T00:00:00.000Z",
    payload: {
      status: "completed",
      summary: "Updated apps/desktop/src/App.tsx.",
      edited_files: [
        "apps/desktop/src/App.tsx",
        "apps/desktop/src/App.tsx",
        "runtime/api-server/src/claimed-input-executor.ts",
      ],
    },
  });

  const payload = entry.payload as Record<string, unknown>;

  assert.deepEqual(payload.edited_files, [
    "apps/desktop/src/App.tsx",
    "runtime/api-server/src/claimed-input-executor.ts",
  ]);
});
