import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { IncomingMessage } from "../connector.js";
import { ChannelEgress } from "../egress.js";
import { ChannelIngress } from "../ingress.js";
import type { ChannelRuntimePort, PollOutputsResult } from "../ports.js";
import { TelegramConnector } from "./telegram.js";

/**
 * End-to-end through the REAL TelegramConnector over real HTTP against a mock Bot
 * API. Covers the exact inbound shapes a user hits: a text message, a `/start`
 * command (must be answered locally, never reach the agent), and a captioned photo
 * (caption becomes the text, image is downloaded as an attachment). The agent reply
 * text is the only stub — a fake port.
 */

interface MockOptions {
  update: Record<string, unknown>;
  filePath?: string;
  fileBytes?: Buffer;
}
interface MockState {
  sent: Array<{ chatId: unknown; text: string }>;
  reactions: string[];
  served: boolean;
}

function startMock(
  opts: MockOptions,
  state: MockState,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.includes("/file/bot")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(opts.fileBytes ?? Buffer.from("data"));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = (obj: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const params = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (url.endsWith("/getMe")) return json({ ok: true, result: { id: 1, username: "mockbot" } });
      if (url.endsWith("/getUpdates")) {
        if (!state.served) {
          state.served = true;
          return json({ ok: true, result: [{ update_id: 1, message: opts.update }] });
        }
        return json({ ok: true, result: [] });
      }
      if (url.endsWith("/getFile")) {
        return json({ ok: true, result: { file_id: params.file_id, file_path: opts.filePath ?? "x.bin" } });
      }
      if (url.endsWith("/sendMessage")) {
        state.sent.push({ chatId: params.chat_id, text: String(params.text ?? "") });
        return json({ ok: true, result: { message_id: 999 } });
      }
      if (url.endsWith("/setMessageReaction")) {
        const reaction = Array.isArray(params.reaction) ? params.reaction : [];
        for (const r of reaction) {
          if (r && typeof r === "object" && "emoji" in r) {
            state.reactions.push(String((r as { emoji: unknown }).emoji));
          }
        }
        return json({ ok: true, result: true });
      }
      return json({ ok: true, result: true });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    }),
  );
}

function capturingPort(reply: string): { port: ChannelRuntimePort; fired: IncomingMessage[] } {
  const fired: IncomingMessage[] = [];
  const polls = new Map<string, number>();
  const port: ChannelRuntimePort = {
    resolveWorkspaceId: () => "w1",
    fireMessage: ({ message, sessionId }) => {
      fired.push(message);
      return { sessionId, inputId: `in-${fired.length}`, created: true };
    },
    pollOutputs: ({ inputId }): PollOutputsResult => {
      const n = (polls.get(inputId) ?? 0) + 1;
      polls.set(inputId, n);
      return n < 2
        ? { events: [], lastEventId: 0, terminal: null, finalText: null, error: null }
        : {
            events: [{ id: 1, sequence: 1, eventType: "run_completed", payload: { output: reply } }],
            lastEventId: 1,
            terminal: "completed",
            finalText: reply,
            error: null,
          };
    },
    getTurnArtifacts: () => [],
  };
  return { port, fired };
}

function makeConnector(baseUrl: string, port: ChannelRuntimePort): TelegramConnector {
  const egress = new ChannelEgress({ port, pollIntervalMs: 10 });
  const ingress = new ChannelIngress({ port, egress });
  const connector = new TelegramConnector({
    config: { platform: "telegram", connectionId: "default", enabled: true, workspaceId: "w1", token: "T", apiBaseUrl: baseUrl },
  });
  connector.onMessage((message) => ingress.handle({ connector, message }));
  return connector;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

const SENDER = { id: 42, username: "alice" };

test("text message → agent reply with reaction ack", async () => {
  const state: MockState = { sent: [], reactions: [], served: false };
  const mock = await startMock(
    { update: { message_id: 10, text: "hello agent", chat: { id: 555, type: "private" }, from: SENDER } },
    state,
  );
  const { port } = capturingPort("Hello from the agent");
  const connector = makeConnector(mock.baseUrl, port);
  try {
    await connector.start();
    await waitFor(() => state.sent.some((s) => s.text.includes("Hello from the agent")));
    assert.ok(state.reactions.includes("👀"));
  } finally {
    await connector.stop();
    await mock.close();
  }
});

test("/start is answered locally and never reaches the agent", async () => {
  const state: MockState = { sent: [], reactions: [], served: false };
  const mock = await startMock(
    { update: { message_id: 11, text: "/start", chat: { id: 555, type: "private" }, from: SENDER } },
    state,
  );
  const { port, fired } = capturingPort("should-not-run");
  const connector = makeConnector(mock.baseUrl, port);
  try {
    await connector.start();
    await waitFor(() => state.sent.length > 0);
    assert.match(state.sent[0]!.text, /Hi!|message/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fired.length, 0, "the agent must not be invoked for /start");
  } finally {
    await connector.stop();
    await mock.close();
  }
});

test("captioned photo → caption is the text, largest photo downloaded as an attachment", async () => {
  const state: MockState = { sent: [], reactions: [], served: false };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const mock = await startMock(
    {
      update: {
        message_id: 12,
        caption: "what is this",
        photo: [
          { file_id: "small", file_unique_id: "u1" },
          { file_id: "big", file_unique_id: "u2" },
        ],
        chat: { id: 555, type: "private" },
        from: SENDER,
      },
      filePath: "photos/big.jpg",
      fileBytes: jpeg,
    },
    state,
  );
  const { port, fired } = capturingPort("I can see your photo");
  const connector = makeConnector(mock.baseUrl, port);
  try {
    await connector.start();
    await waitFor(() => fired.length > 0);
    const message = fired[0]!;
    assert.equal(message.text, "what is this");
    assert.equal(message.attachments.length, 1);
    const attachment = message.attachments[0]!;
    assert.equal(attachment.kind, "image");
    assert.equal(fs.readFileSync(attachment.sourcePath).length, jpeg.length);
    await waitFor(() => state.sent.some((s) => s.text.includes("I can see your photo")));
    fs.rmSync(attachment.sourcePath, { force: true });
  } finally {
    await connector.stop();
    await mock.close();
  }
});
