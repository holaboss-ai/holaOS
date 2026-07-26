import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const ELECTRON_TYPES_PATH = new URL("../src/types/electron.d.ts", import.meta.url);

test("desktop session history bridge forwards pagination and per-input output event filters", async () => {
  const [mainSource, preloadSource, typesSource] = await Promise.all([
    readFile(MAIN_PATH, "utf8"),
    readFile(PRELOAD_PATH, "utf8"),
    readFile(ELECTRON_TYPES_PATH, "utf8"),
  ]);

  assert.match(mainSource, /interface SessionHistoryRequestPayload \{[\s\S]*limit\?: number;[\s\S]*order\?: "asc" \| "desc";[\s\S]*\}/);
  assert.match(
    mainSource,
    /params: \{\s*workspace_id: payload\.workspaceId,\s*limit: payload\.limit \?\? 200,\s*offset: payload\.offset \?\? 0,\s*order: payload\.order \?\? "asc",\s*\}/,
  );
  assert.match(
    mainSource,
    /async \(_event, payload: SessionHistoryRequestPayload\) =>\s*getSessionHistory\(payload\)/,
  );
  assert.match(mainSource, /interface SessionOutputEventListRequestPayload \{[\s\S]*inputId\?: string \| null;[\s\S]*\}/);
  assert.match(
    mainSource,
    /params: \{\s*input_id: payload\.inputId \?\? undefined,\s*include_history: true,\s*after_event_id: 0,\s*\}/,
  );

  assert.match(preloadSource, /getSessionHistory: \(payload: SessionHistoryRequestPayload\) =>/);
  assert.match(preloadSource, /getSessionOutputEvents: \(payload: SessionOutputEventListRequestPayload\) =>/);

  assert.match(typesSource, /interface SessionHistoryRequestPayload \{[\s\S]*limit\?: number;[\s\S]*order\?: "asc" \| "desc";[\s\S]*\}/);
  assert.match(typesSource, /interface SessionOutputEventListRequestPayload \{[\s\S]*inputId\?: string \| null;[\s\S]*\}/);
  assert.match(typesSource, /getSessionHistory: \(payload: SessionHistoryRequestPayload\) => Promise<SessionHistoryResponsePayload>;/);
  assert.match(typesSource, /getSessionOutputEvents: \(payload: SessionOutputEventListRequestPayload\) => Promise<SessionOutputEventListResponsePayload>;/);
});
