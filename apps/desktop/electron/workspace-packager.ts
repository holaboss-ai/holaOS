import archiver from "archiver";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { Writable } from "node:stream";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

// ---------------------------------------------------------------------------
// Ignore patterns — mirrors backend's ignore_rules.py
// ---------------------------------------------------------------------------

const GLOBAL_IGNORE_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "out",
  "storybook-static",
  ".parcel-cache",
  ".vercel",
  ".yarn",
  ".pnpm-store",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "target",
  "tmp",
  "temp",
  ".cache",
  ".turbo",
  "coverage",
  ".holaboss",
]);

/** Glob-style patterns matched against the full relative path (forward-slash separated). */
const GLOBAL_IGNORE_GLOB_PATTERNS: RegExp[] = [
  /^\.env$/,
  /^\.env\./,
  /\.log$/,
  /\.DS_Store$/,
  /\.sqlite$/,
  /\.sqlite-journal$/,
  /\.sqlite-wal$/,
  /\.sqlite-shm$/,
  // data/*.db and any */state/*.db (workspace runtime state)
  /^data\/[^/]+\.db$/,
  /(^|\/)state\/[^/]+\.(db|db-journal|db-wal|db-shm)$/,
  // user personal memory files — never bundled into a published template
  /^memory(\/|$)/,
  // automations.yaml is always written fresh by the packager
  /^automations\.yaml$/,
];

/**
 * Privacy-classification reason for excluded files.
 * Used by the bundle preview UI to explain *why* something was excluded.
 */
export type ExclusionReason =
  | "personal_memory"
  | "runtime_state"
  | "credential"
  | "ignored_dir"
  | "build_artifact"
  | "hbignore"
  | "unselected_app"
  | "system_file"
  | "user_excluded";

const SENSITIVE_PATTERNS: RegExp[] = [
  /\.pem$/i,
  /\.key$/i,
  /secret/i,
  /token/i,
  /credential/i,
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutomationsExport {
  yaml: string;
  count: number;
}

const USER_AUTHORED_CRONJOB_FIELDS = [
  "name",
  "cron",
  "description",
  "instruction",
  "enabled",
  "delivery",
  "metadata",
] as const;

export async function fetchAndSerializeAutomations(
  runtimeBaseUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AutomationsExport> {
  const url = `${runtimeBaseUrl.replace(/\/+$/, "")}/api/v1/cronjobs?workspace_id=${encodeURIComponent(workspaceId)}`;
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`fetch cronjobs failed: ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`fetch cronjobs failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  const stripped = jobs.map((j: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of USER_AUTHORED_CRONJOB_FIELDS) {
      if (j[k] !== undefined) out[k] = j[k];
    }
    return out;
  });
  const doc = { version: 1, automations: stripped };
  const yaml = yamlStringify(doc);
  // Round-trip assertion
  const reparsed = yamlParse(yaml);
  if (
    reparsed?.version !== 1 ||
    !Array.isArray(reparsed.automations) ||
    reparsed.automations.length !== stripped.length
  ) {
    throw new Error("automations.yaml round-trip failed");
  }
  return { yaml, count: stripped.length };
}

export interface PackageWorkspaceParams {
  workspaceDir: string;
  apps: string[];
  manifest: Record<string, unknown>;
  runtimeBaseUrl: string;
  workspaceId: string;
  /**
   * Per-publish user opt-out list, one entry per workspace-relative path.
   * Drops files/subtrees the user unchecked in the bundle file tree.
   * Layered AFTER the existing ignore + sensitive checks, so it can only
   * remove otherwise-includeable files — never re-include excluded ones.
   */
  forceExcludePaths?: string[];
  /** Test hook */
  automationsFetcher?: typeof fetchAndSerializeAutomations;
}

export interface PackageResult {
  archiveBuffer: Buffer;
  archiveSizeBytes: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isGloballyIgnored(relPath: string): boolean {
  // Check if any path segment is a globally-ignored directory name
  const parts = relPath.split("/");
  for (const part of parts.slice(0, -1)) {
    // directory segments only
    if (GLOBAL_IGNORE_DIR_NAMES.has(part)) {
      return true;
    }
  }
  // Also check if the leaf itself is a known ignored dir name (when walking dirs)
  const leaf = parts[parts.length - 1];
  if (GLOBAL_IGNORE_DIR_NAMES.has(leaf)) {
    return true;
  }
  // Check glob patterns against full relative path
  for (const re of GLOBAL_IGNORE_GLOB_PATTERNS) {
    if (re.test(relPath)) {
      return true;
    }
  }
  return false;
}

function isSensitive(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  for (const re of SENSITIVE_PATTERNS) {
    if (re.test(lower)) {
      return true;
    }
  }
  return false;
}

/**
 * Parse .hbignore content into a list of patterns.
 * Lines starting with '#' or empty lines are ignored.
 */
function parseHbIgnore(content: string): string[] {
  const patterns: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    patterns.push(line);
  }
  return patterns;
}

async function readHbIgnore(hbIgnorePath: string): Promise<string[]> {
  try {
    return parseHbIgnore(await fs.readFile(hbIgnorePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Returns true if relPath matches the given hbignore pattern.
 * Supports simple filename globs and directory-prefix patterns (ending with /).
 */
function matchesHbPattern(relPath: string, pattern: string): boolean {
  const name = relPath.split("/").pop() ?? "";

  if (pattern.endsWith("/")) {
    // Directory pattern — any path segment matches
    const dirName = pattern.slice(0, -1);
    const parts = relPath.split("/");
    return parts.includes(dirName);
  }

  if (pattern.includes("/")) {
    // Path-anchored glob — match against full relPath
    return minimatch(relPath, pattern);
  }

  // Simple filename/extension glob
  return minimatch(name, pattern);
}

/**
 * Very small glob-to-regex converter supporting `*` and `?` wildcards.
 * Good enough for the patterns used in .hbignore files.
 */
function minimatch(str: string, pattern: string): boolean {
  // Convert glob to regex: escape special chars, then replace * and ?
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "$"
  );
  return re.test(str);
}

function isHbIgnored(relPath: string, hbPatterns: string[]): boolean {
  for (const pattern of hbPatterns) {
    if (matchesHbPattern(relPath, pattern)) {
      return true;
    }
  }
  return false;
}

function parseSignedHeaderNames(url: string): string[] {
  const params = new URL(url).searchParams;
  const signedHeaders =
    params.get("X-Amz-SignedHeaders") ??
    params.get("x-amz-signedheaders") ??
    "";
  return signedHeaders
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

export function buildPresignedUploadHeaders(
  url: string,
  dataLength: number,
): Record<string, string> {
  const signedHeaders = parseSignedHeaderNames(url);
  const headers: Record<string, string> = {
    "Content-Length": String(dataLength),
  };

  if (signedHeaders.length === 0 || signedHeaders.includes("content-type")) {
    headers["Content-Type"] = "application/zip";
  }

  return headers;
}

export function buildPresignedUploadError(
  url: string,
  status: number,
  responseBody: string,
): string {
  const signedHeaders = parseSignedHeaderNames(url);
  const uploadHost = new URL(url).host;
  const signedHeadersLabel = signedHeaders.length > 0
    ? signedHeaders.join(", ")
    : "(not provided)";
  const detail = responseBody.trim().slice(0, 500);

  return detail
    ? `Presigned URL upload failed with status ${status}. Host: ${uploadHost}. Signed headers: ${signedHeadersLabel}. Response: ${detail}`
    : `Presigned URL upload failed with status ${status}. Host: ${uploadHost}. Signed headers: ${signedHeadersLabel}`;
}

/**
 * Match a relative path against a user force-exclude list. A path matches
 * when it's identical to an entry, or when an entry names a parent directory
 * (so unchecking ``skills/`` excludes ``skills/foo.md`` and the whole subtree).
 */
function isUserForceExcluded(relPath: string, forceExcludePaths: string[]): boolean {
  if (forceExcludePaths.length === 0) {
    return false;
  }
  for (const raw of forceExcludePaths) {
    const entry = raw.replace(/\/+$/, "");
    if (!entry) {
      continue;
    }
    if (relPath === entry) {
      return true;
    }
    if (relPath.startsWith(`${entry}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Determine whether a file should be included in the archive.
 */
function shouldInclude(
  relPath: string,
  selectedApps: string[],
  hbPatterns: string[],
  forceExcludePaths: string[]
): boolean {
  if (isGloballyIgnored(relPath)) {
    return false;
  }
  if (isSensitive(relPath)) {
    return false;
  }
  if (hbPatterns.length > 0 && isHbIgnored(relPath, hbPatterns)) {
    return false;
  }

  // Apps are NEVER included in the publish archive — the manifest's apps[]
  // (NAMES only) is the source of truth, and the install-time runtime fetches
  // each app's bytes from its official GitHub release tarball. Shipping the
  // publisher's locally-built source/dist would cause cross-platform breakage
  // on the installer's machine (different OS, arch, node version, etc.). The
  // `selectedApps` parameter still controls which app NAMES end up in the
  // manifest; it just doesn't influence file inclusion anymore.
  if (relPath === "apps" || relPath.startsWith("apps/")) {
    return false;
  }

  // User opt-out via the publish file tree. Layered AFTER the safety nets
  // above so users can only DROP otherwise-includeable files; they cannot
  // re-include credentials/.hbignore/apps via this list.
  if (isUserForceExcluded(relPath, forceExcludePaths)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files under `dir`, returning their relative paths
 * (using forward slashes), sorted for deterministic output.
 * Skips directory trees that are globally ignored early.
 */
async function collectFiles(
  dir: string,
  baseDir: string,
  selectedApps: string[],
  hbPatterns: string[],
  forceExcludePaths: string[]
): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  // Sort entries for deterministic order
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = path
      .relative(baseDir, absPath)
      .split(path.sep)
      .join("/");

    if (entry.isDirectory()) {
      // Prune globally ignored directories early (no need to recurse)
      if (GLOBAL_IGNORE_DIR_NAMES.has(entry.name)) {
        continue;
      }
      // Apps are never bundled into the publish archive — the manifest's
      // apps[] list of NAMES is the install-time contract; the runtime
      // fetches each app's bytes from its official GitHub release tarball.
      // Skip the entire apps/ subtree at walk time (faster than per-file).
      if (relPath === "apps" || relPath.startsWith("apps/")) {
        continue;
      }
      const children = await collectFiles(
        absPath,
        baseDir,
        selectedApps,
        hbPatterns,
        forceExcludePaths
      );
      results.push(...children);
    } else {
      if (shouldInclude(relPath, selectedApps, hbPatterns, forceExcludePaths)) {
        results.push(relPath);
      }
    }
  }

  return results;
}

/**
 * File-level entry returned by `previewBundle` for the publish UI.
 */
export interface BundleFileEntry {
  path: string;
  sizeBytes: number;
}

export interface BundleExclusion {
  path: string;
  reason: ExclusionReason;
  sizeBytes: number;
}

export interface BundlePreview {
  included: BundleFileEntry[];
  excluded: BundleExclusion[];
  totalIncludedBytes: number;
  totalExcludedBytes: number;
}

function classifyExclusion(
  relPath: string,
  hbPatterns: string[],
  selectedApps: string[],
  forceExcludePaths: string[],
): ExclusionReason | null {
  if (/^memory(\/|$)/.test(relPath)) {
    return "personal_memory";
  }
  if (/(^|\/)state\/[^/]+\.(db|db-journal|db-wal|db-shm)$/.test(relPath) || /\.sqlite/.test(relPath)) {
    return "runtime_state";
  }
  if (isSensitive(relPath)) {
    return "credential";
  }
  const parts = relPath.split("/");
  for (const part of parts) {
    if (GLOBAL_IGNORE_DIR_NAMES.has(part)) {
      // Distinguish build/cache from system dirs for nicer UI copy
      if (part === "node_modules" || part === "dist" || part === "build" || part === ".turbo" || part === ".next") {
        return "build_artifact";
      }
      return "ignored_dir";
    }
  }
  if (/^\.env/.test(relPath) || /\.log$/.test(relPath) || /\.DS_Store$/.test(relPath)) {
    return "system_file";
  }
  if (hbPatterns.length > 0 && isHbIgnored(relPath, hbPatterns)) {
    return "hbignore";
  }
  // Apps are always excluded from the archive (installed at use-time from the
  // official GitHub release tarball). selectedApps governs the manifest's
  // apps[] NAMES, not file inclusion.
  if (relPath === "apps" || relPath.startsWith("apps/")) {
    return "unselected_app";
  }
  // User force-exclude is the lowest-priority reason — only applies when none
  // of the safety-net categories above matched.
  if (isUserForceExcluded(relPath, forceExcludePaths)) {
    return "user_excluded";
  }
  return null;
}

/**
 * Walk the workspace and classify every file as included or excluded
 * (with reason). Used by the publish UI's bundle preview before the
 * user commits to publishing — purely a read; no zip created.
 */
export async function previewBundle(
  workspaceDir: string,
  selectedApps: string[],
  forceExcludePaths: string[] = [],
): Promise<BundlePreview> {
  const hbIgnorePath = path.join(workspaceDir, ".hbignore");
  const hbPatterns = await readHbIgnore(hbIgnorePath);

  const included: BundleFileEntry[] = [];
  const excluded: BundleExclusion[] = [];
  let totalIncludedBytes = 0;
  let totalExcludedBytes = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(workspaceDir, absPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        // Hard-prune massive build/dep dirs without recursing
        if (GLOBAL_IGNORE_DIR_NAMES.has(entry.name)) {
          // Record a single rolled-up exclusion entry so the UI can show it
          excluded.push({
            path: relPath + "/",
            reason:
              classifyExclusion(relPath + "/", hbPatterns, selectedApps, forceExcludePaths) ??
              "ignored_dir",
            sizeBytes: 0,
          });
          continue;
        }
        await walk(absPath);
      } else {
        let sizeBytes = 0;
        try {
          const st = await fs.stat(absPath);
          sizeBytes = Number(st.size) || 0;
        } catch {
          sizeBytes = 0;
        }
        if (shouldInclude(relPath, selectedApps, hbPatterns, forceExcludePaths)) {
          included.push({ path: relPath, sizeBytes });
          totalIncludedBytes += sizeBytes;
        } else {
          const reason =
            classifyExclusion(relPath, hbPatterns, selectedApps, forceExcludePaths) ?? "ignored_dir";
          excluded.push({ path: relPath, reason, sizeBytes });
          totalExcludedBytes += sizeBytes;
        }
      }
    }
  }

  await walk(workspaceDir);

  return {
    included,
    excluded,
    totalIncludedBytes,
    totalExcludedBytes,
  };
}

/**
 * Collect all files in a workspace directory, apply ignore rules and app
 * filtering, create a zip archive in memory, and return the buffer.
 */
export async function packageWorkspace(
  params: PackageWorkspaceParams
): Promise<PackageResult> {
  const {
    workspaceDir,
    apps,
    manifest,
    runtimeBaseUrl,
    workspaceId,
    forceExcludePaths = [],
    automationsFetcher = fetchAndSerializeAutomations,
  } = params;

  const hbIgnorePath = path.join(workspaceDir, ".hbignore");
  const hbPatterns = await readHbIgnore(hbIgnorePath);

  // Collect files
  const relPaths = await collectFiles(workspaceDir, workspaceDir, apps, hbPatterns, forceExcludePaths);

  // Fetch automations — failures bubble up to the IPC handler
  const automations = await automationsFetcher(runtimeBaseUrl, workspaceId);

  // Build archive in memory
  const chunks: Buffer[] = [];
  const archive = archiver("zip", { zlib: { level: 6 } });

  const bufferWritable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });

  archive.pipe(bufferWritable);
  const archiveCompleted = new Promise<void>((resolve, reject) => {
    bufferWritable.on("finish", resolve);
    bufferWritable.on("error", reject);
    archive.on("error", reject);
  });

  // Write manifest.json as first entry (with automations_count injected)
  const manifestWithCount = { ...manifest, automations_count: automations.count };
  const manifestJson = JSON.stringify(manifestWithCount, null, 2);
  archive.append(manifestJson, { name: "manifest.json" });

  // Write automations.yaml
  archive.append(automations.yaml, { name: "automations.yaml" });

  // Append workspace files
  for (const relPath of relPaths) {
    const absPath = path.join(workspaceDir, ...relPath.split("/"));
    archive.file(absPath, { name: relPath });
  }

  await archive.finalize();
  await archiveCompleted;

  const archiveBuffer = Buffer.concat(chunks);
  return {
    archiveBuffer,
    archiveSizeBytes: archiveBuffer.byteLength,
  };
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
}

export interface UploadOptions {
  timeoutMs?: number;
  onProgress?: (p: UploadProgress) => void;
  /** Number of additional retry attempts on transient (5xx / network) failures. */
  retries?: number;
  /** Override Content-Type — defaults to application/zip when not in signed headers. */
  contentType?: string;
}

const TRANSIENT_STATUS = (status: number) => status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);

/**
 * PUT a Buffer to a presigned URL with progress reporting and retry-on-transient.
 */
export async function uploadToPresignedUrl(
  url: string,
  data: Buffer,
  optionsOrTimeoutMs: UploadOptions | number = {},
): Promise<void> {
  const opts: UploadOptions =
    typeof optionsOrTimeoutMs === "number" ? { timeoutMs: optionsOrTimeoutMs } : optionsOrTimeoutMs;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxAttempts = (opts.retries ?? 2) + 1;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await uploadOnce(url, data, timeoutMs, opts.onProgress, opts.contentType);
      return;
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      const statusMatch = message.match(/status (\d+)/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const isLastAttempt = attempt === maxAttempts;
      const transient = TRANSIENT_STATUS(status) || /timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(message);
      if (isLastAttempt || !transient) {
        throw err;
      }
      // exponential backoff: 500ms, 1500ms, 3500ms, ...
      const backoff = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("upload failed");
}

function uploadOnce(
  url: string,
  data: Buffer,
  timeoutMs: number,
  onProgress: ((p: UploadProgress) => void) | undefined,
  contentType: string | undefined,
): Promise<void> {
  const requester = url.startsWith("https") ? httpsRequest : httpRequest;
  const totalBytes = data.byteLength;
  const headers = buildPresignedUploadHeaders(url, totalBytes);
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  return new Promise<void>((resolve, reject) => {
    const req = requester(
      url,
      { method: "PUT", headers, timeout: timeoutMs },
      (res: IncomingMessage) => {
        const responseChunks: string[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk) => responseChunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            onProgress?.({ uploadedBytes: totalBytes, totalBytes });
            resolve();
          } else {
            reject(new Error(buildPresignedUploadError(url, status, responseChunks.join(""))));
          }
        });
        res.on("error", reject);
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Upload timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);

    // Stream the buffer in 256 KB chunks so we can emit progress.
    const CHUNK = 256 * 1024;
    let offset = 0;
    const writeNext = () => {
      while (offset < totalBytes) {
        const end = Math.min(offset + CHUNK, totalBytes);
        const slice = data.subarray(offset, end);
        const ok = req.write(slice);
        offset = end;
        onProgress?.({ uploadedBytes: offset, totalBytes });
        if (!ok) {
          req.once("drain", writeNext);
          return;
        }
      }
      req.end();
    };
    writeNext();
  });
}
