import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DESKTOP_BROWSER_TOOL_DEFINITIONS,
  DESKTOP_BROWSER_TOOL_IDS,
  type DesktopBrowserToolDefinition,
  type DesktopBrowserToolId,
} from "../../harnesses/src/desktop-browser-tools.js";
import { resolveProductRuntimeConfig, type ProductRuntimeConfig } from "./runtime-config.js";

export {
  DESKTOP_BROWSER_TOOL_DEFINITIONS,
  DESKTOP_BROWSER_TOOL_IDS,
  type DesktopBrowserToolDefinition,
  type DesktopBrowserToolId,
} from "../../harnesses/src/desktop-browser-tools.js";

export interface DesktopBrowserToolExecutionContext {
  workspaceId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  space?: "agent" | "user" | null;
}

export interface DesktopBrowserToolServiceLike {
  getStatus(context?: DesktopBrowserToolExecutionContext): Promise<Record<string, unknown>>;
  execute(
    toolId: string,
    args: Record<string, unknown>,
    context?: DesktopBrowserToolExecutionContext
  ): Promise<Record<string, unknown>>;
}

export interface DesktopBrowserToolServiceOptions {
  fetchImpl?: typeof fetch;
  resolveConfig?: () => ProductRuntimeConfig;
  artifactStore?: BrowserScreenshotArtifactStore | null;
}

interface BrowserScreenshotArtifactStore {
  workspaceRoot: string;
  createOutput(params: {
    workspaceId: string;
    outputType: string;
    title?: string;
    status?: string;
    filePath?: string | null;
    sessionId?: string | null;
    inputId?: string | null;
    artifactId?: string | null;
    platform?: string | null;
    metadata?: Record<string, unknown> | null;
  }): {
    id: string;
    artifactId: string | null;
    filePath: string | null;
  };
}

type BrowserFetchOptions = {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  workspaceId?: string | null;
  sessionId?: string | null;
  space?: "agent" | "user" | null;
  signal?: AbortSignal;
};

type BrowserTargetKind = "element" | "media";
type BrowserGetStateMode = "state" | "text" | "structured" | "visual";
type BrowserGetStateDetail = "compact" | "standard";
type BrowserGetStateScope = "main" | "viewport" | "focused" | "dialog";
type BrowserActionKind =
  | "click"
  | "double_click"
  | "hover"
  | "focus"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "scroll_into_view";
type BrowserWaitLoadState = "interactive" | "complete";
type BrowserWaitCondition =
  | "load"
  | "url"
  | "text"
  | "element"
  | "hidden"
  | "dom_change"
  | "function"
  | "download_started"
  | "download_completed";
type BrowserPostStateMode = "none" | "page" | "state";

type BrowserGetStateOptions = {
  includePageText: boolean;
  includeScreenshot: boolean;
  mode: BrowserGetStateMode;
  detail: BrowserGetStateDetail;
  scope: BrowserGetStateScope;
  maxNodes: number | null;
  sinceRevision: string | null;
  changedOnly: boolean;
  includeMetadata: boolean;
  returnMetadata: boolean;
};

type BrowserLocatorOptions = {
  ref: string | null;
  text: string | null;
  label: string | null;
  placeholder: string | null;
  role: string | null;
  selector: string | null;
  xpath: string | null;
  exact: boolean;
  includeHidden: boolean;
  scope: BrowserGetStateScope;
};

type BrowserFindOptions = BrowserLocatorOptions & {
  maxResults: number;
};

type BrowserActOptions = BrowserLocatorOptions & {
  action: BrowserActionKind;
  value: string | null;
  key: string | null;
  clear: boolean | null;
  submit: boolean;
};

type BrowserWaitOptions = BrowserLocatorOptions & {
  condition: BrowserWaitCondition;
  url: string | null;
  filename: string | null;
  expression: string | null;
  loadState: BrowserWaitLoadState;
  timeoutMs: number;
};

type BrowserDownloadStatus =
  | "progressing"
  | "completed"
  | "cancelled"
  | "interrupted";

type BrowserConsoleLevel = "debug" | "info" | "warning" | "error";
type BrowserErrorSource = "page" | "runtime" | "network";

type BrowserDownloadRecord = {
  id: string;
  url: string;
  filename: string;
  targetPath: string;
  status: BrowserDownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  createdAt: string;
  completedAt: string | null;
};

type BrowserGetConsoleOptions = {
  limit: number;
  level: BrowserConsoleLevel | null;
};

type BrowserGetErrorsOptions = {
  limit: number;
  source: BrowserErrorSource | null;
};

type BrowserListRequestsOptions = {
  limit: number;
  resourceType: string | null;
  failuresOnly: boolean;
};

type BrowserStorageKind = "local" | "session";

type BrowserStorageGetOptions = {
  storage: BrowserStorageKind;
  key: string | null;
  keys: string[];
  prefix: string | null;
  maxEntries: number;
};

type BrowserStorageSetOptions = {
  storage: BrowserStorageKind;
  key: string;
  value: string | null;
  delete: boolean;
};

type BrowserCookieSameSite =
  | "unspecified"
  | "no_restriction"
  | "lax"
  | "strict";

type BrowserCookieRecord = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  sameSite: BrowserCookieSameSite;
  expirationDate: number | null;
};

type BrowserCookiesGetOptions = {
  url: string | null;
  name: string | null;
  names: string[];
  domain: string | null;
  maxResults: number;
};

type BrowserCookiesSetOptions = {
  url: string | null;
  name: string;
  value: string;
  domain: string | null;
  path: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: BrowserCookieSameSite | null;
  expirationDate: number | null;
};

type BrowserPostActionOptions = {
  waitFor: BrowserWaitOptions | null;
  postState: BrowserPostStateMode;
};

type BrowserEvaluateOptions = {
  expression: string;
  allowMutation: boolean;
  timeoutMs: number;
};

type BrowserDebugOptions = {
  x: number | null;
  y: number | null;
  includeDomSample: boolean;
};

const INTERACTIVE_ELEMENTS_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='link']",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]"
].join(",");
const VISIBLE_MEDIA_SELECTOR = [
  "img",
  "video",
  "canvas",
  "[role='img']",
].join(",");

const BROWSER_GET_STATE_TEXT_MAX_CHARS = 2500;
const BROWSER_GET_STATE_ELEMENT_TEXT_MAX_CHARS = 120;
const BROWSER_GET_STATE_MEDIA_TEXT_MAX_CHARS = 240;
const BROWSER_GET_STATE_COMPACT_MAX_NODES = 30;
const BROWSER_GET_STATE_MAX_ATTEMPTS = 4;
const BROWSER_GET_STATE_RETRY_DELAY_MS = 350;
const BROWSER_POST_ACTION_STATE_MAX_NODES = 12;
const BROWSER_SCREENSHOT_ARTIFACT_DIR = "outputs/browser-screenshots";
const BROWSER_FIND_DEFAULT_MAX_RESULTS = 25;
const BROWSER_FIND_MAX_RESULTS = 100;
const BROWSER_OBSERVABILITY_DEFAULT_LIMIT = 20;
const BROWSER_OBSERVABILITY_MAX_LIMIT = 100;
const BROWSER_STORAGE_DEFAULT_MAX_ENTRIES = 25;
const BROWSER_STORAGE_MAX_ENTRIES = 100;
const BROWSER_COOKIES_DEFAULT_MAX_RESULTS = 25;
const BROWSER_COOKIES_MAX_RESULTS = 100;
const BROWSER_WAIT_DEFAULT_TIMEOUT_MS = 5000;
const BROWSER_TOOL_MAX_TIMEOUT_MS = 30000;
const BROWSER_WAIT_POLL_INTERVAL_MS = 250;


export class DesktopBrowserToolServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function optionalBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function optionalInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  return null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalStringArg(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function optionalRawStringArg(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalStringArrayArg(
  value: unknown,
  fieldName: string,
  options: { maxItems?: number } = {},
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      `${fieldName} must be an array of non-empty strings`,
    );
  }
  const maxItems = options.maxItems ?? 50;
  if (value.length > maxItems) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      `${fieldName} must contain at most ${maxItems} values`,
    );
  }
  const normalized = value
    .map((entry) => optionalStringArg(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (normalized.length !== value.length) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      `${fieldName} must contain only non-empty strings`,
    );
  }
  return normalized;
}

function isBrowserDownloadWaitCondition(
  condition: BrowserWaitCondition,
): condition is "download_started" | "download_completed" {
  return condition === "download_started" || condition === "download_completed";
}

function browserDownloadStatus(value: unknown): BrowserDownloadStatus | null {
  return value === "progressing" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "interrupted"
    ? value
    : null;
}

function browserDownloadFromUnknown(value: unknown): BrowserDownloadRecord | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const id = optionalStringArg(record.id);
  const url = optionalStringArg(record.url);
  const filename = optionalStringArg(record.filename);
  const status = browserDownloadStatus(record.status);
  if (!id || !url || !filename || !status) {
    return null;
  }
  return {
    id,
    url,
    filename,
    targetPath: optionalStringArg(record.targetPath) ?? "",
    status,
    receivedBytes: optionalNumber(record.receivedBytes) ?? 0,
    totalBytes: optionalNumber(record.totalBytes) ?? 0,
    createdAt: optionalStringArg(record.createdAt) ?? "",
    completedAt: optionalStringArg(record.completedAt),
  };
}

function browserDownloadsFromPayload(
  payload: Record<string, unknown>,
): BrowserDownloadRecord[] {
  const downloads = Array.isArray(payload.downloads) ? payload.downloads : [];
  return downloads
    .map((entry) => browserDownloadFromUnknown(entry))
    .filter((entry): entry is BrowserDownloadRecord => Boolean(entry));
}

function browserCookieSameSiteValue(value: unknown): BrowserCookieSameSite | null {
  return value === "unspecified" ||
    value === "no_restriction" ||
    value === "lax" ||
    value === "strict"
    ? value
    : null;
}

function browserCookieFromUnknown(value: unknown): BrowserCookieRecord | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = optionalStringArg(record.name);
  if (!name) {
    return null;
  }
  return {
    name,
    value: typeof record.value === "string" ? record.value : "",
    domain: optionalStringArg(record.domain) ?? "",
    path: optionalStringArg(record.path) ?? "/",
    secure: record.secure === true,
    httpOnly: record.httpOnly === true || record.http_only === true,
    session: record.session === true,
    sameSite: browserCookieSameSiteValue(record.sameSite ?? record.same_site) ?? "unspecified",
    expirationDate: optionalNumber(record.expirationDate ?? record.expiration_date),
  };
}

function browserCookiesFromPayload(
  payload: Record<string, unknown>,
): BrowserCookieRecord[] {
  const cookies = Array.isArray(payload.cookies) ? payload.cookies : [];
  return cookies
    .map((entry) => browserCookieFromUnknown(entry))
    .filter((entry): entry is BrowserCookieRecord => Boolean(entry));
}

function browserDownloadUrlMatches(
  value: string,
  expected: string | null,
  exact: boolean,
): boolean {
  if (!expected) {
    return true;
  }
  if (!exact && expected.startsWith("/") && expected.endsWith("/") && expected.length > 2) {
    try {
      return new RegExp(expected.slice(1, -1)).test(value);
    } catch {
      return value.includes(expected);
    }
  }
  return exact ? value === expected : value.includes(expected);
}

function browserDownloadFilenameMatches(
  value: string,
  expected: string | null,
  exact: boolean,
): boolean {
  if (!expected) {
    return true;
  }
  const normalizedValue = value.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();
  return exact
    ? normalizedValue === normalizedExpected
    : normalizedValue.includes(normalizedExpected);
}

function browserDownloadMatches(
  download: BrowserDownloadRecord,
  options: BrowserWaitOptions,
): boolean {
  return (
    browserDownloadUrlMatches(download.url, options.url, options.exact) &&
    browserDownloadFilenameMatches(download.filename, options.filename, options.exact)
  );
}

function matchedBrowserDownloadForWait(
  downloads: BrowserDownloadRecord[],
  baselineStatuses: Map<string, BrowserDownloadStatus>,
  options: BrowserWaitOptions,
): BrowserDownloadRecord | null {
  const matchingDownloads = downloads.filter((download) =>
    browserDownloadMatches(download, options),
  );
  if (options.condition === "download_started") {
    return matchingDownloads.find((download) => !baselineStatuses.has(download.id)) ?? null;
  }
  return (
    matchingDownloads.find((download) => {
      if (download.status !== "completed") {
        return false;
      }
      const baselineStatus = baselineStatuses.get(download.id) ?? null;
      return !baselineStatus || baselineStatus !== "completed";
    }) ?? null
  );
}

function optionalPositiveIntegerArg(
  value: unknown,
  fieldName: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = optionalInteger(value);
  if (!parsed || parsed <= 0) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      `${fieldName} must be a positive integer`
    );
  }
  return parsed;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DesktopBrowserToolServiceError(400, "browser_tool_invalid_args", `${fieldName} is required`);
  }
  return value.trim();
}

function boundedTimeoutMs(value: unknown, defaultValue: number): number {
  const parsed = optionalInteger(value);
  if (parsed === null) {
    return defaultValue;
  }
  if (parsed < 100 || parsed > BROWSER_TOOL_MAX_TIMEOUT_MS) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      `timeout_ms must be between 100 and ${BROWSER_TOOL_MAX_TIMEOUT_MS}`
    );
  }
  return parsed;
}

function boundedMaxResults(value: unknown): number {
  const parsed = optionalPositiveIntegerArg(value, "max_results") ?? BROWSER_FIND_DEFAULT_MAX_RESULTS;
  return Math.min(parsed, BROWSER_FIND_MAX_RESULTS);
}

function boundedObservabilityLimit(
  value: unknown,
  fieldName = "limit",
): number {
  const parsed =
    optionalPositiveIntegerArg(value, fieldName) ??
    BROWSER_OBSERVABILITY_DEFAULT_LIMIT;
  return Math.min(parsed, BROWSER_OBSERVABILITY_MAX_LIMIT);
}

function boundedStorageMaxEntries(value: unknown): number {
  const parsed =
    optionalPositiveIntegerArg(value, "max_entries") ??
    BROWSER_STORAGE_DEFAULT_MAX_ENTRIES;
  return Math.min(parsed, BROWSER_STORAGE_MAX_ENTRIES);
}

function boundedCookieMaxResults(value: unknown): number {
  const parsed =
    optionalPositiveIntegerArg(value, "max_results") ??
    BROWSER_COOKIES_DEFAULT_MAX_RESULTS;
  return Math.min(parsed, BROWSER_COOKIES_MAX_RESULTS);
}

function requiredPositiveInteger(value: unknown, fieldName: string): number {
  const parsed = optionalInteger(value);
  if (!parsed || parsed <= 0) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      `${fieldName} must be a positive integer`
    );
  }
  return parsed;
}

function requiredNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = optionalInteger(value);
  if (parsed === null || parsed < 0) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      `${fieldName} must be a non-negative integer`
    );
  }
  return parsed;
}

function browserActionKind(value: unknown): BrowserActionKind {
  if (
    value === "click" ||
    value === "double_click" ||
    value === "hover" ||
    value === "focus" ||
    value === "fill" ||
    value === "type" ||
    value === "press" ||
    value === "select" ||
    value === "check" ||
    value === "uncheck" ||
    value === "scroll_into_view"
  ) {
    return value;
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "action must be one of `click`, `double_click`, `hover`, `focus`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, or `scroll_into_view`"
  );
}

function hasLocator(args: Record<string, unknown>): boolean {
  return Boolean(
    optionalStringArg(args.ref) ||
      optionalStringArg(args.text) ||
      optionalStringArg(args.label) ||
      optionalStringArg(args.placeholder) ||
      optionalStringArg(args.role) ||
      optionalStringArg(args.selector) ||
      optionalStringArg(args.xpath)
  );
}

function browserWaitCondition(value: unknown, args: Record<string, unknown>): BrowserWaitCondition {
  if (value === undefined || value === null) {
    if (optionalStringArg(args.expression)) {
      return "function";
    }
    if (optionalStringArg(args.url)) {
      return "url";
    }
    if (optionalStringArg(args.text)) {
      return "text";
    }
    if (hasLocator(args)) {
      return "element";
    }
    return "load";
  }
  if (
    value === "load" ||
    value === "load_state" ||
    value === "url" ||
    value === "text" ||
    value === "element" ||
    value === "hidden" ||
    value === "dom_change" ||
    value === "function" ||
    value === "download_started" ||
    value === "download_completed"
  ) {
    return value === "load_state" ? "load" : value;
  }
  if (value === "dom_mutation") {
    return "dom_change";
  }
  if (value === "change" || value === "mutation") {
    return "dom_change";
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "condition must be `load`, `load_state`, `url`, `text`, `element`, `hidden`, `dom_change`, `dom_mutation`, `change`, `mutation`, `function`, `download_started`, or `download_completed`"
  );
}

function browserGetStateMode(value: unknown): BrowserGetStateMode {
  if (value === undefined || value === null) {
    return "state";
  }
  if (value === "state" || value === "text" || value === "structured" || value === "visual") {
    return value;
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "mode must be `state`, `text`, `structured`, or `visual`"
  );
}

function browserGetStateDetail(value: unknown): BrowserGetStateDetail {
  if (value === undefined || value === null) {
    return "compact";
  }
  if (value === "compact" || value === "standard") {
    return value;
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "detail must be `compact` or `standard`",
  );
}

function browserGetStateScope(value: unknown): BrowserGetStateScope {
  if (value === undefined || value === null) {
    return "main";
  }
  if (value === "main" || value === "viewport" || value === "focused" || value === "dialog") {
    return value;
  }
  if (value === "active_dialog" || value === "modal") {
    return "dialog";
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "scope must be `main`, `viewport`, `focused`, `dialog`, `active_dialog`, or `modal`"
  );
}

function browserWaitLoadState(value: unknown): BrowserWaitLoadState {
  if (value === undefined || value === null) {
    return "complete";
  }
  if (value === "interactive" || value === "domcontentloaded") {
    return "interactive";
  }
  if (value === "complete" || value === "load") {
    return "complete";
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "load_state must be `interactive`, `domcontentloaded`, `complete`, or `load`",
  );
}

function browserPostStateMode(
  value: unknown,
  defaultValue: BrowserPostStateMode,
): BrowserPostStateMode {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (value === "none" || value === "page" || value === "state") {
    return value;
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "post_state must be `none`, `page`, or `state`",
  );
}

function browserStorageKind(value: unknown): BrowserStorageKind {
  if (value === undefined || value === null) {
    return "local";
  }
  if (value === "local" || value === "session") {
    return value;
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "storage must be `local` or `session`",
  );
}

function browserCookieSameSite(value: unknown): BrowserCookieSameSite | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    value === "unspecified" ||
    value === "no_restriction" ||
    value === "lax" ||
    value === "strict"
  ) {
    return value;
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "same_site must be `unspecified`, `no_restriction`, `lax`, or `strict`",
  );
}

function browserConsoleLevel(
  value: unknown,
): BrowserConsoleLevel | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    value === "debug" ||
    value === "info" ||
    value === "warning" ||
    value === "error"
  ) {
    return value;
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "level must be `debug`, `info`, `warning`, or `error`",
  );
}

function browserErrorSource(
  value: unknown,
): BrowserErrorSource | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value === "page" || value === "runtime" || value === "network") {
    return value;
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "source must be `page`, `runtime`, or `network`",
  );
}

function browserLocatorOptions(args: Record<string, unknown>, options: { requireLocator: boolean }): BrowserLocatorOptions {
  const locator = {
    ref: optionalStringArg(args.ref),
    text: optionalStringArg(args.text),
    label: optionalStringArg(args.label),
    placeholder: optionalStringArg(args.placeholder),
    role: optionalStringArg(args.role),
    selector: optionalStringArg(args.selector),
    xpath: optionalStringArg(args.xpath),
    exact: optionalBoolean(args.exact, false),
    includeHidden: optionalBoolean(args.include_hidden ?? args.includeHidden, false),
    scope: browserGetStateScope(args.scope),
  };
  if (
    options.requireLocator &&
    !locator.ref &&
    !locator.text &&
    !locator.label &&
    !locator.placeholder &&
    !locator.role &&
    !locator.selector &&
    !locator.xpath
  ) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      "at least one locator is required: ref, text, label, placeholder, role, selector, or xpath"
    );
  }
  return locator;
}

function browserFindOptions(args: Record<string, unknown>): BrowserFindOptions {
  return {
    ...browserLocatorOptions(args, { requireLocator: true }),
    maxResults: boundedMaxResults(args.max_results ?? args.maxResults),
  };
}

function browserActOptions(args: Record<string, unknown>): BrowserActOptions {
  const action = browserActionKind(args.action);
  return {
    ...browserLocatorOptions(args, { requireLocator: action !== "press" }),
    action,
    value: optionalStringArg(args.value ?? args.text_value),
    key: optionalStringArg(args.key),
    clear: typeof args.clear === "boolean" ? args.clear : null,
    submit: optionalBoolean(args.submit, false),
  };
}

function browserWaitOptions(args: Record<string, unknown>): BrowserWaitOptions {
  const condition = browserWaitCondition(args.condition, args);
  const url = optionalStringArg(args.url);
  const filename = optionalStringArg(args.filename ?? args.file_name ?? args.fileName);
  const text = optionalStringArg(args.text);
  const expression = optionalStringArg(args.expression);
  if (condition === "url" && !url) {
    throw new DesktopBrowserToolServiceError(400, "browser_tool_invalid_args", "url is required for url waits");
  }
  if (condition === "text" && !text) {
    throw new DesktopBrowserToolServiceError(400, "browser_tool_invalid_args", "text is required for text waits");
  }
  if (condition === "function" && !expression) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      "expression is required for function waits",
    );
  }
  return {
    ...browserLocatorOptions(args, { requireLocator: condition === "element" || condition === "hidden" }),
    condition,
    url,
    filename,
    expression,
    loadState: browserWaitLoadState(args.load_state ?? args.loadState),
    timeoutMs: boundedTimeoutMs(args.timeout_ms ?? args.timeoutMs, BROWSER_WAIT_DEFAULT_TIMEOUT_MS),
  };
}

function browserEvaluateOptions(args: Record<string, unknown>): BrowserEvaluateOptions {
  return {
    expression: requiredString(args.expression, "expression"),
    allowMutation: optionalBoolean(args.allow_mutation ?? args.allowMutation, false),
    timeoutMs: boundedTimeoutMs(args.timeout_ms ?? args.timeoutMs, BROWSER_WAIT_DEFAULT_TIMEOUT_MS),
  };
}

function browserDebugOptions(args: Record<string, unknown>): BrowserDebugOptions {
  return {
    x: optionalNumber(args.x),
    y: optionalNumber(args.y),
    includeDomSample: optionalBoolean(args.include_dom_sample ?? args.includeDomSample, false),
  };
}

function browserGetStateOptions(args: Record<string, unknown>): BrowserGetStateOptions {
  const mode = browserGetStateMode(args.mode);
  const detail = browserGetStateDetail(args.detail);
  const scope = browserGetStateScope(args.scope);
  const requestedMaxNodes = optionalPositiveIntegerArg(args.max_nodes ?? args.maxNodes, "max_nodes");
  const maxNodes =
    requestedMaxNodes ??
    (detail === "compact" && mode !== "text" ? BROWSER_GET_STATE_COMPACT_MAX_NODES : null);
  const includePageText = mode === "text" || optionalBoolean(args.include_page_text, false);
  const includeScreenshot = mode === "visual" || optionalBoolean(args.include_screenshot, false);
  const explicitControls =
    args.mode !== undefined ||
    args.detail !== undefined ||
    args.scope !== undefined ||
    args.max_nodes !== undefined ||
    args.maxNodes !== undefined;
  return {
    includePageText,
    includeScreenshot,
    mode,
    detail,
    scope,
    maxNodes,
    sinceRevision: optionalStringArg(args.since_revision ?? args.sinceRevision),
    changedOnly: optionalBoolean(args.changed_only ?? args.changedOnly, false),
    includeMetadata: explicitControls || detail === "compact",
    returnMetadata: explicitControls,
  };
}

function browserStorageGetOptions(
  args: Record<string, unknown>,
): BrowserStorageGetOptions {
  return {
    storage: browserStorageKind(args.storage),
    key: optionalStringArg(args.key),
    keys: optionalStringArrayArg(args.keys, "keys"),
    prefix: optionalStringArg(args.prefix),
    maxEntries: boundedStorageMaxEntries(args.max_entries ?? args.maxEntries),
  };
}

function browserGetConsoleOptions(
  args: Record<string, unknown>,
): BrowserGetConsoleOptions {
  return {
    limit: boundedObservabilityLimit(args.limit),
    level: browserConsoleLevel(args.level),
  };
}

function browserGetErrorsOptions(
  args: Record<string, unknown>,
): BrowserGetErrorsOptions {
  return {
    limit: boundedObservabilityLimit(args.limit),
    source: browserErrorSource(args.source),
  };
}

function browserListRequestsOptions(
  args: Record<string, unknown>,
): BrowserListRequestsOptions {
  return {
    limit: boundedObservabilityLimit(args.limit),
    resourceType: optionalStringArg(args.resource_type ?? args.resourceType),
    failuresOnly: optionalBoolean(args.failures_only ?? args.failuresOnly, false),
  };
}

function browserStorageSetOptions(
  args: Record<string, unknown>,
): BrowserStorageSetOptions {
  const deleteEntry = optionalBoolean(args.delete, false);
  const value = optionalRawStringArg(args.value);
  if (!deleteEntry && value === null) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      "value is required when delete is false",
    );
  }
  return {
    storage: browserStorageKind(args.storage),
    key: requiredString(args.key, "key"),
    value,
    delete: deleteEntry,
  };
}

function browserCookiesGetOptions(
  args: Record<string, unknown>,
): BrowserCookiesGetOptions {
  return {
    url: optionalStringArg(args.url),
    name: optionalStringArg(args.name),
    names: optionalStringArrayArg(args.names, "names"),
    domain: optionalStringArg(args.domain),
    maxResults: boundedCookieMaxResults(args.max_results ?? args.maxResults),
  };
}

function browserCookiesSetOptions(
  args: Record<string, unknown>,
): BrowserCookiesSetOptions {
  const expirationDate = optionalNumber(
    args.expiration_date ?? args.expirationDate,
  );
  if (expirationDate !== null && expirationDate <= 0) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      "expiration_date must be a positive Unix timestamp in seconds",
    );
  }
  return {
    url: optionalStringArg(args.url),
    name: requiredString(args.name, "name"),
    value: optionalRawStringArg(args.value) ?? "",
    domain: optionalStringArg(args.domain),
    path: optionalStringArg(args.path),
    secure: optionalBoolean(args.secure, false),
    httpOnly: optionalBoolean(args.http_only ?? args.httpOnly, false),
    sameSite: browserCookieSameSite(args.same_site ?? args.sameSite),
    expirationDate,
  };
}

function browserInlineWaitOptions(
  value: unknown,
  timeoutValue: unknown,
): BrowserWaitOptions | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      throw new DesktopBrowserToolServiceError(
        400,
        "browser_tool_invalid_args",
        "wait_for must be a non-empty wait condition",
      );
    }
    if (
      normalized === "interactive" ||
      normalized === "domcontentloaded" ||
      normalized === "complete" ||
      normalized === "load"
    ) {
      return browserWaitOptions({
        condition: "load",
        load_state: normalized,
        ...(timeoutValue !== undefined ? { timeout_ms: timeoutValue } : {}),
      });
    }
    return browserWaitOptions({
      condition: normalized,
      ...(timeoutValue !== undefined ? { timeout_ms: timeoutValue } : {}),
    });
  }
  const waitArgs = asRecord(value);
  if (!waitArgs) {
    throw new DesktopBrowserToolServiceError(
      400,
      "browser_tool_invalid_args",
      "wait_for must be a wait condition string or object",
    );
  }
  const resolvedTimeout =
    timeoutValue ?? waitArgs.timeout_ms ?? waitArgs.timeoutMs;
  return browserWaitOptions({
    ...waitArgs,
    ...(resolvedTimeout !== undefined ? { timeout_ms: resolvedTimeout } : {}),
  });
}

function defaultPostStateForBrowserAction(
  action: BrowserActionKind,
): BrowserPostStateMode {
  if (
    action === "click" ||
    action === "double_click" ||
    action === "press"
  ) {
    return "page";
  }
  return "none";
}

function browserPostActionOptions(
  args: Record<string, unknown>,
  defaultPostState: BrowserPostStateMode,
): BrowserPostActionOptions {
  const waitTimeoutValue = args.wait_timeout_ms ?? args.waitTimeoutMs;
  return {
    waitFor: browserInlineWaitOptions(args.wait_for ?? args.waitFor, waitTimeoutValue),
    postState: browserPostStateMode(args.post_state ?? args.postState, defaultPostState),
  };
}

function browserToolDefinition(toolId: string): DesktopBrowserToolDefinition | null {
  return DESKTOP_BROWSER_TOOL_DEFINITIONS.find((tool) => tool.id === toolId) ?? null;
}

function browserToolHeaders(
  config: ProductRuntimeConfig,
  context: DesktopBrowserToolExecutionContext = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "x-holaboss-desktop-token": config.desktopBrowserAuthToken
  };
  const workspaceId = typeof context.workspaceId === "string" ? context.workspaceId.trim() : "";
  if (workspaceId) {
    headers["x-holaboss-workspace-id"] = workspaceId;
  }
  const sessionId = typeof context.sessionId === "string" ? context.sessionId.trim() : "";
  if (sessionId) {
    headers["x-holaboss-session-id"] = sessionId;
  }
  const browserSpace =
    context.space === "user" || context.space === "agent" ? context.space : "";
  if (browserSpace) {
    headers["x-holaboss-browser-space"] = browserSpace;
  }
  return headers;
}

function browserBaseUrl(config: ProductRuntimeConfig): string {
  return config.desktopBrowserUrl.replace(/\/+$/, "");
}

function ensureDesktopBrowserConfig(config: ProductRuntimeConfig): void {
  if (!config.desktopBrowserEnabled || !config.desktopBrowserUrl.trim() || !config.desktopBrowserAuthToken.trim()) {
    throw new DesktopBrowserToolServiceError(
      409,
      "desktop_browser_unavailable",
      "Desktop browser capability is not available in this runtime."
    );
  }
}

function evaluateExpressionPayload(expression: string): Record<string, unknown> {
  return { expression };
}

function serializedValue(value: unknown): string {
  return JSON.stringify(value);
}

function optionalRecordNumber(value: Record<string, unknown> | null, key: string): number | null {
  return optionalInteger(value?.[key]);
}

function browserStateUsageFields(state: Record<string, unknown>): Record<string, unknown> {
  const metadata = asRecord(state.metadata);
  const returned = asRecord(metadata?.returned);
  const totals = asRecord(metadata?.totals);
  const fullPageTotals = asRecord(metadata?.full_page_totals);
  const payload: Record<string, unknown> = {
    page_text_chars: typeof state.text === "string" ? state.text.length : 0,
  };
  const detail = typeof metadata?.detail === "string" ? metadata.detail : null;
  if (detail) {
    payload.detail = detail;
  }
  const maxNodes = optionalRecordNumber(metadata, "max_nodes");
  if (maxNodes !== null) {
    payload.max_nodes = maxNodes;
  }
  const returnedElements = optionalRecordNumber(returned, "elements");
  const returnedMedia = optionalRecordNumber(returned, "media");
  const totalElements = optionalRecordNumber(totals, "elements");
  const totalMedia = optionalRecordNumber(totals, "media");
  if (returnedElements !== null) {
    payload.returned_elements = returnedElements;
  }
  if (returnedMedia !== null) {
    payload.returned_media = returnedMedia;
  }
  if (totalElements !== null) {
    payload.total_elements = totalElements;
  }
  if (totalMedia !== null) {
    payload.total_media = totalMedia;
  }
  const fullPageElements = optionalRecordNumber(fullPageTotals, "elements");
  const fullPageMedia = optionalRecordNumber(fullPageTotals, "media");
  if (fullPageElements !== null) {
    payload.full_page_elements = fullPageElements;
  }
  if (fullPageMedia !== null) {
    payload.full_page_media = fullPageMedia;
  }
  if (metadata?.truncated === true) {
    payload.truncated = true;
  }
  return payload;
}

function browserStateRevisionPayload(
  page: Record<string, unknown>,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = asRecord(state.metadata);
  return {
    page: {
      tabId: optionalStringArg(page.tabId ?? page.tab_id),
      url: optionalStringArg(page.url),
      title: optionalStringArg(page.title),
      loading: page.loading === true,
      initialized: page.initialized !== false,
      canGoBack: page.canGoBack === true,
      canGoForward: page.canGoForward === true,
      error: optionalStringArg(page.error) ?? "",
    },
    state: {
      url: optionalStringArg(state.url),
      title: optionalStringArg(state.title),
      text: typeof state.text === "string" ? state.text : null,
      viewport: asRecord(state.viewport),
      scroll: asRecord(state.scroll),
      elements: Array.isArray(state.elements) ? state.elements : [],
      media: Array.isArray(state.media) ? state.media : [],
      metadata: metadata
        ? {
            mode: optionalStringArg(metadata.mode),
            detail: optionalStringArg(metadata.detail),
            scope: optionalStringArg(metadata.scope),
            max_nodes: optionalInteger(metadata.max_nodes),
            include_page_text: metadata.include_page_text === true,
            lists_included: metadata.lists_included !== false,
            returned: asRecord(metadata.returned),
            totals: asRecord(metadata.totals),
            full_page_totals: asRecord(metadata.full_page_totals),
            truncated: metadata.truncated === true,
          }
        : null,
    },
  };
}

function browserStateRevision(
  page: Record<string, unknown>,
  state: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(browserStateRevisionPayload(page, state)))
    .digest("hex")
    .slice(0, 24);
}

function browserStateWithRevision(
  page: Record<string, unknown>,
  state: Record<string, unknown>,
  options: Pick<BrowserGetStateOptions, "sinceRevision" | "changedOnly">,
): Record<string, unknown> {
  const revision = browserStateRevision(page, state);
  const changed =
    options.sinceRevision !== null ? options.sinceRevision !== revision : true;
  if (options.changedOnly && options.sinceRevision && !changed) {
    return {
      revision,
      changed: false,
    };
  }
  return {
    ...state,
    revision,
    ...(options.sinceRevision !== null ? { changed } : {}),
  };
}

function browserStateForResult(
  state: Record<string, unknown>,
  options: { returnMetadata: boolean },
): Record<string, unknown> {
  if (options.returnMetadata || !("metadata" in state)) {
    return state;
  }
  const { metadata: _metadata, ...rest } = state;
  return rest;
}

function browserLocatorRuntime(locator: BrowserLocatorOptions): string {
  return `
    const interactiveSelector = ${serializedValue(INTERACTIVE_ELEMENTS_SELECTOR)};
    const locator = ${serializedValue({
      ref: locator.ref,
      text: locator.text,
      label: locator.label,
      placeholder: locator.placeholder,
      role: locator.role,
      selector: locator.selector,
      xpath: locator.xpath,
      exact: locator.exact,
      includeHidden: locator.includeHidden,
      scope: locator.scope,
    })};
    const textLimit = ${BROWSER_GET_STATE_ELEMENT_TEXT_MAX_CHARS};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const visibleText = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const intersectsViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    };
    const dialogRoots = Array.from(document.querySelectorAll("dialog[open], [role='dialog'], [aria-modal='true']"))
      .filter((element) => element instanceof HTMLElement && isVisible(element));
    const focusedRoot = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inScope = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (locator.scope === "main") return true;
      if (locator.scope === "viewport") return intersectsViewport(element);
      if (locator.scope === "dialog") return dialogRoots.some((root) => root === element || root.contains(element));
      if (locator.scope === "focused") {
        return focusedRoot ? element === focusedRoot || focusedRoot.contains(element) || element.contains(focusedRoot) : false;
      }
      return true;
    };
    const xpathElements = (xpath) => {
      const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const elements = [];
      for (let index = 0; index < result.snapshotLength; index += 1) {
        const node = result.snapshotItem(index);
        if (node instanceof HTMLElement) elements.push(node);
      }
      return elements;
    };
    const cssEscape = (value) => {
      if (window.CSS && typeof window.CSS.escape === "function") {
        return window.CSS.escape(value);
      }
      return String(value).replace(/[^A-Za-z0-9_-]/g, "\\\\$&");
    };
    const cssPath = (element) => {
      if (!(element instanceof HTMLElement)) return "";
      if (element.id && document.querySelectorAll("#" + cssEscape(element.id)).length === 1) {
        return "css:#" + cssEscape(element.id);
      }
      const parts = [];
      let current = element;
      while (current instanceof HTMLElement && current !== document.documentElement) {
        const parent = current.parentElement;
        if (!parent) break;
        const tag = current.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === current.tagName);
        const nth = siblings.indexOf(current) + 1;
        parts.unshift(tag + ":nth-of-type(" + nth + ")");
        current = parent;
      }
      return "css:html > " + parts.join(" > ");
    };
    const resolveRef = (ref) => {
      if (!ref) return null;
      if (ref.startsWith("css:")) {
        return document.querySelector(ref.slice(4));
      }
      if (ref.startsWith("xpath:")) {
        return xpathElements(ref.slice(6))[0] || null;
      }
      return document.querySelector(ref);
    };
    const hasFrameworkClickHandler = (element) => {
      for (const key of Object.keys(element)) {
        if (!key.startsWith("__reactProps$") && !key.startsWith("__reactEventHandlers$")) continue;
        const value = element[key];
        if (!value || typeof value !== "object") continue;
        if (
          typeof value.onClick === "function" ||
          typeof value.onMouseDown === "function" ||
          typeof value.onPointerDown === "function" ||
          typeof value.onKeyDown === "function"
        ) {
          return true;
        }
      }
      return false;
    };
    const isLikelyClickable = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const explicitRole = String(element.getAttribute("role") || "").toLowerCase();
      if (element.matches(interactiveSelector) || element.hasAttribute("onclick") || typeof element.onclick === "function") return true;
      if (["button", "link", "menuitem", "tab", "checkbox", "radio", "switch"].includes(explicitRole)) return true;
      if (hasFrameworkClickHandler(element)) return true;
      try {
        if (window.getComputedStyle(element).cursor === "pointer") return true;
      } catch {
        return false;
      }
      return false;
    };
    const implicitRole = (element) => {
      const tagName = element.tagName.toLowerCase();
      if (element.getAttribute("role")) return String(element.getAttribute("role") || "").toLowerCase();
      if (tagName === "button") return "button";
      if (tagName === "a" && element.hasAttribute("href")) return "link";
      if (tagName === "textarea") return "textbox";
      if (tagName === "select") return "combobox";
      if (tagName === "option") return "option";
      if (tagName === "input") {
        const type = String(element.getAttribute("type") || "text").toLowerCase();
        if (type === "button" || type === "submit" || type === "reset") return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "search") return "searchbox";
        return "textbox";
      }
      if (element.isContentEditable) return "textbox";
      if (isLikelyClickable(element)) return "button";
      return "";
    };
    const labelText = (element) => {
      const labelledBy = String(element.getAttribute("aria-labelledby") || "")
        .split(/\\s+/g)
        .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
        .join(" ");
      const formLabels = "labels" in element && element.labels
        ? Array.from(element.labels).map((label) => label.innerText || label.textContent || "").join(" ")
        : "";
      return [
        element.getAttribute("aria-label") || "",
        labelledBy,
        element.getAttribute("title") || "",
        "placeholder" in element ? String(element.placeholder || "") : "",
        "value" in element ? String(element.value || "") : "",
        formLabels,
        visibleText(element)
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
    };
    const placeholderText = (element) => "placeholder" in element ? String(element.placeholder || "") : "";
    const stringMatches = (value, expected) => {
      if (!expected) return true;
      const haystack = normalize(value);
      const needle = normalize(expected);
      return locator.exact ? haystack === needle : haystack.includes(needle);
    };
    const matchesLocator = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (!locator.includeHidden && !isVisible(element)) return false;
      if (!inScope(element)) return false;
      if (locator.role) {
        const actionElement = actionableTarget(element);
        const roles = [
          implicitRole(element),
          actionElement instanceof HTMLElement ? implicitRole(actionElement) : ""
        ].map((role) => normalize(role));
        if (!roles.includes(normalize(locator.role))) return false;
      }
      if (!stringMatches(visibleText(element), locator.text)) return false;
      if (!stringMatches(labelText(element), locator.label)) return false;
      if (!stringMatches(placeholderText(element), locator.placeholder)) return false;
      return true;
    };
    const sourceElements = () => {
      if (locator.ref) {
        const resolved = resolveRef(locator.ref);
        return resolved instanceof HTMLElement ? [resolved] : [];
      }
      if (locator.selector) {
        return Array.from(document.querySelectorAll(locator.selector)).filter((element) => element instanceof HTMLElement);
      }
      if (locator.xpath) {
        return xpathElements(locator.xpath);
      }
      return Array.from(document.querySelectorAll("body *")).filter((element) => element instanceof HTMLElement);
    };
    const actionableTarget = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      let current = element;
      let depth = 0;
      while (current instanceof HTMLElement && current !== document.body && depth < 8) {
        if (isLikelyClickable(current) || current.hasAttribute("role") || current.hasAttribute("aria-label")) return current;
        current = current.parentElement;
        depth += 1;
      }
      return element.closest(interactiveSelector + ", [onclick], [role], [aria-label]") || element;
    };
    const scoreElement = (element) => {
      let score = 0;
      if (locator.text && normalize(visibleText(element)) === normalize(locator.text)) score += 120;
      else if (locator.text && stringMatches(visibleText(element), locator.text)) {
        score += 70;
        const haystackLength = normalize(visibleText(element)).length;
        const needleLength = Math.max(normalize(locator.text).length, 1);
        const textRatio = haystackLength / needleLength;
        if (haystackLength > 240 || textRatio > 40) score -= 65;
        else if (textRatio > 10) score -= 35;
        else if (textRatio > 3) score -= 15;
      }
      if (locator.label && normalize(labelText(element)) === normalize(locator.label)) score += 90;
      else if (locator.label && stringMatches(labelText(element), locator.label)) score += 50;
      if (locator.placeholder && stringMatches(placeholderText(element), locator.placeholder)) score += 40;
      if (locator.role && normalize(implicitRole(element)) === normalize(locator.role)) score += 30;
      if (isLikelyClickable(element)) score += 25;
      if (intersectsViewport(element)) score += 10;
      return score;
    };
    const describeElement = (element) => {
      const rect = element.getBoundingClientRect();
      const actionElement = actionableTarget(element);
      return {
        ref: cssPath(element),
        action_ref: actionElement instanceof HTMLElement ? cssPath(actionElement) : cssPath(element),
        tag_name: element.tagName.toLowerCase(),
        role: implicitRole(element),
        text: visibleText(element).slice(0, textLimit),
        label: labelText(element).slice(0, textLimit),
        placeholder: placeholderText(element).slice(0, textLimit),
        disabled: "disabled" in element ? Boolean(element.disabled) : false,
        editable:
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element.isContentEditable,
        href: "href" in element ? String(element.href || "") : "",
        visible: isVisible(element),
        bounding_box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        score: scoreElement(element)
      };
    };
    const findMatches = () => {
      const seen = new Set();
      return sourceElements()
        .filter((element) => matchesLocator(element))
        .filter((element) => {
          const ref = cssPath(element);
          if (!ref || seen.has(ref)) return false;
          seen.add(ref);
          return true;
        })
        .sort((left, right) => {
          const scoreDiff = scoreElement(right) - scoreElement(left);
          if (scoreDiff !== 0) return scoreDiff;
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
        });
    };
  `;
}

function browserFindExpression(options: BrowserFindOptions): string {
  return `(() => {
    ${browserLocatorRuntime(options)}
    const maxResults = ${options.maxResults};
    const allMatches = findMatches();
    const matches = allMatches.slice(0, maxResults).map((element) => describeElement(element));
    return {
      ok: true,
      query: {
        text: locator.text,
        label: locator.label,
        placeholder: locator.placeholder,
        role: locator.role,
        selector: locator.selector,
        xpath: locator.xpath,
        exact: locator.exact,
        include_hidden: locator.includeHidden,
        scope: locator.scope,
        max_results: maxResults
      },
      count: allMatches.length,
      truncated: allMatches.length > matches.length,
      matches
    };
  })()`;
}

function isNativePointerAction(action: BrowserActionKind): action is "click" | "double_click" | "hover" {
  return action === "click" || action === "double_click" || action === "hover";
}

function isNativeTextAction(action: BrowserActionKind): action is "fill" | "type" {
  return action === "fill" || action === "type";
}

function locatorHasTarget(locator: BrowserLocatorOptions): boolean {
  return Boolean(
    locator.ref ||
      locator.text ||
      locator.label ||
      locator.placeholder ||
      locator.role ||
      locator.selector ||
      locator.xpath
  );
}

function browserPointerTargetExpression(options: BrowserActOptions): string {
  return `(() => {
    ${browserLocatorRuntime(options)}
    const action = ${serializedValue(options.action)};
    const targetFromLocator = () => {
      const matched = findMatches()[0] || null;
      return matched || null;
    };
    const target = targetFromLocator();
    if (!(target instanceof HTMLElement)) {
      throw new Error("No browser element matched the requested action locator.");
    }
    const actionTarget = actionableTarget(target) || target;
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof actionTarget.focus === "function") {
      try {
        actionTarget.focus({ preventScroll: true });
      } catch {
        actionTarget.focus();
      }
    }
    const rect = actionTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error("Matched browser element has no clickable area.");
    }
    const x = Math.round(Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)));
    const y = Math.round(Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2)));
    return {
      ok: true,
      action,
      target: describeElement(target),
      action_target: describeElement(actionTarget),
      result: { x, y }
    };
  })()`;
}

function browserKeyboardTargetExpression(
  options: BrowserActOptions,
  params: { requireEditable: boolean },
): string {
  return `(() => {
    ${browserLocatorRuntime(options)}
    const action = ${serializedValue(options.action)};
    const locatorHasTarget = ${locatorHasTarget(options) ? "true" : "false"};
    const requireEditable = ${params.requireEditable ? "true" : "false"};
    const targetFromLocator = () => {
      if (!locatorHasTarget && document.activeElement instanceof HTMLElement) {
        return document.activeElement;
      }
      const matched = locatorHasTarget ? findMatches()[0] || null : null;
      if (matched) return matched;
      if (action === "press" && document.activeElement instanceof HTMLElement) return document.activeElement;
      return null;
    };
    const target = targetFromLocator();
    if (!(target instanceof HTMLElement)) {
      throw new Error("No browser element matched the requested keyboard action locator.");
    }
    const editableTarget = (element) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement ||
        element.isContentEditable
      ) {
        return element;
      }
      return element.querySelector("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
    };
    const actionTarget = requireEditable ? editableTarget(target) : actionableTarget(target) || target;
    if (!(actionTarget instanceof HTMLElement)) {
      throw new Error("No editable browser element matched the requested action locator.");
    }
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof actionTarget.focus === "function") {
      try {
        actionTarget.focus({ preventScroll: true });
      } catch {
        actionTarget.focus();
      }
    }
    return {
      ok: true,
      action,
      target: describeElement(target),
      action_target: describeElement(actionTarget),
      result: { focused: true }
    };
  })()`;
}

function browserActExpression(options: BrowserActOptions): string {
  return `(() => {
    ${browserLocatorRuntime(options)}
    const action = ${serializedValue(options.action)};
    const value = ${serializedValue(options.value)};
    const key = ${serializedValue(options.key)};
    const submit = ${options.submit ? "true" : "false"};
    const clearArg = ${options.clear === null ? "null" : options.clear ? "true" : "false"};
    const targetFromLocator = () => {
      const matched = findMatches()[0] || null;
      if (matched) return matched;
      if (action === "press" && document.activeElement instanceof HTMLElement) return document.activeElement;
      return null;
    };
    const target = targetFromLocator();
    if (!(target instanceof HTMLElement)) {
      throw new Error("No browser element matched the requested action locator.");
    }
    const actionTarget = actionableTarget(target) || target;
    const editableTarget = (element) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement ||
        element.isContentEditable
      ) {
        return element;
      }
      return element.querySelector("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
    };
    const checkableTarget = (element) => {
      if (
        element instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(String(element.type || "").toLowerCase())
      ) {
        return element;
      }
      const explicitRole = String(element.getAttribute("role") || "").toLowerCase();
      if (["checkbox", "radio", "switch"].includes(explicitRole)) {
        return element;
      }
      return element.querySelector("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio'], [role='switch']");
    };
    const setNativeValue = (element, nextValue) => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
        if (descriptor && typeof descriptor.set === "function") {
          descriptor.set.call(element, nextValue);
        } else {
          element.value = nextValue;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return String(element.value || "");
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        element.innerText = nextValue;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return String(element.innerText || "");
      }
      throw new Error("Target element is not text-editable.");
    };
    const dispatchMouse = (element, type, detail = 1) => {
      const rect = element.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        detail
      }));
      return { x, y };
    };
    const pressKey = (element, nextKey) => {
      if (!nextKey) throw new Error("key is required for press actions.");
      for (const type of ["keydown", "keypress", "keyup"]) {
        element.dispatchEvent(new KeyboardEvent(type, { key: nextKey, bubbles: true, cancelable: true }));
      }
      if (nextKey === "Enter" && element instanceof HTMLInputElement && element.form && typeof element.form.requestSubmit === "function") {
        element.form.requestSubmit();
      }
    };
    const checkedState = (element) => {
      if (
        element instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(String(element.type || "").toLowerCase())
      ) {
        return Boolean(element.checked);
      }
      const ariaChecked = String(element.getAttribute("aria-checked") || "").toLowerCase();
      if (ariaChecked === "true") return true;
      if (ariaChecked === "false") return false;
      return null;
    };
    const setCheckableState = (element, desiredChecked) => {
      const currentChecked = checkedState(element);
      if (currentChecked === desiredChecked) {
        return { checked: currentChecked, changed: false };
      }
      if (element instanceof HTMLInputElement) {
        const inputType = String(element.type || "").toLowerCase();
        if (inputType === "radio" && !desiredChecked) {
          throw new Error("Radio buttons cannot be unchecked directly.");
        }
        if (typeof element.focus === "function") element.focus();
        if (typeof element.click === "function") element.click();
        const clickedState = checkedState(element);
        if (clickedState === desiredChecked) {
          return { checked: clickedState, changed: true };
        }
        element.checked = desiredChecked;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { checked: Boolean(element.checked), changed: true };
      }
      const explicitRole = String(element.getAttribute("role") || "").toLowerCase();
      if (explicitRole === "radio" && !desiredChecked) {
        throw new Error("Radio buttons cannot be unchecked directly.");
      }
      if (typeof element.focus === "function") element.focus();
      if (typeof element.click === "function") element.click();
      const clickedState = checkedState(element);
      if (clickedState === desiredChecked) {
        return { checked: clickedState, changed: true };
      }
      if (["checkbox", "radio", "switch"].includes(explicitRole)) {
        element.setAttribute("aria-checked", desiredChecked ? "true" : "false");
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { checked: desiredChecked, changed: true };
      }
      throw new Error("Target element is not checkable.");
    };
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof target.focus === "function") target.focus();
    let actionResult = {};
    let describedActionTarget = actionTarget;
    if (action === "click" || action === "double_click") {
      if (typeof actionTarget.focus === "function") actionTarget.focus();
      const point = dispatchMouse(actionTarget, "mousemove");
      dispatchMouse(actionTarget, "mousedown");
      dispatchMouse(actionTarget, "mouseup");
      if (typeof actionTarget.click === "function") actionTarget.click();
      if (action === "double_click") {
        dispatchMouse(actionTarget, "mousedown", 2);
        dispatchMouse(actionTarget, "mouseup", 2);
        dispatchMouse(actionTarget, "dblclick", 2);
      }
      actionResult = point;
    } else if (action === "hover") {
      actionResult = dispatchMouse(actionTarget, "mouseover");
      dispatchMouse(actionTarget, "mousemove");
    } else if (action === "focus") {
      if (typeof actionTarget.focus === "function") actionTarget.focus();
    } else if (action === "fill" || action === "type") {
      if (value === null) throw new Error("value is required for fill and type actions.");
      const editTarget = editableTarget(target);
      if (!(editTarget instanceof HTMLElement)) throw new Error("No editable element matched the requested action locator.");
      if (typeof editTarget.focus === "function") editTarget.focus();
      const clear = clearArg === null ? action === "fill" : clearArg;
      const currentValue = "value" in editTarget ? String(editTarget.value || "") : String(editTarget.innerText || "");
      const nextValue = clear ? value : currentValue + value;
      const storedValue = setNativeValue(editTarget, nextValue);
      if (submit) pressKey(editTarget, "Enter");
      actionResult = { value: storedValue };
    } else if (action === "press") {
      pressKey(target, key);
      actionResult = { key };
    } else if (action === "select") {
      if (value === null) throw new Error("value is required for select actions.");
      const selectTarget = editableTarget(target);
      if (!(selectTarget instanceof HTMLSelectElement)) throw new Error("Target element is not a select.");
      const option = Array.from(selectTarget.options).find((entry) => entry.value === value || normalize(entry.textContent) === normalize(value));
      if (!option) throw new Error("No select option matched the requested value.");
      selectTarget.value = option.value;
      selectTarget.dispatchEvent(new Event("input", { bubbles: true }));
      selectTarget.dispatchEvent(new Event("change", { bubbles: true }));
      actionResult = { value: selectTarget.value, selected_text: option.textContent || "" };
    } else if (action === "check" || action === "uncheck") {
      const toggleTarget = checkableTarget(target);
      if (!(toggleTarget instanceof HTMLElement)) {
        throw new Error("No checkable element matched the requested action locator.");
      }
      describedActionTarget = toggleTarget;
      const nextChecked = action === "check";
      const toggled = setCheckableState(toggleTarget, nextChecked);
      actionResult = {
        checked: toggled.checked,
        changed: toggled.changed,
      };
    } else if (action === "scroll_into_view") {
      target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }
    return {
      ok: true,
      action,
      target: describeElement(target),
      action_target: describeElement(describedActionTarget),
      result: actionResult
    };
  })()`;
}

function browserDomSignatureExpression(): string {
  return `(() => {
    const body = document.body;
    return {
      url: location.href,
      title: document.title,
      ready_state: document.readyState,
      text_length: String(body?.innerText || "").length,
      element_count: document.querySelectorAll("body *").length,
      active_tag: document.activeElement instanceof HTMLElement ? document.activeElement.tagName.toLowerCase() : ""
    };
  })()`;
}

function browserWaitPredicateExpression(options: BrowserWaitOptions, baseline: Record<string, unknown> | null): string {
  const locatorForWait: BrowserLocatorOptions = {
    ...options,
    includeHidden: options.condition === "hidden" ? false : options.includeHidden,
  };
  return `(async () => {
    ${browserLocatorRuntime(locatorForWait)}
    const condition = ${serializedValue(options.condition)};
    const expectedUrl = ${serializedValue(options.url)};
    const baseline = ${serializedValue(baseline)};
    const textNeedle = ${serializedValue(options.text)};
    const functionSource = ${serializedValue(options.expression)};
    const loadState = ${serializedValue(options.loadState)};
    const matchesUrl = (value, expected) => {
      if (!expected) return false;
      if (expected.startsWith("/") && expected.endsWith("/") && expected.length > 2) {
        try {
          return new RegExp(expected.slice(1, -1)).test(value);
        } catch {
          return value.includes(expected);
        }
      }
      return value.includes(expected);
    };
    const bodyText = String(document.body?.innerText || "").replace(/\\s+/g, " ").trim();
    const currentSignature = {
      url: location.href,
      title: document.title,
      ready_state: document.readyState,
      text_length: bodyText.length,
      element_count: document.querySelectorAll("body *").length,
      active_tag: document.activeElement instanceof HTMLElement ? document.activeElement.tagName.toLowerCase() : ""
    };
    const evaluateFunctionWait = async () => {
      if (!functionSource) return false;
      const evaluated = (0, eval)("(" + functionSource + ")");
      const result = typeof evaluated === "function" ? await evaluated() : await evaluated;
      return result;
    };
    const functionResult = condition === "function" ? await evaluateFunctionWait() : null;
    const loadMatched =
      loadState === "interactive"
        ? document.readyState === "interactive" || document.readyState === "complete"
        : document.readyState === "complete";
    const matches = condition === "load"
      ? loadMatched
      : condition === "url"
        ? matchesUrl(location.href, expectedUrl || "")
        : condition === "text"
          ? stringMatches(bodyText, textNeedle)
          : condition === "element"
            ? findMatches().length > 0
            : condition === "hidden"
              ? findMatches().length === 0
              : condition === "function"
                ? Boolean(functionResult)
                : JSON.stringify(currentSignature) !== JSON.stringify(baseline || {});
    return {
      ok: true,
      matched: matches,
      condition,
      load_state: condition === "load" ? loadState : null,
      match_count: condition === "element" || condition === "hidden" ? findMatches().length : null,
      function_result: condition === "function"
        ? (functionResult === undefined ? null : functionResult)
        : null,
      current: currentSignature
    };
  })()`;
}

function browserEvaluateExpression(options: BrowserEvaluateOptions): string {
  return `(async () => {
    const result = await (${options.expression});
    return {
      ok: true,
      allow_mutation: ${options.allowMutation ? "true" : "false"},
      result: result === undefined ? null : result
    };
  })()`;
}

function browserStorageGetExpression(options: BrowserStorageGetOptions): string {
  return `(() => {
    const storageKind = ${serializedValue(options.storage)};
    const targetStorage = storageKind === "session" ? window.sessionStorage : window.localStorage;
    if (!targetStorage) {
      throw new Error("Requested browser storage is not available.");
    }
    const key = ${serializedValue(options.key)};
    const explicitKeys = ${serializedValue(options.keys)};
    const prefix = ${serializedValue(options.prefix)};
    const maxEntries = ${String(options.maxEntries)};
    const seenKeys = new Set();
    const entries = [];
    const pushEntry = (entryKey) => {
      if (!entryKey || seenKeys.has(entryKey)) return;
      if (prefix && !String(entryKey).startsWith(prefix)) return;
      seenKeys.add(entryKey);
      if (entries.length >= maxEntries) return;
      const entryValue = targetStorage.getItem(entryKey);
      entries.push({
        key: entryKey,
        value: entryValue === null ? null : String(entryValue),
      });
    };
    if (key) {
      pushEntry(key);
    }
    for (const explicitKey of explicitKeys) {
      pushEntry(explicitKey);
    }
    if (!key && explicitKeys.length === 0) {
      for (let index = 0; index < targetStorage.length; index += 1) {
        const entryKey = targetStorage.key(index);
        if (entryKey) {
          pushEntry(entryKey);
        }
      }
    }
    return {
      ok: true,
      storage: storageKind,
      key,
      prefix,
      count: entries.length,
      truncated: entries.length >= maxEntries && targetStorage.length > entries.length,
      entries,
      value: key ? (entries[0]?.value ?? null) : null,
      available_keys: Math.min(targetStorage.length, maxEntries),
    };
  })()`;
}

function browserStorageSetExpression(options: BrowserStorageSetOptions): string {
  return `(() => {
    const storageKind = ${serializedValue(options.storage)};
    const targetStorage = storageKind === "session" ? window.sessionStorage : window.localStorage;
    if (!targetStorage) {
      throw new Error("Requested browser storage is not available.");
    }
    const key = ${serializedValue(options.key)};
    const deleteEntry = ${options.delete ? "true" : "false"};
    const nextValue = ${serializedValue(options.value ?? "")};
    const previousValue = targetStorage.getItem(key);
    if (deleteEntry) {
      targetStorage.removeItem(key);
    } else {
      targetStorage.setItem(key, nextValue);
    }
    return {
      ok: true,
      storage: storageKind,
      key,
      deleted: deleteEntry,
      existed: previousValue !== null,
      previous_value: previousValue === null ? null : String(previousValue),
      value: deleteEntry ? null : String(targetStorage.getItem(key) || ""),
    };
  })()`;
}

function browserDebugExpression(options: BrowserDebugOptions): string {
  return `(() => {
    const includeDomSample = ${options.includeDomSample ? "true" : "false"};
    const pointX = ${options.x === null ? "Math.round(window.innerWidth / 2)" : String(options.x)};
    const pointY = ${options.y === null ? "Math.round(window.innerHeight / 2)" : String(options.y)};
    const describe = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return {
        tag_name: element.tagName.toLowerCase(),
        id: element.id || "",
        class_name: String(element.className || "").slice(0, 120),
        role: element.getAttribute("role") || "",
        aria_label: element.getAttribute("aria-label") || "",
        text: String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160),
        bounding_box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    };
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const hitElement = document.elementFromPoint(pointX, pointY);
    const dialogs = Array.from(document.querySelectorAll("dialog[open], [role='dialog'], [aria-modal='true']"))
      .map((element) => describe(element))
      .filter(Boolean);
    const iframes = Array.from(document.querySelectorAll("iframe"))
      .map((frame) => ({
        title: frame.getAttribute("title") || "",
        src: frame.getAttribute("src") || "",
        ...(() => {
          const rect = frame.getBoundingClientRect();
          return {
            bounding_box: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          };
        })()
      }));
    const domSample = includeDomSample
      ? Array.from(document.querySelectorAll("body *"))
          .filter((element) => element instanceof HTMLElement)
          .slice(0, 40)
          .map((element) => describe(element))
          .filter(Boolean)
      : undefined;
    return {
      ok: true,
      url: location.href,
      title: document.title,
      ready_state: document.readyState,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      active_element: describe(activeElement),
      hit_test: {
        x: pointX,
        y: pointY,
        element: describe(hitElement)
      },
      dialogs,
      iframes,
      console_logs_available: false,
      network_log_available: false,
      ...(domSample ? { dom_sample: domSample } : {})
    };
  })()`;
}

function interactiveElementsExpression(options: BrowserGetStateOptions): string {
  return `(() => {
    const selector = ${serializedValue(INTERACTIVE_ELEMENTS_SELECTOR)};
    const mediaSelector = ${serializedValue(VISIBLE_MEDIA_SELECTOR)};
    const includePageText = ${options.includePageText ? "true" : "false"};
    const includeMetadata = ${options.includeMetadata ? "true" : "false"};
    const mode = ${serializedValue(options.mode)};
    const detail = ${serializedValue(options.detail)};
    const scope = ${serializedValue(options.scope)};
    const maxNodes = ${options.maxNodes === null ? "null" : String(options.maxNodes)};
    const textLimit = ${BROWSER_GET_STATE_ELEMENT_TEXT_MAX_CHARS};
    const mediaTextLimit = ${BROWSER_GET_STATE_MEDIA_TEXT_MAX_CHARS};
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const intersectsViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    };
    const dialogRoots = Array.from(document.querySelectorAll("dialog[open], [role='dialog'], [aria-modal='true']"))
      .filter((element) => element instanceof HTMLElement && isVisible(element));
    const focusedRoot = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inScope = (element) => {
      if (scope === "main") return true;
      if (scope === "viewport") return intersectsViewport(element);
      if (scope === "dialog") return dialogRoots.some((root) => root === element || root.contains(element));
      if (scope === "focused") {
        return focusedRoot ? element === focusedRoot || focusedRoot.contains(element) || element.contains(focusedRoot) : false;
      }
      return true;
    };
    const describe = (element, index) => {
      const rect = element.getBoundingClientRect();
      const tagName = element.tagName.toLowerCase();
      const role = element.getAttribute("role") || "";
      const type = "type" in element ? String(element.type || "") : "";
      const text = (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, textLimit);
      const label = [
        element.getAttribute("aria-label") || "",
        "placeholder" in element ? String(element.placeholder || "") : "",
        "value" in element ? String(element.value || "") : "",
        text
      ].find((value) => Boolean(value)) || "";
      return {
        index,
        tag_name: tagName,
        role,
        type,
        text,
        label: label.slice(0, textLimit),
        disabled: "disabled" in element ? Boolean(element.disabled) : false,
        href: "href" in element ? String(element.href || "") : "",
        bounding_box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    };
    const describeMedia = (element, index) => {
      const rect = element.getBoundingClientRect();
      const tagName = element.tagName.toLowerCase();
      const alt = element instanceof HTMLImageElement ? String(element.alt || "") : "";
      const ariaLabel = element.getAttribute("aria-label") || "";
      const text = (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, mediaTextLimit);
      const label = [alt, ariaLabel, text].find((value) => Boolean(value)) || "";
      const anchor = typeof element.closest === "function" ? element.closest("a[href]") : null;
      const currentSrc =
        element instanceof HTMLImageElement
          ? String(element.currentSrc || element.src || "")
          : element instanceof HTMLVideoElement
            ? String(element.currentSrc || element.poster || "")
            : element instanceof HTMLCanvasElement
              ? ""
              : String(element.getAttribute("src") || "");
      const mediaType =
        element instanceof HTMLImageElement
          ? "image"
          : element instanceof HTMLVideoElement
            ? "video"
            : element instanceof HTMLCanvasElement
              ? "canvas"
              : "media";
      return {
        index,
        media_type: mediaType,
        tag_name: tagName,
        label: label.slice(0, mediaTextLimit),
        alt: alt.slice(0, mediaTextLimit),
        text,
        src: "src" in element ? String(element.getAttribute("src") || "") : "",
        current_src: currentSrc,
        link_href: anchor instanceof HTMLAnchorElement ? String(anchor.href || "") : "",
        bounding_box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    };
    const nodes = Array.from(document.querySelectorAll(selector))
      .filter((element) => isVisible(element))
      .filter((element, index, all) => all.indexOf(element) === index)
      .map((element, index) => ({ element, index: index + 1 }));
    const mediaNodes = Array.from(document.querySelectorAll(mediaSelector))
      .filter((element) => isVisible(element))
      .filter((element, index, all) => all.indexOf(element) === index)
      .map((element, index) => ({ element, index: index + 1 }));
    const scopedNodes = nodes.filter((entry) => inScope(entry.element));
    const scopedMediaNodes = mediaNodes.filter((entry) => inScope(entry.element));
    const includeNodeLists = mode !== "text";
    let remainingNodes = typeof maxNodes === "number" && maxNodes > 0 ? maxNodes : null;
    const takeNodes = (entries) => {
      if (!includeNodeLists) return [];
      if (remainingNodes === null) return entries;
      const selected = entries.slice(0, remainingNodes);
      remainingNodes = Math.max(0, remainingNodes - selected.length);
      return selected;
    };
    const returnedNodes = takeNodes(scopedNodes);
    const returnedMediaNodes = takeNodes(scopedMediaNodes);
    const scopedText = () => {
      if (scope === "main") {
        return (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, ${BROWSER_GET_STATE_TEXT_MAX_CHARS});
      }
      if (scope === "viewport") {
        const body = document.body;
        if (!body) return "";
        return Array.from(body.querySelectorAll("*"))
          .filter((element) => element instanceof HTMLElement && isVisible(element) && intersectsViewport(element))
          .map((element) => (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim())
          .filter((text) => Boolean(text))
          .join(" ")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, ${BROWSER_GET_STATE_TEXT_MAX_CHARS});
      }
      const roots = scope === "dialog" ? dialogRoots : focusedRoot ? [focusedRoot] : [];
      return roots
        .map((element) => (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim())
        .filter((text) => Boolean(text))
        .join(" ")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, ${BROWSER_GET_STATE_TEXT_MAX_CHARS});
    };
    const truncated = includeNodeLists && (returnedNodes.length < scopedNodes.length || returnedMediaNodes.length < scopedMediaNodes.length);
    const result = {
      url: location.href,
      title: document.title,
      ...(includePageText ? { text: scopedText() } : {}),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      elements: returnedNodes.map((entry) => describe(entry.element, entry.index)),
      media: returnedMediaNodes.map((entry) => describeMedia(entry.element, entry.index))
    };
    if (includeMetadata) {
      result.metadata = {
        schema_version: 2,
        mode,
        detail,
        scope,
        max_nodes: maxNodes,
        include_page_text: includePageText,
        include_screenshot: ${options.includeScreenshot ? "true" : "false"},
        lists_included: includeNodeLists,
        returned: {
          elements: returnedNodes.length,
          media: returnedMediaNodes.length
        },
        totals: {
          elements: scopedNodes.length,
          media: scopedMediaNodes.length
        },
        full_page_totals: scope === "main" ? null : {
          elements: nodes.length,
          media: mediaNodes.length
        },
        truncated
      };
    }
    return result;
  })()`;
}

function contextClickTargetExpression(target: BrowserTargetKind, index: number): string {
  return `(() => {
    const selector = ${serializedValue(INTERACTIVE_ELEMENTS_SELECTOR)};
    const mediaSelector = ${serializedValue(VISIBLE_MEDIA_SELECTOR)};
    const targetKind = ${serializedValue(target)};
    const targetIndex = ${index};
    const textLimit = ${BROWSER_GET_STATE_ELEMENT_TEXT_MAX_CHARS};
    const mediaTextLimit = ${BROWSER_GET_STATE_MEDIA_TEXT_MAX_CHARS};
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const describe = (element) => {
      const text = (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, textLimit);
      const label = [
        element.getAttribute("aria-label") || "",
        "placeholder" in element ? String(element.placeholder || "") : "",
        "value" in element ? String(element.value || "") : "",
        text
      ].find((value) => Boolean(value)) || "";
      return {
        text,
        label: label.slice(0, textLimit)
      };
    };
    const describeMedia = (element) => {
      const alt = element instanceof HTMLImageElement ? String(element.alt || "") : "";
      const ariaLabel = element.getAttribute("aria-label") || "";
      const text = (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, mediaTextLimit);
      const label = [alt, ariaLabel, text].find((value) => Boolean(value)) || "";
      return {
        text,
        label: label.slice(0, mediaTextLimit)
      };
    };
    const candidates = Array.from(document.querySelectorAll(targetKind === "media" ? mediaSelector : selector))
      .filter((element) => isVisible(element))
      .filter((element, idx, all) => all.indexOf(element) === idx);
    const target = candidates[targetIndex - 1] || null;
    if (!target) {
      throw new Error(targetKind === "media"
        ? ${serializedValue(`No visible media found for index ${index}.`)}
        : ${serializedValue(`No interactive element found for index ${index}.`)});
    }
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof target.focus === "function") target.focus();
    const rect = target.getBoundingClientRect();
    const centerX = Math.round(rect.left + rect.width / 2);
    const centerY = Math.round(rect.top + rect.height / 2);
    return {
      ok: true,
      target_kind: targetKind,
      index: targetIndex,
      x: centerX,
      y: centerY,
      tag_name: target.tagName.toLowerCase(),
      ...(targetKind === "media" ? describeMedia(target) : describe(target))
    };
  })()`;
}

function clickExpression(index: number): string {
  return `(() => {
    const selector = ${serializedValue(INTERACTIVE_ELEMENTS_SELECTOR)};
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const target = Array.from(document.querySelectorAll(selector)).filter((element) => isVisible(element))[${index - 1}] || null;
    if (!target) {
      throw new Error(${serializedValue(`No interactive element found for index ${index}.`)});
    }
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof target.focus === "function") target.focus();
    if (typeof target.click === "function") target.click();
    return {
      ok: true,
      index: ${index},
      tag_name: target.tagName.toLowerCase(),
      text: (target.innerText || target.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200)
    };
  })()`;
}

function browserTargetKind(value: unknown): BrowserTargetKind {
  if (value === undefined) {
    return "element";
  }
  if (value === "element" || value === "media") {
    return value;
  }
  throw new DesktopBrowserToolServiceError(
    400,
    "browser_tool_invalid_args",
    "target must be `element` or `media`",
  );
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function normalizedScreenshotMimeType(value: unknown): string {
  const raw =
    typeof value === "string" && value.trim()
      ? value.trim().toLowerCase()
      : "";
  if (raw === "image/jpeg" || raw === "image/jpg") {
    return "image/jpeg";
  }
  if (raw === "image/webp") {
    return "image/webp";
  }
  return "image/png";
}

function screenshotExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  return ".png";
}

function safePathSegment(value: string, fallback: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

function timestampPathSegment(date = new Date()): string {
  return date.toISOString().replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
}

function screenshotBase64(value: Record<string, unknown>): string | null {
  const raw = value.base64;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function browserGetStateWarnings(params: {
  page: Record<string, unknown>;
  state: Record<string, unknown>;
  screenshot?: Record<string, unknown>;
  includeScreenshot: boolean;
}): string[] {
  const warnings: string[] = [];
  if (params.page.loading === true) {
    warnings.push("Browser page is still loading; page state may be incomplete.");
  }
  if (params.page.initialized === false) {
    warnings.push("Browser page is not fully initialized yet.");
  }
  const viewport = asRecord(params.state.viewport);
  if (
    positiveNumber(viewport?.width) === null ||
    positiveNumber(viewport?.height) === null
  ) {
    warnings.push("Browser page reported a 0x0 viewport.");
  }
  if (params.includeScreenshot) {
    const screenshot = params.screenshot ?? {};
    if (
      positiveNumber(screenshot.width) === null ||
      positiveNumber(screenshot.height) === null
    ) {
      warnings.push("Browser screenshot capture reported 0x0 dimensions.");
    }
  }
  if (asRecord(params.state.metadata)?.truncated === true) {
    warnings.push(
      "Browser state snapshot is truncated; use browser_find, increase max_nodes, or set detail=standard if a target is missing.",
    );
  }
  return warnings;
}

function browserGetStateSnapshotReady(params: {
  page: Record<string, unknown>;
  state: Record<string, unknown>;
  screenshot?: Record<string, unknown>;
  includeScreenshot: boolean;
}): boolean {
  return browserGetStateWarnings(params).length === 0;
}

function indexedKeyboardTargetExpression(index: number): string {
  return `(() => {
    const selector = ${serializedValue(INTERACTIVE_ELEMENTS_SELECTOR)};
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const target = Array.from(document.querySelectorAll(selector)).filter((element) => isVisible(element))[${index - 1}] || null;
    if (!(target instanceof HTMLElement)) {
      throw new Error(${serializedValue(`No interactive element found for index ${index}.`)});
    }
    const editTarget =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
        ? target
        : target.querySelector("input, textarea, [contenteditable]:not([contenteditable='false'])");
    if (!(editTarget instanceof HTMLElement)) {
      throw new Error(${serializedValue(`Element at index ${index} is not text-editable.`)});
    }
    editTarget.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof editTarget.focus === "function") {
      try {
        editTarget.focus({ preventScroll: true });
      } catch {
        editTarget.focus();
      }
    }
    return {
      ok: true,
      index: ${index},
      tag_name: editTarget.tagName.toLowerCase(),
      role: editTarget.getAttribute("role") || "",
      editable: true
    };
  })()`;
}

function scrollExpression(deltaY: number): string {
  return `(() => {
    window.scrollBy({ top: ${deltaY}, left: 0, behavior: "instant" });
    return {
      ok: true,
      scroll_y: Math.round(window.scrollY)
    };
  })()`;
}

function historyExpression(direction: "back" | "forward"): string {
  return `(() => {
    history.${direction}();
    return { ok: true, direction: ${serializedValue(direction)} };
  })()`;
}

function reloadExpression(): string {
  return `(() => {
    location.reload();
    return { ok: true };
  })()`;
}

export class DesktopBrowserToolService implements DesktopBrowserToolServiceLike {
  readonly #fetch: typeof fetch;
  readonly #resolveConfig: () => ProductRuntimeConfig;
  readonly #artifactStore: BrowserScreenshotArtifactStore | null;

  constructor(options: DesktopBrowserToolServiceOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#artifactStore = options.artifactStore ?? null;
    this.#resolveConfig =
      options.resolveConfig ??
      (() =>
        resolveProductRuntimeConfig({
          requireAuth: false,
          requireUser: false,
          requireBaseUrl: false
        }));
  }

  async getStatus(context: DesktopBrowserToolExecutionContext = {}): Promise<Record<string, unknown>> {
    const config = this.#resolveConfig();
    const configured = Boolean(
      config.desktopBrowserEnabled && config.desktopBrowserUrl.trim() && config.desktopBrowserAuthToken.trim()
    );
    let reachable = false;
    if (configured) {
      try {
        await this.#browserFetch(config, {
          method: "GET",
          path: "/health",
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        reachable = true;
      } catch {
        reachable = false;
      }
    }
    return {
      available: configured && reachable,
      configured,
      reachable,
      backend: configured ? "desktop_http" : null,
      tools: DESKTOP_BROWSER_TOOL_DEFINITIONS
    };
  }

  async execute(
    toolId: string,
    args: Record<string, unknown>,
    context: DesktopBrowserToolExecutionContext = {}
  ): Promise<Record<string, unknown>> {
    const definition = browserToolDefinition(toolId);
    if (!definition) {
      throw new DesktopBrowserToolServiceError(404, "browser_tool_unknown", `Unknown browser tool '${toolId}'`);
    }

    const config = this.#resolveConfig();
    ensureDesktopBrowserConfig(config);

    switch (definition.id) {
      case "browser_navigate": {
        const startedAt = Date.now();
        const url = requiredString(args.url, "url");
        const result = await this.#browserFetch(config, {
          method: "POST",
          path: "/navigate",
          body: { url },
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          navigation: result,
          browser_usage: {
            tool_id: "browser_navigate",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_open_tab": {
        const startedAt = Date.now();
        const url = requiredString(args.url, "url");
        const result = await this.#browserFetch(config, {
          method: "POST",
          path: "/tabs",
          body: {
            url,
            background: optionalBoolean(args.background, false)
          },
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          tabs: result,
          browser_usage: {
            tool_id: "browser_open_tab",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_select_tab": {
        const startedAt = Date.now();
        const tabId = requiredString(args.tab_id ?? args.tabId, "tab_id");
        const result = await this.#browserFetch(config, {
          method: "POST",
          path: "/tabs/select",
          body: { tab_id: tabId },
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          tabs: result,
          browser_usage: {
            tool_id: "browser_select_tab",
            elapsed_ms: Date.now() - startedAt,
            tab_id: tabId,
          },
        };
      }
      case "browser_close_tab": {
        const startedAt = Date.now();
        const tabId = requiredString(args.tab_id ?? args.tabId, "tab_id");
        const result = await this.#browserFetch(config, {
          method: "POST",
          path: "/tabs/close",
          body: { tab_id: tabId },
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          tabs: result,
          browser_usage: {
            tool_id: "browser_close_tab",
            elapsed_ms: Date.now() - startedAt,
            tab_id: tabId,
          },
        };
      }
      case "browser_get_state": {
        const startedAt = Date.now();
        const options = browserGetStateOptions(args);
        const snapshot = await this.#readBrowserGetStateSnapshot(
          config,
          context,
          options,
        );
        const stateWithRevision = browserStateWithRevision(
          snapshot.page,
          snapshot.state,
          options,
        );
        const stateForResult = browserStateForResult(stateWithRevision, options);
        const currentRevision = optionalStringArg(stateWithRevision.revision);
        const changed =
          typeof stateWithRevision.changed === "boolean"
            ? stateWithRevision.changed
            : null;
        const payload: Record<string, unknown> = {
          ok: true,
          page: snapshot.page,
          state: stateForResult,
          browser_usage: {
            tool_id: "browser_get_state",
            elapsed_ms: Date.now() - startedAt,
            mode: options.mode,
            detail: options.detail,
            scope: options.scope,
            include_page_text: options.includePageText,
            include_screenshot: options.includeScreenshot,
            since_revision: options.sinceRevision,
            changed_only: options.changedOnly,
            revision: currentRevision,
            changed,
            ...browserStateUsageFields(snapshot.state),
          },
        };
        const warnings = browserGetStateWarnings({
          page: snapshot.page,
          state: snapshot.state,
          screenshot: snapshot.screenshot,
          includeScreenshot: options.includeScreenshot,
        });
        if (snapshot.screenshot) {
          const screenshot = await this.#screenshotForToolResult({
            screenshot: snapshot.screenshot,
            context,
            sourceToolId: "browser_get_state",
            page: snapshot.page,
            state: snapshot.state,
          });
          payload.screenshot = screenshot.result;
          if (screenshot.warning) {
            warnings.push(screenshot.warning);
          }
        }
        if (warnings.length > 0) {
          payload.warnings = warnings;
        }
        return payload;
      }
      case "browser_find": {
        const startedAt = Date.now();
        const options = browserFindOptions(args);
        const result = await this.#evaluate(config, browserFindExpression(options), context);
        return {
          ok: true,
          find: result,
          browser_usage: {
            tool_id: "browser_find",
            elapsed_ms: Date.now() - startedAt,
            count: optionalInteger(result.count),
            truncated: result.truncated === true,
          },
        };
      }
      case "browser_act": {
        const startedAt = Date.now();
        const options = browserActOptions(args);
        const postAction = browserPostActionOptions(
          args,
          defaultPostStateForBrowserAction(options.action),
        );
        if (isNativeTextAction(options.action) && options.value === null) {
          throw new DesktopBrowserToolServiceError(
            400,
            "browser_tool_invalid_args",
            "value is required for fill and type actions"
          );
        }
        if (options.action === "press" && !options.key) {
          throw new DesktopBrowserToolServiceError(
            400,
            "browser_tool_invalid_args",
            "key is required for press actions"
          );
        }
        let result = isNativePointerAction(options.action) ||
          isNativeTextAction(options.action) ||
          options.action === "press"
          ? {}
          : await this.#evaluate(
              config,
              browserActExpression(options),
              context,
            );
        if (isNativePointerAction(options.action)) {
          const nativeInput = await this.#browserFetch(config, {
            method: "POST",
            path: "/mouse",
            body: {
              action: options.action,
              expression: browserPointerTargetExpression(options),
            },
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            space: context.space,
          });
          const nativeInputResult = { ...nativeInput };
          const resolvedAction = asRecord(nativeInputResult.resolved_action) ?? {};
          delete nativeInputResult.resolved_action;
          result = {
            ...resolvedAction,
            result: {
              ...(asRecord(resolvedAction.result) ?? {}),
              native_input: nativeInputResult,
            },
          };
        } else if (isNativeTextAction(options.action)) {
          const nativeInput = await this.#browserFetch(config, {
            method: "POST",
            path: "/keyboard",
            body: {
              action: "insert_text",
              expression: browserKeyboardTargetExpression(options, { requireEditable: true }),
              text: options.value ?? "",
              clear: options.clear === null ? options.action === "fill" : options.clear,
              submit: options.submit,
            },
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            space: context.space,
          });
          const nativeInputResult = { ...nativeInput };
          const resolvedAction = asRecord(nativeInputResult.resolved_action) ?? {};
          delete nativeInputResult.resolved_action;
          result = {
            ...resolvedAction,
            result: {
              ...(asRecord(resolvedAction.result) ?? {}),
              value: options.value ?? "",
              native_input: nativeInputResult,
            },
          };
        } else if (options.action === "press") {
          const nativeInput = await this.#browserFetch(config, {
            method: "POST",
            path: "/keyboard",
            body: {
              action: "press",
              expression: browserKeyboardTargetExpression(options, { requireEditable: false }),
              key: options.key ?? "",
            },
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            space: context.space,
          });
          const nativeInputResult = { ...nativeInput };
          const resolvedAction = asRecord(nativeInputResult.resolved_action) ?? {};
          delete nativeInputResult.resolved_action;
          result = {
            ...resolvedAction,
            result: {
              ...(asRecord(resolvedAction.result) ?? {}),
              key: options.key ?? "",
              native_input: nativeInputResult,
            },
          };
        }
        const wait =
          postAction.waitFor
            ? await this.#waitForBrowserCondition(config, context, postAction.waitFor)
            : null;
        const followUp = await this.#readPostActionState(
          config,
          context,
          postAction.postState,
        );
        return {
          ok: true,
          action: result,
          ...(wait ? { wait } : {}),
          ...(followUp.page ? { page: followUp.page } : {}),
          ...(followUp.state ? { state: followUp.state } : {}),
          browser_usage: {
            tool_id: "browser_act",
            elapsed_ms: Date.now() - startedAt,
            action: options.action,
            post_state: postAction.postState,
            ...(wait
              ? {
                  wait_condition: wait.condition,
                  wait_matched: wait.matched === true,
                  wait_attempts: optionalInteger(wait.attempts),
                  wait_elapsed_ms: optionalInteger(wait.elapsed_ms),
                }
              : {}),
            ...(followUp.stateWithMetadata
              ? browserStateUsageFields(followUp.stateWithMetadata)
              : {}),
          },
        };
      }
      case "browser_wait": {
        const startedAt = Date.now();
        const options = browserWaitOptions(args);
        const result = await this.#waitForBrowserCondition(config, context, options);
        return {
          ok: true,
          wait: result,
          browser_usage: {
            tool_id: "browser_wait",
            elapsed_ms: Date.now() - startedAt,
            condition: options.condition,
            load_state: options.condition === "load" ? options.loadState : null,
            url: options.url,
            filename: options.filename,
            matched: result.matched === true,
            attempts: optionalInteger(result.attempts),
          },
        };
      }
      case "browser_evaluate": {
        const startedAt = Date.now();
        const options = browserEvaluateOptions(args);
        const result = await this.#evaluate(
          config,
          browserEvaluateExpression(options),
          context,
          options.timeoutMs,
        );
        return {
          ok: true,
          evaluation: result,
          browser_usage: {
            tool_id: "browser_evaluate",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_debug": {
        const startedAt = Date.now();
        const options = browserDebugOptions(args);
        const [page, debug] = await Promise.all([
          this.#browserFetch(config, {
            method: "GET",
            path: "/page",
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            space: context.space,
          }),
          this.#evaluate(config, browserDebugExpression(options), context),
        ]);
        return {
          ok: true,
          page,
          debug,
          browser_usage: {
            tool_id: "browser_debug",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_click": {
        const startedAt = Date.now();
        const postAction = browserPostActionOptions(args, "page");
        const index = requiredPositiveInteger(args.index, "index");
        const result = await this.#evaluate(config, clickExpression(index), context);
        const wait =
          postAction.waitFor
            ? await this.#waitForBrowserCondition(config, context, postAction.waitFor)
            : null;
        const followUp = await this.#readPostActionState(
          config,
          context,
          postAction.postState,
        );
        return {
          ok: true,
          action: result,
          ...(wait ? { wait } : {}),
          ...(followUp.page ? { page: followUp.page } : {}),
          ...(followUp.state ? { state: followUp.state } : {}),
          browser_usage: {
            tool_id: "browser_click",
            elapsed_ms: Date.now() - startedAt,
            post_state: postAction.postState,
            ...(wait
              ? {
                  wait_condition: wait.condition,
                  wait_matched: wait.matched === true,
                  wait_attempts: optionalInteger(wait.attempts),
                  wait_elapsed_ms: optionalInteger(wait.elapsed_ms),
                }
              : {}),
            ...(followUp.stateWithMetadata
              ? browserStateUsageFields(followUp.stateWithMetadata)
              : {}),
          },
        };
      }
      case "browser_context_click": {
        const startedAt = Date.now();
        const index = requiredPositiveInteger(args.index, "index");
        const target = browserTargetKind(args.target);
        const result = await this.#evaluate(config, contextClickTargetExpression(target, index), context);
        const x = requiredPositiveInteger(result.x, "x");
        const y = requiredPositiveInteger(result.y, "y");
        const contextMenu = await this.#browserFetch(config, {
          method: "POST",
          path: "/context-click",
          body: { x, y },
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          action: result,
          context_menu: contextMenu,
          browser_usage: {
            tool_id: "browser_context_click",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_type": {
        const startedAt = Date.now();
        const postAction = browserPostActionOptions(args, "none");
        const index = requiredPositiveInteger(args.index, "index");
        const text = requiredString(args.text, "text");
        const clear = optionalBoolean(args.clear, true);
        const submit = optionalBoolean(args.submit, false);
        const nativeInput = await this.#browserFetch(config, {
          method: "POST",
          path: "/keyboard",
          body: { action: "insert_text", index, text, clear, submit },
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        const nativeInputResult = { ...nativeInput };
        delete nativeInputResult.index;
        delete nativeInputResult.tag_name;
        delete nativeInputResult.role;
        delete nativeInputResult.editable;
        const actionResult = {
          ok: true,
          index,
          ...(typeof nativeInput.tag_name === "string"
            ? { tag_name: nativeInput.tag_name }
            : {}),
          ...(typeof nativeInput.role === "string"
            ? { role: nativeInput.role }
            : {}),
          ...(nativeInput.editable === true ? { editable: true } : {}),
        };
        const wait =
          postAction.waitFor
            ? await this.#waitForBrowserCondition(config, context, postAction.waitFor)
            : null;
        const followUp = await this.#readPostActionState(
          config,
          context,
          postAction.postState,
        );
        return {
          ok: true,
          action: {
            ...actionResult,
            result: {
              value: text,
              native_input: nativeInputResult,
            },
          },
          ...(wait ? { wait } : {}),
          ...(followUp.page ? { page: followUp.page } : {}),
          ...(followUp.state ? { state: followUp.state } : {}),
          browser_usage: {
            tool_id: "browser_type",
            elapsed_ms: Date.now() - startedAt,
            post_state: postAction.postState,
            ...(wait
              ? {
                  wait_condition: wait.condition,
                  wait_matched: wait.matched === true,
                  wait_attempts: optionalInteger(wait.attempts),
                  wait_elapsed_ms: optionalInteger(wait.elapsed_ms),
                }
              : {}),
            ...(followUp.stateWithMetadata
              ? browserStateUsageFields(followUp.stateWithMetadata)
              : {}),
          },
        };
      }
      case "browser_press": {
        const startedAt = Date.now();
        const key = requiredString(args.key, "key");
        const nativeInput = await this.#browserFetch(config, {
          method: "POST",
          path: "/keyboard",
          body: { action: "press", key },
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          action: { ok: true, key, native_input: nativeInput },
          browser_usage: {
            tool_id: "browser_press",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_scroll": {
        const startedAt = Date.now();
        const explicitDelta = optionalInteger(args.delta_y);
        const amount = optionalInteger(args.amount) ?? 600;
        const direction = args.direction === "up" ? "up" : "down";
        const deltaY = explicitDelta ?? (direction === "up" ? -Math.abs(amount) : Math.abs(amount));
        const result = await this.#evaluate(config, scrollExpression(deltaY), context);
        return {
          ok: true,
          action: result,
          browser_usage: {
            tool_id: "browser_scroll",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_back": {
        const startedAt = Date.now();
        const result = await this.#evaluate(config, historyExpression("back"), context);
        const page = await this.#browserFetch(config, {
          method: "GET",
          path: "/page",
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          action: result,
          page,
          browser_usage: {
            tool_id: "browser_back",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_forward": {
        const startedAt = Date.now();
        const result = await this.#evaluate(config, historyExpression("forward"), context);
        const page = await this.#browserFetch(config, {
          method: "GET",
          path: "/page",
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          action: result,
          page,
          browser_usage: {
            tool_id: "browser_forward",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_reload": {
        const startedAt = Date.now();
        const result = await this.#evaluate(config, reloadExpression(), context);
        const page = await this.#browserFetch(config, {
          method: "GET",
          path: "/page",
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          action: result,
          page,
          browser_usage: {
            tool_id: "browser_reload",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_screenshot": {
        const startedAt = Date.now();
        const format = args.format === "jpeg" ? "jpeg" : "png";
        const quality = optionalInteger(args.quality);
        const screenshot = await this.#browserFetch(config, {
          method: "POST",
          path: "/screenshot",
          body: {
            format,
            ...(quality !== null ? { quality } : {})
          },
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        const artifactScreenshot = await this.#screenshotForToolResult({
          screenshot,
          context,
          sourceToolId: "browser_screenshot",
        });
        return {
          ok: true,
          screenshot: artifactScreenshot.result,
          ...(artifactScreenshot.warning ? { warnings: [artifactScreenshot.warning] } : {}),
          browser_usage: {
            tool_id: "browser_screenshot",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_list_tabs": {
        const startedAt = Date.now();
        return {
          ok: true,
          tabs: await this.#browserFetch(config, {
            method: "GET",
            path: "/tabs",
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            space: context.space,
          }),
          browser_usage: {
            tool_id: "browser_list_tabs",
            elapsed_ms: Date.now() - startedAt,
          },
        };
      }
      case "browser_list_downloads": {
        const startedAt = Date.now();
        const result = await this.#browserFetch(config, {
          method: "GET",
          path: "/downloads",
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        const downloads = Array.isArray(result.downloads) ? result.downloads : [];
        return {
          ok: true,
          downloads,
          browser_usage: {
            tool_id: "browser_list_downloads",
            elapsed_ms: Date.now() - startedAt,
            count: downloads.length,
          },
        };
      }
      case "browser_get_console": {
        const startedAt = Date.now();
        const options = browserGetConsoleOptions(args);
        const query = new URLSearchParams();
        query.set("limit", String(options.limit));
        if (options.level) {
          query.set("level", options.level);
        }
        const result = await this.#browserFetch(config, {
          method: "GET",
          path: `/console?${query.toString()}`,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        const entries = Array.isArray(result.entries) ? result.entries : [];
        return {
          ok: true,
          entries,
          total: optionalInteger(result.total) ?? entries.length,
          truncated: result.truncated === true,
          browser_usage: {
            tool_id: "browser_get_console",
            elapsed_ms: Date.now() - startedAt,
            count: entries.length,
            level: options.level,
            truncated: result.truncated === true,
          },
        };
      }
      case "browser_get_errors": {
        const startedAt = Date.now();
        const options = browserGetErrorsOptions(args);
        const query = new URLSearchParams();
        query.set("limit", String(options.limit));
        if (options.source) {
          query.set("source", options.source);
        }
        const result = await this.#browserFetch(config, {
          method: "GET",
          path: `/errors?${query.toString()}`,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        const errors = Array.isArray(result.errors) ? result.errors : [];
        return {
          ok: true,
          errors,
          total: optionalInteger(result.total) ?? errors.length,
          truncated: result.truncated === true,
          browser_usage: {
            tool_id: "browser_get_errors",
            elapsed_ms: Date.now() - startedAt,
            count: errors.length,
            source: options.source,
            truncated: result.truncated === true,
          },
        };
      }
      case "browser_list_requests": {
        const startedAt = Date.now();
        const options = browserListRequestsOptions(args);
        const query = new URLSearchParams();
        query.set("limit", String(options.limit));
        if (options.resourceType) {
          query.set("resource_type", options.resourceType);
        }
        if (options.failuresOnly) {
          query.set("failures_only", "true");
        }
        const result = await this.#browserFetch(config, {
          method: "GET",
          path: `/requests?${query.toString()}`,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        const requests = Array.isArray(result.requests) ? result.requests : [];
        return {
          ok: true,
          requests,
          total: optionalInteger(result.total) ?? requests.length,
          truncated: result.truncated === true,
          browser_usage: {
            tool_id: "browser_list_requests",
            elapsed_ms: Date.now() - startedAt,
            count: requests.length,
            resource_type: options.resourceType,
            failures_only: options.failuresOnly,
            truncated: result.truncated === true,
          },
        };
      }
      case "browser_get_request": {
        const startedAt = Date.now();
        const requestId = requiredString(
          args.request_id ?? args.requestId,
          "request_id",
        );
        const result = await this.#browserFetch(config, {
          method: "GET",
          path: `/requests/${encodeURIComponent(requestId)}`,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          request: asRecord(result.request) ?? result,
          browser_usage: {
            tool_id: "browser_get_request",
            elapsed_ms: Date.now() - startedAt,
            request_id: requestId,
          },
        };
      }
      case "browser_storage_get": {
        const startedAt = Date.now();
        const options = browserStorageGetOptions(args);
        const result = await this.#evaluate(
          config,
          browserStorageGetExpression(options),
          context,
        );
        return {
          ok: true,
          storage: result,
          browser_usage: {
            tool_id: "browser_storage_get",
            elapsed_ms: Date.now() - startedAt,
            storage: options.storage,
            count: optionalInteger(result.count),
            truncated: result.truncated === true,
          },
        };
      }
      case "browser_storage_set": {
        const startedAt = Date.now();
        const options = browserStorageSetOptions(args);
        const result = await this.#evaluate(
          config,
          browserStorageSetExpression(options),
          context,
        );
        return {
          ok: true,
          storage: result,
          browser_usage: {
            tool_id: "browser_storage_set",
            elapsed_ms: Date.now() - startedAt,
            storage: options.storage,
            deleted: options.delete,
          },
        };
      }
      case "browser_cookies_get": {
        const startedAt = Date.now();
        const options = browserCookiesGetOptions(args);
        const query = new URLSearchParams();
        if (options.url) {
          query.set("url", options.url);
        }
        if (options.name) {
          query.set("name", options.name);
        }
        if (options.domain) {
          query.set("domain", options.domain);
        }
        const result = await this.#browserFetch(config, {
          method: "GET",
          path: `/cookies${query.size > 0 ? `?${query.toString()}` : ""}`,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        const allowedNames =
          options.names.length > 0
            ? new Set(options.names.map((name) => name.toLowerCase()))
            : null;
        const normalizedDomain = options.domain?.replace(/^\.+/, "").toLowerCase() ?? null;
        const cookies = browserCookiesFromPayload(result)
          .filter((cookie) =>
            options.name
              ? cookie.name.toLowerCase() === options.name.toLowerCase()
              : true,
          )
          .filter((cookie) =>
            allowedNames ? allowedNames.has(cookie.name.toLowerCase()) : true,
          )
          .filter((cookie) =>
            normalizedDomain
              ? cookie.domain.replace(/^\.+/, "").toLowerCase() === normalizedDomain ||
                cookie.domain.replace(/^\.+/, "").toLowerCase().endsWith(`.${normalizedDomain}`)
              : true,
          )
          .slice(0, options.maxResults);
        return {
          ok: true,
          cookies,
          browser_usage: {
            tool_id: "browser_cookies_get",
            elapsed_ms: Date.now() - startedAt,
            count: cookies.length,
            url: options.url,
            domain: options.domain,
          },
        };
      }
      case "browser_cookies_set": {
        const startedAt = Date.now();
        const options = browserCookiesSetOptions(args);
        const result = await this.#browserFetch(config, {
          method: "POST",
          path: "/cookies",
          body: {
            ...(options.url ? { url: options.url } : {}),
            name: options.name,
            value: options.value,
            ...(options.domain ? { domain: options.domain } : {}),
            ...(options.path ? { path: options.path } : {}),
            secure: options.secure,
            http_only: options.httpOnly,
            ...(options.sameSite ? { same_site: options.sameSite } : {}),
            ...(options.expirationDate !== null
              ? { expiration_date: options.expirationDate }
              : {}),
          },
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        });
        return {
          ok: true,
          cookie: browserCookieFromUnknown(result.cookie) ?? result.cookie ?? result,
          browser_usage: {
            tool_id: "browser_cookies_set",
            elapsed_ms: Date.now() - startedAt,
            secure: options.secure,
            http_only: options.httpOnly,
          },
        };
      }
    }
  }

  async #evaluate(
    config: ProductRuntimeConfig,
    expression: string,
    context: DesktopBrowserToolExecutionContext = {},
    timeoutMs: number | null = null,
  ): Promise<Record<string, unknown>> {
    const controller = timeoutMs !== null ? new AbortController() : null;
    const timeout =
      controller && timeoutMs !== null
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    try {
      const response = await this.#browserFetch(config, {
        method: "POST",
        path: "/evaluate",
        body: evaluateExpressionPayload(expression),
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        space: context.space,
        signal: controller?.signal,
      });
      const payload = asRecord(response);
      return asRecord(payload?.result) ?? {};
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async #waitForBrowserCondition(
    config: ProductRuntimeConfig,
    context: DesktopBrowserToolExecutionContext,
    options: BrowserWaitOptions,
  ): Promise<Record<string, unknown>> {
    if (isBrowserDownloadWaitCondition(options.condition)) {
      return await this.#waitForBrowserDownloadCondition(config, context, options);
    }
    const startedAt = Date.now();
    const baseline =
      options.condition === "dom_change"
        ? await this.#evaluate(config, browserDomSignatureExpression(), context)
        : null;
    let attempts = 0;
    let lastResult: Record<string, unknown> = {};
    while (Date.now() - startedAt <= options.timeoutMs) {
      attempts += 1;
      lastResult = await this.#evaluate(
        config,
        browserWaitPredicateExpression(options, baseline),
        context,
      );
      if (lastResult.matched === true) {
        return {
          matched: true,
          attempts,
          elapsed_ms: Date.now() - startedAt,
          condition: options.condition,
          ...(options.condition === "load" ? { load_state: options.loadState } : {}),
          result: lastResult,
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, BROWSER_WAIT_POLL_INTERVAL_MS),
      );
    }
    return {
      matched: false,
      attempts,
      elapsed_ms: Date.now() - startedAt,
      condition: options.condition,
      ...(options.condition === "load" ? { load_state: options.loadState } : {}),
      result: lastResult,
    };
  }

  async #waitForBrowserDownloadCondition(
    config: ProductRuntimeConfig,
    context: DesktopBrowserToolExecutionContext,
    options: BrowserWaitOptions,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const baselineDownloads = await this.#listBrowserDownloads(config, context);
    const baselineStatuses = new Map(
      baselineDownloads.map((download) => [download.id, download.status] as const),
    );
    let attempts = 0;
    let lastDownloads = baselineDownloads;
    let matchedDownload: BrowserDownloadRecord | null = null;
    while (Date.now() - startedAt <= options.timeoutMs) {
      attempts += 1;
      lastDownloads = await this.#listBrowserDownloads(config, context);
      matchedDownload = matchedBrowserDownloadForWait(
        lastDownloads,
        baselineStatuses,
        options,
      );
      if (matchedDownload) {
        return {
          matched: true,
          attempts,
          elapsed_ms: Date.now() - startedAt,
          condition: options.condition,
          ...(options.filename ? { filename: options.filename } : {}),
          ...(options.url ? { url: options.url } : {}),
          download: matchedDownload,
          result: {
            download_count: lastDownloads.length,
            download: matchedDownload,
          },
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, BROWSER_WAIT_POLL_INTERVAL_MS),
      );
    }
    return {
      matched: false,
      attempts,
      elapsed_ms: Date.now() - startedAt,
      condition: options.condition,
      ...(options.filename ? { filename: options.filename } : {}),
      ...(options.url ? { url: options.url } : {}),
      result: {
        download_count: lastDownloads.length,
        latest_download:
          lastDownloads.find((download) => browserDownloadMatches(download, options)) ??
          null,
      },
    };
  }

  async #listBrowserDownloads(
    config: ProductRuntimeConfig,
    context: DesktopBrowserToolExecutionContext,
  ): Promise<BrowserDownloadRecord[]> {
    const payload = await this.#browserFetch(config, {
      method: "GET",
      path: "/downloads",
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      space: context.space,
    });
    return browserDownloadsFromPayload(payload);
  }

  async #readPostActionState(
    config: ProductRuntimeConfig,
    context: DesktopBrowserToolExecutionContext,
    postState: BrowserPostStateMode,
  ): Promise<{
    page?: Record<string, unknown>;
    state?: Record<string, unknown>;
    stateWithMetadata?: Record<string, unknown>;
  }> {
    if (postState === "none") {
      return {};
    }
    if (postState === "page") {
      return {
        page: await this.#browserFetch(config, {
          method: "GET",
          path: "/page",
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          space: context.space,
        }),
      };
    }
    const snapshot = await this.#readBrowserGetStateSnapshot(config, context, {
      includePageText: false,
      includeScreenshot: false,
      mode: "state",
      detail: "compact",
      scope: "main",
      maxNodes: BROWSER_POST_ACTION_STATE_MAX_NODES,
      sinceRevision: null,
      changedOnly: false,
      includeMetadata: true,
      returnMetadata: false,
    });
    const stateWithRevision = browserStateWithRevision(snapshot.page, snapshot.state, {
      sinceRevision: null,
      changedOnly: false,
    });
    return {
      page: snapshot.page,
      state: browserStateForResult(stateWithRevision, { returnMetadata: false }),
      stateWithMetadata: snapshot.state,
    };
  }

  async #screenshotForToolResult(params: {
    screenshot: Record<string, unknown>;
    context: DesktopBrowserToolExecutionContext;
    sourceToolId: string;
    page?: Record<string, unknown>;
    state?: Record<string, unknown>;
  }): Promise<{ result: Record<string, unknown>; warning: string | null }> {
    const workspaceId = typeof params.context.workspaceId === "string" ? params.context.workspaceId.trim() : "";
    if (!this.#artifactStore || !workspaceId) {
      return { result: params.screenshot, warning: null };
    }

    const base64 = screenshotBase64(params.screenshot);
    if (!base64) {
      return { result: params.screenshot, warning: null };
    }

    const mimeType = normalizedScreenshotMimeType(
      params.screenshot.mimeType ?? params.screenshot.mime_type,
    );
    const extension = screenshotExtension(mimeType);
    const sessionId = typeof params.context.sessionId === "string" ? params.context.sessionId.trim() : "";
    const inputId = typeof params.context.inputId === "string" ? params.context.inputId.trim() : "";
    const artifactId = randomUUID();
    const timestamp = timestampPathSegment();
    const relativePath = path.posix.join(
      BROWSER_SCREENSHOT_ARTIFACT_DIR,
      safePathSegment(sessionId, "session"),
      `${timestamp}-${artifactId}${extension}`,
    );
    const absolutePath = path.join(this.#artifactStore.workspaceRoot, workspaceId, ...relativePath.split("/"));
    const bytes = Buffer.from(base64, "base64");

    try {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, bytes);
      const width = positiveNumber(params.screenshot.width);
      const height = positiveNumber(params.screenshot.height);
      const output = this.#artifactStore.createOutput({
        workspaceId,
        outputType: "file",
        title: `Browser screenshot ${new Date().toISOString()}`,
        status: "completed",
        filePath: relativePath,
        sessionId: sessionId || null,
        inputId: inputId || null,
        artifactId,
        platform: "browser",
        metadata: {
          origin_type: "browser_tool",
          change_type: "created",
          artifact_type: "browser_screenshot",
          category: "image",
          mime_type: mimeType,
          size_bytes: bytes.byteLength,
          tool_id: params.sourceToolId,
          inline_base64: false,
          ...(width !== null ? { width } : {}),
          ...(height !== null ? { height } : {}),
          ...(sessionId ? { source_session_id: sessionId } : {}),
          ...(inputId ? { source_input_id: inputId } : {}),
          ...(typeof params.page?.url === "string" ? { page_url: params.page.url } : {}),
          ...(typeof params.page?.title === "string" ? { page_title: params.page.title } : {}),
          ...(typeof params.state?.url === "string" && typeof params.page?.url !== "string"
            ? { page_url: params.state.url }
            : {}),
          ...(typeof params.state?.title === "string" && typeof params.page?.title !== "string"
            ? { page_title: params.state.title }
            : {}),
        },
      });
      return {
        result: {
          artifact_id: output.artifactId ?? artifactId,
          output_id: output.id,
          file_path: output.filePath ?? relativePath,
          mime_type: mimeType,
          size_bytes: bytes.byteLength,
          ...(width !== null ? { width } : {}),
          ...(height !== null ? { height } : {}),
          storage: "workspace_output",
          inline_base64: false,
        },
        warning: null,
      };
    } catch {
      return {
        result: params.screenshot,
        warning: "Browser screenshot artifact persistence failed; screenshot is inlined.",
      };
    }
  }

  async #readBrowserGetStateSnapshot(
    config: ProductRuntimeConfig,
    context: DesktopBrowserToolExecutionContext,
    options: BrowserGetStateOptions,
  ): Promise<{
    page: Record<string, unknown>;
    state: Record<string, unknown>;
    screenshot?: Record<string, unknown>;
  }> {
    let snapshot: {
      page: Record<string, unknown>;
      state: Record<string, unknown>;
      screenshot?: Record<string, unknown>;
    } = {
      page: {},
      state: {},
    };
    for (let attempt = 0; attempt < BROWSER_GET_STATE_MAX_ATTEMPTS; attempt += 1) {
      const page = await this.#browserFetch(config, {
        method: "GET",
        path: "/page",
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        space: context.space,
      });
      const state = await this.#evaluate(
        config,
        interactiveElementsExpression(options),
        context,
      );
      const screenshot = options.includeScreenshot
        ? await this.#browserFetch(config, {
            method: "POST",
            path: "/screenshot",
            body: { format: "png" },
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            space: context.space,
          })
        : undefined;
      snapshot = { page, state, ...(screenshot ? { screenshot } : {}) };
      if (
        browserGetStateSnapshotReady({
          page,
          state,
          screenshot,
          includeScreenshot: options.includeScreenshot,
        })
      ) {
        return snapshot;
      }
      if (attempt < BROWSER_GET_STATE_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, BROWSER_GET_STATE_RETRY_DELAY_MS),
        );
      }
    }
    return snapshot;
  }

  async #browserFetch(config: ProductRuntimeConfig, options: BrowserFetchOptions): Promise<Record<string, unknown>> {
    const requestUrl = `${browserBaseUrl(config)}${options.path}`;
    let response: Response;
    try {
      response = await this.#fetch(requestUrl, {
        method: options.method,
        headers: browserToolHeaders(config, {
          workspaceId: options.workspaceId,
          sessionId: options.sessionId,
          space: options.space,
        }),
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new DesktopBrowserToolServiceError(
          504,
          "desktop_browser_request_timeout",
          "Desktop browser request timed out"
        );
      }
      throw error;
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = asRecord(payload)?.error;
      throw new DesktopBrowserToolServiceError(
        response.status,
        "desktop_browser_request_failed",
        typeof message === "string" && message.trim()
          ? message.trim()
          : `Desktop browser request failed with status ${response.status}`
      );
    }
    return asRecord(payload) ?? {};
  }
}
