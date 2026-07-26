import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  BROWSER_GET_STATE_ELEMENT_TEXT_MAX_CHARS,
  BROWSER_GET_STATE_ELEMENTS_MAX,
  BROWSER_GET_STATE_MEDIA_MAX,
  BROWSER_GET_STATE_MEDIA_TEXT_MAX_CHARS,
  BROWSER_GET_STATE_TEXT_MAX_CHARS,
  SKILL_TEXT_PREVIEW_MAX_CHARS,
  TERMINAL_EVENT_PREVIEW_TEXT_MAX_CHARS,
  TERMINAL_EVENT_PREVIEW_TRIM_THRESHOLD_CHARS,
  TERMINAL_EVENTS_PREVIEW_MAX,
  TOOL_RESULT_PREVIEW_BASE64_MAX_CHARS,
  TOOL_RESULT_PREVIEW_TEXT_MAX_CHARS,
  TOOL_RESULT_PREVIEW_TEXT_TRIM_THRESHOLD_CHARS,
} from "./tool-result-budget.js";
import { workspaceStateRelativePath } from "./workspace-bundle-paths.js";

export const TOOL_RESULT_MODE_HEADER = "x-holaboss-tool-result-mode";
export const TOOL_RESULT_MODE_PREVIEW = "preview";
export const TOOL_RESULT_PREVIEW_SHAPING_ENV = "HOLABOSS_TOOL_RESULT_PREVIEW_SHAPING";

export type CapabilityToolResultMode = "default" | "preview";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonEmptyString(value: unknown): string {
  return asString(value).trim();
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function clipText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  if (maxChars <= 3) {
    return { text: "…", truncated: true };
  }
  const marker = "\n...[truncated]...\n";
  if (maxChars <= marker.length + 8) {
    return {
      text: `${value.slice(0, maxChars - 1).trimEnd()}…`,
      truncated: true,
    };
  }
  const budget = maxChars - marker.length;
  const headChars = Math.max(4, Math.floor(budget * 0.67));
  const tailChars = Math.max(4, budget - headChars);
  const head = value.slice(0, headChars).trimEnd();
  const tail = value.slice(Math.max(0, value.length - tailChars)).trimStart();
  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
  };
}

function clipTextByThreshold(params: {
  value: string;
  maxChars: number;
  trimThresholdChars: number;
}): { text: string; truncated: boolean } {
  if (params.value.length <= params.trimThresholdChars) {
    return { text: params.value, truncated: false };
  }
  return clipText(params.value, params.maxChars);
}

function previewShapingEnabled(): boolean {
  const raw = (process.env[TOOL_RESULT_PREVIEW_SHAPING_ENV] ?? "").trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !["0", "off", "false", "disabled", "none"].includes(raw);
}

function sanitizeSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function screenshotExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return "jpg";
  }
  if (normalized.includes("webp")) {
    return "webp";
  }
  return "png";
}

export function capabilityToolResultModeFromHeaders(
  headers: Record<string, unknown>,
): CapabilityToolResultMode {
  const raw = headers[TOOL_RESULT_MODE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return "default";
  }
  return value.trim().toLowerCase() === TOOL_RESULT_MODE_PREVIEW
    ? "preview"
    : "default";
}

async function writeToolResultArtifact(params: {
  workspaceRoot: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  toolId: string;
  extension: string;
  content: Buffer | string;
}): Promise<string | null> {
  const workspaceId = nonEmptyString(params.workspaceId);
  if (!workspaceId) {
    return null;
  }
  const sessionToken = sanitizeSegment(
    nonEmptyString(params.sessionId) || "session",
    "session",
  );
  const toolToken = sanitizeSegment(params.toolId, "tool");
  const timestampToken = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const filename = `${timestampToken}-${randomUUID().slice(0, 8)}.${sanitizeSegment(
    params.extension,
    "txt",
  )}`;
  const relativePath = workspaceStateRelativePath(
    "tool-results",
    toolToken,
    sessionToken,
    filename,
  );
  const absolutePath = path.join(
    params.workspaceRoot,
    workspaceId,
    ...relativePath.split("/"),
  );
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  if (Buffer.isBuffer(params.content)) {
    await fs.writeFile(absolutePath, params.content);
  } else {
    await fs.writeFile(absolutePath, params.content, "utf8");
  }
  return relativePath;
}

function previewMeta(params: {
  toolId: string;
  truncated: boolean;
  spilled: boolean;
  spilloverPaths: string[];
}): JsonRecord {
  return {
    mode: TOOL_RESULT_MODE_PREVIEW,
    tool_id: params.toolId,
    truncated: params.truncated,
    spilled: params.spilled,
    spillover_paths: params.spilloverPaths,
  };
}

function clipNamedStringField(
  target: JsonRecord,
  field: string,
  maxChars: number,
): boolean {
  const value = asString(target[field]);
  if (!value) {
    return false;
  }
  const clipped = clipText(value, maxChars);
  target[field] = clipped.text;
  return clipped.truncated;
}

function shapeBrowserListItem(
  value: unknown,
  maxChars: number,
): JsonRecord {
  if (!isRecord(value)) {
    return { value };
  }
  const item = { ...value };
  void clipNamedStringField(item, "text", maxChars);
  void clipNamedStringField(item, "label", maxChars);
  void clipNamedStringField(item, "alt", maxChars);
  return item;
}

async function shapeScreenshotRecord(params: {
  screenshot: JsonRecord;
  workspaceRoot: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  toolId: string;
}): Promise<{
  screenshot: JsonRecord;
  truncated: boolean;
  spilled: boolean;
  spillPath: string | null;
}> {
  const screenshot = { ...params.screenshot };
  const rawBase64 = nonEmptyString(screenshot.base64);
  if (!rawBase64) {
    return { screenshot, truncated: false, spilled: false, spillPath: null };
  }

  const mimeType =
    nonEmptyString(screenshot.mime_type) ||
    nonEmptyString(screenshot.mimeType) ||
    "image/png";
  screenshot.mime_type = mimeType;
  delete screenshot.mimeType;

  let spillPath: string | null = null;
  let decoded: Buffer | null = null;
  try {
    decoded = Buffer.from(rawBase64, "base64");
    spillPath = await writeToolResultArtifact({
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: params.toolId,
      extension: screenshotExtension(mimeType),
      content: decoded,
    });
  } catch {
    spillPath = null;
  }

  if (spillPath) {
    screenshot.file_path = spillPath;
    screenshot.size_bytes = decoded?.byteLength ?? null;
  } else {
    const clipped = clipText(rawBase64, TOOL_RESULT_PREVIEW_BASE64_MAX_CHARS);
    screenshot.base64_preview = clipped.text;
    screenshot.base64_truncated = true;
  }
  delete screenshot.base64;
  return {
    screenshot,
    truncated: true,
    spilled: Boolean(spillPath),
    spillPath,
  };
}

async function shapeBrowserGetStatePayload(params: {
  payload: unknown;
  workspaceRoot: string;
  workspaceId?: string | null;
  sessionId?: string | null;
}): Promise<unknown> {
  if (!isRecord(params.payload)) {
    return params.payload;
  }

  const shaped = { ...params.payload };
  let truncated = false;
  let spilled = false;
  const spilloverPaths: string[] = [];

  const state = isRecord(shaped.state) ? { ...shaped.state } : null;
  if (state) {
    if (clipNamedStringField(state, "text", BROWSER_GET_STATE_TEXT_MAX_CHARS)) {
      truncated = true;
    }

    const sourceElements = Array.isArray(state.elements) ? state.elements : [];
    const sourceElementsOffset = nonNegativeInteger(state.elements_offset) ?? 0;
    const sourceElementsTotal =
      nonNegativeInteger(state.elements_total) ??
      Math.max(sourceElementsOffset + sourceElements.length, sourceElements.length);
    const sourceElementsHasMore = state.elements_has_more === true;
    const sourceNextElementsOffset = nonNegativeInteger(state.next_elements_offset);
    if (sourceElements.length > BROWSER_GET_STATE_ELEMENTS_MAX) {
      truncated = true;
    }
    state.elements = sourceElements
      .slice(0, BROWSER_GET_STATE_ELEMENTS_MAX)
      .map((entry) =>
        shapeBrowserListItem(
          entry,
          BROWSER_GET_STATE_ELEMENT_TEXT_MAX_CHARS,
        ),
      );
    const previewElementsCount = (state.elements as unknown[]).length;
    const previewElementsHasMore =
      sourceElements.length > BROWSER_GET_STATE_ELEMENTS_MAX || sourceElementsHasMore;
    state.elements_offset = sourceElementsOffset;
    state.elements_total = sourceElementsTotal;
    state.elements_has_more = previewElementsHasMore;
    state.next_elements_offset = previewElementsHasMore
      ? sourceElements.length > BROWSER_GET_STATE_ELEMENTS_MAX
        ? sourceElementsOffset + previewElementsCount
        : Math.max(
            sourceNextElementsOffset ?? sourceElementsOffset + previewElementsCount,
            sourceElementsOffset + previewElementsCount,
          )
      : null;

    const sourceMedia = Array.isArray(state.media) ? state.media : [];
    const sourceMediaOffset = nonNegativeInteger(state.media_offset) ?? 0;
    const sourceMediaTotal =
      nonNegativeInteger(state.media_total) ??
      Math.max(sourceMediaOffset + sourceMedia.length, sourceMedia.length);
    const sourceMediaHasMore = state.media_has_more === true;
    const sourceNextMediaOffset = nonNegativeInteger(state.next_media_offset);
    if (sourceMedia.length > BROWSER_GET_STATE_MEDIA_MAX) {
      truncated = true;
    }
    state.media = sourceMedia
      .slice(0, BROWSER_GET_STATE_MEDIA_MAX)
      .map((entry) =>
        shapeBrowserListItem(entry, BROWSER_GET_STATE_MEDIA_TEXT_MAX_CHARS),
      );
    const previewMediaCount = (state.media as unknown[]).length;
    const previewMediaHasMore =
      sourceMedia.length > BROWSER_GET_STATE_MEDIA_MAX || sourceMediaHasMore;
    state.media_offset = sourceMediaOffset;
    state.media_total = sourceMediaTotal;
    state.media_has_more = previewMediaHasMore;
    state.next_media_offset = previewMediaHasMore
      ? sourceMedia.length > BROWSER_GET_STATE_MEDIA_MAX
        ? sourceMediaOffset + previewMediaCount
        : Math.max(
            sourceNextMediaOffset ?? sourceMediaOffset + previewMediaCount,
            sourceMediaOffset + previewMediaCount,
          )
      : null;

    shaped.state = state;
  }

  if (isRecord(shaped.screenshot)) {
    const screenshot = await shapeScreenshotRecord({
      screenshot: shaped.screenshot,
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "browser_get_state",
    });
    shaped.screenshot = screenshot.screenshot;
    truncated ||= screenshot.truncated;
    spilled ||= screenshot.spilled;
    if (screenshot.spillPath) {
      spilloverPaths.push(screenshot.spillPath);
    }
  }

  if (truncated) {
    const fullStatePath = await writeToolResultArtifact({
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "browser_get_state",
      extension: "json",
      content: JSON.stringify(params.payload, null, 2),
    });
    if (fullStatePath) {
      spilled = true;
      spilloverPaths.push(fullStatePath);
      shaped.full_state_path = fullStatePath;
    }
  }

  shaped._preview = previewMeta({
    toolId: "browser_get_state",
    truncated,
    spilled,
    spilloverPaths,
  });
  return shaped;
}

async function shapeBrowserScreenshotPayload(params: {
  payload: unknown;
  workspaceRoot: string;
  workspaceId?: string | null;
  sessionId?: string | null;
}): Promise<unknown> {
  if (!isRecord(params.payload)) {
    return params.payload;
  }
  const shaped = { ...params.payload };
  let truncated = false;
  let spilled = false;
  const spilloverPaths: string[] = [];
  const screenshotValue = isRecord(shaped.screenshot)
    ? shaped.screenshot
    : isRecord(shaped)
      ? shaped
      : null;
  if (screenshotValue) {
    const screenshot = await shapeScreenshotRecord({
      screenshot: screenshotValue,
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "browser_screenshot",
    });
    if (isRecord(shaped.screenshot)) {
      shaped.screenshot = screenshot.screenshot;
    } else {
      Object.assign(shaped, screenshot.screenshot);
    }
    truncated ||= screenshot.truncated;
    spilled ||= screenshot.spilled;
    if (screenshot.spillPath) {
      spilloverPaths.push(screenshot.spillPath);
    }
  }
  shaped._preview = previewMeta({
    toolId: "browser_screenshot",
    truncated,
    spilled,
    spilloverPaths,
  });
  return shaped;
}

async function shapeWebSearchPayload(params: {
  payload: unknown;
  workspaceRoot: string;
  workspaceId?: string | null;
  sessionId?: string | null;
}): Promise<unknown> {
  if (!isRecord(params.payload)) {
    return params.payload;
  }
  const shaped = { ...params.payload };
  let truncated = false;
  let spilled = false;
  const spilloverPaths: string[] = [];

  const text = asString(shaped.text);
  if (text) {
    const clipped = clipTextByThreshold({
      value: text,
      maxChars: TOOL_RESULT_PREVIEW_TEXT_MAX_CHARS,
      trimThresholdChars: TOOL_RESULT_PREVIEW_TEXT_TRIM_THRESHOLD_CHARS,
    });
    shaped.text = clipped.text;
    truncated ||= clipped.truncated;
    if (clipped.truncated) {
      const spillPath = await writeToolResultArtifact({
        workspaceRoot: params.workspaceRoot,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        toolId: "web_search",
        extension: "txt",
        content: text,
      });
      if (spillPath) {
        spilled = true;
        spilloverPaths.push(spillPath);
        shaped.full_text_path = spillPath;
      }
    }
  }

  shaped._preview = previewMeta({
    toolId: "web_search",
    truncated,
    spilled,
    spilloverPaths,
  });
  return shaped;
}

async function shapeSkillPayload(params: {
  payload: unknown;
  workspaceRoot: string;
  workspaceId?: string | null;
  sessionId?: string | null;
}): Promise<unknown> {
  if (!isRecord(params.payload)) {
    return params.payload;
  }
  const shaped = { ...params.payload };
  let truncated = false;
  let spilled = false;
  const spilloverPaths: string[] = [];

  const text = asString(shaped.text);
  if (text) {
    const clipped = clipTextByThreshold({
      value: text,
      maxChars: SKILL_TEXT_PREVIEW_MAX_CHARS,
      trimThresholdChars: SKILL_TEXT_PREVIEW_MAX_CHARS,
    });
    shaped.text = clipped.text;
    truncated ||= clipped.truncated;
  }
  const skillBlock = asString(shaped.skill_block);
  if (skillBlock) {
    const clipped = clipTextByThreshold({
      value: skillBlock,
      maxChars: SKILL_TEXT_PREVIEW_MAX_CHARS,
      trimThresholdChars: SKILL_TEXT_PREVIEW_MAX_CHARS,
    });
    shaped.skill_block = clipped.text;
    truncated ||= clipped.truncated;
  }

  if (truncated) {
    const spillPath = await writeToolResultArtifact({
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: "skill",
      extension: "json",
      content: JSON.stringify(params.payload, null, 2),
    });
    if (spillPath) {
      spilled = true;
      spilloverPaths.push(spillPath);
      shaped.full_result_path = spillPath;
    }
  }

  shaped._preview = previewMeta({
    toolId: "skill",
    truncated,
    spilled,
    spilloverPaths,
  });
  return shaped;
}

function shapeTerminalEventPayload(
  value: unknown,
): { payload: unknown; truncated: boolean } {
  if (typeof value === "string") {
    const clipped = clipTextByThreshold({
      value,
      maxChars: TERMINAL_EVENT_PREVIEW_TEXT_MAX_CHARS,
      trimThresholdChars: TERMINAL_EVENT_PREVIEW_TRIM_THRESHOLD_CHARS,
    });
    return {
      payload: clipped.text,
      truncated: clipped.truncated,
    };
  }
  if (!isRecord(value) && !Array.isArray(value)) {
    return { payload: value, truncated: false };
  }
  const serialized = JSON.stringify(value) ?? String(value);
  if (serialized.length <= TERMINAL_EVENT_PREVIEW_TRIM_THRESHOLD_CHARS) {
    return { payload: value, truncated: false };
  }
  const clipped = clipText(serialized, TERMINAL_EVENT_PREVIEW_TEXT_MAX_CHARS);
  return {
    payload: {
      preview_text: clipped.text,
      truncated: true,
    },
    truncated: true,
  };
}

function shapeTerminalEvent(value: unknown): { event: unknown; truncated: boolean } {
  if (!isRecord(value)) {
    const serialized = JSON.stringify(value) ?? String(value);
    const clipped = clipTextByThreshold({
      value: serialized,
      maxChars: TERMINAL_EVENT_PREVIEW_TEXT_MAX_CHARS,
      trimThresholdChars: TERMINAL_EVENT_PREVIEW_TRIM_THRESHOLD_CHARS,
    });
    if (!clipped.truncated) {
      return { event: value, truncated: false };
    }
    return {
      event: {
        payload: {
          preview_text: clipped.text,
          truncated: true,
        },
      },
      truncated: true,
    };
  }
  const event = { ...value };
  if (!Object.prototype.hasOwnProperty.call(event, "payload")) {
    return { event, truncated: false };
  }
  const shapedPayload = shapeTerminalEventPayload(event.payload);
  event.payload = shapedPayload.payload;
  return {
    event,
    truncated: shapedPayload.truncated,
  };
}

async function shapeTerminalReadPayload(params: {
  payload: unknown;
  workspaceRoot: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  toolId: "terminal_session_read" | "terminal_session_wait";
}): Promise<unknown> {
  if (!isRecord(params.payload)) {
    return params.payload;
  }
  const shaped = { ...params.payload };
  const events = Array.isArray(shaped.events) ? shaped.events : [];
  let truncated = false;
  let spilled = false;
  const spilloverPaths: string[] = [];

  if (events.length > TERMINAL_EVENTS_PREVIEW_MAX) {
    truncated = true;
  }
  const shapedEvents = events
    .slice(0, TERMINAL_EVENTS_PREVIEW_MAX)
    .map((entry) => {
      const shapedEvent = shapeTerminalEvent(entry);
      truncated ||= shapedEvent.truncated;
      return shapedEvent.event;
    });
  shaped.events = shapedEvents;
  shaped.count = shapedEvents.length;
  shaped.total_event_count = events.length;
  const sourceAfterSequence = nonNegativeInteger(shaped.after_sequence) ?? 0;
  const sourceHasMore = shaped.has_more === true;
  const sourceNextAfterSequence = nonNegativeInteger(shaped.next_after_sequence);
  const sourceRemainingEventCount = nonNegativeInteger(shaped.remaining_event_count);
  const sourceLatestEventSequence = nonNegativeInteger(shaped.latest_event_sequence);

  let previewLastSequence = sourceAfterSequence;
  for (const event of shapedEvents) {
    if (!isRecord(event)) {
      continue;
    }
    const sequence = nonNegativeInteger(event.sequence);
    if (sequence !== null && sequence > previewLastSequence) {
      previewLastSequence = sequence;
    }
  }

  const previewTrimmedCount = Math.max(0, events.length - shapedEvents.length);
  const previewHasMore = previewTrimmedCount > 0 || sourceHasMore;
  let nextAfterSequence: number | null = null;
  if (previewHasMore) {
    if (previewTrimmedCount > 0) {
      nextAfterSequence = previewLastSequence;
    } else if (sourceNextAfterSequence !== null) {
      nextAfterSequence = sourceNextAfterSequence;
    } else if (previewLastSequence > sourceAfterSequence) {
      nextAfterSequence = previewLastSequence;
    } else {
      nextAfterSequence = sourceAfterSequence;
    }
  }

  let remainingEventCount = 0;
  if (previewHasMore) {
    remainingEventCount += previewTrimmedCount;
    if (previewTrimmedCount === 0) {
      if (sourceRemainingEventCount !== null) {
        remainingEventCount += sourceRemainingEventCount;
      } else if (
        sourceLatestEventSequence !== null &&
        sourceNextAfterSequence !== null
      ) {
        remainingEventCount += Math.max(
          0,
          sourceLatestEventSequence - sourceNextAfterSequence,
        );
      }
    } else if (sourceHasMore) {
      if (sourceRemainingEventCount !== null) {
        remainingEventCount += sourceRemainingEventCount;
      } else if (
        sourceLatestEventSequence !== null &&
        sourceNextAfterSequence !== null
      ) {
        remainingEventCount += Math.max(
          0,
          sourceLatestEventSequence - sourceNextAfterSequence,
        );
      }
    }
  }

  shaped.has_more = previewHasMore;
  shaped.next_after_sequence = previewHasMore ? nextAfterSequence : null;
  shaped.remaining_event_count = previewHasMore ? remainingEventCount : 0;

  if (truncated) {
    const spillPath = await writeToolResultArtifact({
      workspaceRoot: params.workspaceRoot,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolId: params.toolId,
      extension: "json",
      content: JSON.stringify(events, null, 2),
    });
    if (spillPath) {
      spilled = true;
      spilloverPaths.push(spillPath);
      shaped.full_events_path = spillPath;
    }
  }

  shaped._preview = previewMeta({
    toolId: params.toolId,
    truncated,
    spilled,
    spilloverPaths,
  });
  return shaped;
}

interface ShapeCapabilityToolResultParams {
  mode: CapabilityToolResultMode;
  toolId: string;
  payload: unknown;
  workspaceRoot: string;
  workspaceId?: string | null;
  sessionId?: string | null;
}

export async function shapeCapabilityToolResultPayload(
  params: ShapeCapabilityToolResultParams,
): Promise<unknown> {
  if (params.mode !== "preview" || !previewShapingEnabled()) {
    return params.payload;
  }
  try {
    switch (params.toolId) {
      case "browser_get_state":
        return await shapeBrowserGetStatePayload(params);
      case "browser_screenshot":
        return await shapeBrowserScreenshotPayload(params);
      case "web_search":
        return await shapeWebSearchPayload(params);
      case "skill":
        return await shapeSkillPayload(params);
      case "terminal_session_read":
      case "terminal_session_wait":
        return await shapeTerminalReadPayload({
          ...params,
          toolId: params.toolId,
        });
      default:
        return params.payload;
    }
  } catch {
    return params.payload;
  }
}
