import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  capabilityToolResultModeFromHeaders,
  shapeCapabilityToolResultPayload,
  TOOL_RESULT_MODE_HEADER,
  TOOL_RESULT_MODE_PREVIEW,
  TOOL_RESULT_PREVIEW_SHAPING_ENV,
} from "./tool-result-preview.js";

function makeWorkspaceRoot(prefix: string): {
  root: string;
  workspaceRoot: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "workspace-1"), { recursive: true });
  return {
    root,
    workspaceRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("capabilityToolResultModeFromHeaders returns preview when requested", () => {
  assert.equal(
    capabilityToolResultModeFromHeaders({
      [TOOL_RESULT_MODE_HEADER]: TOOL_RESULT_MODE_PREVIEW,
    }),
    "preview",
  );
  assert.equal(
    capabilityToolResultModeFromHeaders({
      [TOOL_RESULT_MODE_HEADER]: "default",
    }),
    "default",
  );
});

test("shapeCapabilityToolResultPayload spills browser screenshots in preview mode", async () => {
  const fixture = makeWorkspaceRoot("hb-tool-preview-browser-");
  try {
    const payload = await shapeCapabilityToolResultPayload({
      mode: "preview",
      toolId: "browser_get_state",
      workspaceRoot: fixture.workspaceRoot,
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: {
        ok: true,
        state: {
          text: "x".repeat(2500),
          elements_offset: 40,
          elements_total: 120,
          elements_has_more: true,
          next_elements_offset: 65,
          elements: Array.from({ length: 25 }, (_, index) => ({ index: index + 1 })),
          media_offset: 10,
          media_total: 45,
          media_has_more: true,
          next_media_offset: 25,
          media: Array.from({ length: 15 }, (_, index) => ({ index: index + 1 })),
        },
        screenshot: {
          mimeType: "image/png",
          base64: Buffer.from("image-bytes", "utf8").toString("base64"),
        },
      },
    });
    assert.ok(payload && typeof payload === "object");
    const shaped = payload as Record<string, unknown>;
    const screenshot = shaped.screenshot as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(screenshot, "base64"), false);
    assert.match(String(screenshot.file_path ?? ""), /^\.holaboss\/state\/tool-results\/browser_get_state\//);
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.workspaceRoot,
          "workspace-1",
          String(screenshot.file_path ?? ""),
        ),
      ),
      true,
    );
    const state = shaped.state as Record<string, unknown>;
    assert.equal((state.elements as unknown[]).length, 20);
    assert.equal((state.media as unknown[]).length, 12);
    assert.equal(state.elements_offset, 40);
    assert.equal(state.elements_total, 120);
    assert.equal(state.elements_has_more, true);
    assert.equal(state.next_elements_offset, 60);
    assert.equal(state.media_offset, 10);
    assert.equal(state.media_total, 45);
    assert.equal(state.media_has_more, true);
    assert.equal(state.next_media_offset, 22);
    assert.match(String(shaped.full_state_path ?? ""), /^\.holaboss\/state\/tool-results\/browser_get_state\//);
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.workspaceRoot,
          "workspace-1",
          String(shaped.full_state_path ?? ""),
        ),
      ),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test("shapeCapabilityToolResultPayload clips and spills terminal events in preview mode", async () => {
  const fixture = makeWorkspaceRoot("hb-tool-preview-terminal-");
  try {
    const events = Array.from({ length: 60 }, (_, index) => ({
      sequence: index + 1,
      payload: { text: `line-${index + 1}:${"x".repeat(900)}` },
    }));
    const payload = await shapeCapabilityToolResultPayload({
      mode: "preview",
      toolId: "terminal_session_read",
      workspaceRoot: fixture.workspaceRoot,
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: {
        terminal: { terminal_id: "term-1" },
        events,
        count: events.length,
        after_sequence: 0,
        has_more: true,
        next_after_sequence: 60,
        remaining_event_count: 25,
        latest_event_sequence: 85,
      },
    });
    assert.ok(payload && typeof payload === "object");
    const shaped = payload as Record<string, unknown>;
    assert.equal((shaped.events as unknown[]).length, 40);
    assert.equal(shaped.count, 40);
    assert.equal(shaped.total_event_count, 60);
    assert.equal(shaped.has_more, true);
    assert.equal(shaped.next_after_sequence, 40);
    assert.equal(shaped.remaining_event_count, 45);
    assert.match(String(shaped.full_events_path ?? ""), /^\.holaboss\/state\/tool-results\/terminal_session_read\//);
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.workspaceRoot,
          "workspace-1",
          String(shaped.full_events_path ?? ""),
        ),
      ),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test("shapeCapabilityToolResultPayload honors preview shaping kill switch", async () => {
  const previous = process.env[TOOL_RESULT_PREVIEW_SHAPING_ENV];
  process.env[TOOL_RESULT_PREVIEW_SHAPING_ENV] = "off";
  try {
    const source = {
      text: "x".repeat(40000),
      provider: "exa",
    };
    const payload = await shapeCapabilityToolResultPayload({
      mode: "preview",
      toolId: "web_search",
      workspaceRoot: "/tmp/unused",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: source,
    });
    assert.deepEqual(payload, source);
  } finally {
    if (previous === undefined) {
      delete process.env[TOOL_RESULT_PREVIEW_SHAPING_ENV];
    } else {
      process.env[TOOL_RESULT_PREVIEW_SHAPING_ENV] = previous;
    }
  }
});
