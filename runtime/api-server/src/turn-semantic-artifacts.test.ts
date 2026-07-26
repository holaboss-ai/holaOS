import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type { OutputEventRecord, RuntimeStateStore, TurnResultRecord } from "@holaboss/runtime-state-store";

import {
  attachmentEvidenceFromTurnInput,
  integrationToolEvidenceEntriesFromTurnArtifacts,
  integrationToolEvidenceFromTurnArtifacts,
} from "./turn-semantic-artifacts.js";

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

test("integrationToolEvidenceFromTurnArtifacts summarizes completed integration tool results", () => {
  const store = {
    listOutputEvents: () => [
      {
        id: 1,
        workspaceId: "workspace-1",
        sessionId: "session-main",
        inputId: "input-3",
        eventType: "tool_call",
        sequence: 1,
        payload: {
          phase: "completed",
          tool_name: "holaboss_composio.gmail_fetch_emails",
          tool_id: "holaboss_composio.gmail_fetch_emails",
          error: false,
          result: {
            content: [
              {
                type: "text",
                text: "Acme pricing review moved to Friday. Emily Stone asked for the renewal deck.",
              },
            ],
            details: {
              raw: {
                _meta: {
                  holaboss_integration_account: {
                    provider_id: "gmail",
                    connected_account_id: "ca_gmail_primary",
                    account_namespace: "ops@example.com",
                    connection_id: "conn_gmail_primary",
                  },
                },
              },
            },
          },
        },
        createdAt: "2026-06-02T00:00:00.000Z",
      },
      {
        id: 2,
        workspaceId: "workspace-1",
        sessionId: "session-main",
        inputId: "input-3",
        eventType: "tool_call",
        sequence: 2,
        payload: {
          phase: "completed",
          tool_name: "read_file",
          error: false,
          result: {
            content: [{ type: "text", text: "local file contents" }],
          },
        },
        createdAt: "2026-06-02T00:00:01.000Z",
      },
    ] satisfies OutputEventRecord[],
  } as unknown as Pick<RuntimeStateStore, "listOutputEvents"> as RuntimeStateStore;

  const turnResult = {
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-3",
  } as TurnResultRecord;

  const entries = integrationToolEvidenceEntriesFromTurnArtifacts(store, turnResult);
  const lines = integrationToolEvidenceFromTurnArtifacts(store, turnResult);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.providerId, "gmail");
  assert.equal(entries[0]?.accountNamespace, "ops@example.com");
  assert.equal(entries[0]?.connectionId, "conn_gmail_primary");
  assert.equal(entries[0]?.toolName, "holaboss_composio.gmail_fetch_emails");
  assert.equal(entries[0]?.callId, null);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0] ?? "",
    /\[gmail ops@example\.com\] holaboss_composio\.gmail_fetch_emails => Acme pricing review moved to Friday/,
  );
});

test("attachmentEvidenceFromTurnInput summarizes attachment metadata and text previews", () => {
  const workspaceRoot = makeTempDir("hb-turn-artifacts-attachments-");
  const workspaceDir = path.join(workspaceRoot, "workspace-1");
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "input-attachments", "batch-1"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, ".holaboss", "input-attachments", "batch-1", "report.html"),
    "<html><body><h1>AWS budget alert</h1><p>Account 423623864703 exceeded the zero-spend threshold.</p></body></html>",
    "utf8",
  );
  const store = {
    workspaceDir: () => workspaceDir,
    getInput: () => ({
      payload: {
        attachments: [
          {
            id: "att-1",
            kind: "file",
            name: "report.html",
            mime_type: "text/html",
            size_bytes: 128,
            workspace_path: ".holaboss/input-attachments/batch-1/report.html",
          },
        ],
      },
    }),
  } as unknown as Pick<RuntimeStateStore, "workspaceDir" | "getInput"> as RuntimeStateStore;
  const turnResult = {
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-7",
  } as TurnResultRecord;

  const lines = attachmentEvidenceFromTurnInput(store, turnResult);

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /report\.html \[file, text\/html\]/);
  assert.match(lines[0] ?? "", /AWS budget alert/);
  assert.match(lines[0] ?? "", /423623864703 exceeded the zero-spend threshold/);
});
