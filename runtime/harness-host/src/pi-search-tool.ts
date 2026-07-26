import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_MAX_BYTES,
  createGrepTool,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ensureTool } from "../node_modules/@mariozechner/pi-coding-agent/dist/utils/tools-manager.js";
import { resolveToCwd } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/path-utils.js";
import {
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/truncate.js";
import { normalizeToLF, stripBom } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js";
import { openArchive, parseArchivePathCandidates } from "./pi-archive-reader.js";

function normalizeDisplayPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (relative === "") return path.basename(absolutePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return absolutePath.split(path.sep).join("/");
}

const SEARCH_FILE_WINDOW = 20;
const SEARCH_PER_FILE_MATCH_LIMIT = 20;
const SEARCH_INTERNAL_MATCH_CAP = 2000;
const SEARCH_IGNORE_PATTERNS = ["**/node_modules/**", "**/.git/**"];
const SEARCH_SELECTOR_RE = /^L?\d+(?:[-+]L?\d+|-)?(?:,L?\d+(?:[-+]L?\d+|-)?)*$/i;
const SEARCH_CONTEXT_BEFORE = 1;
const SEARCH_CONTEXT_AFTER = 3;

type LineRange = {
  startLine: number;
  endLine?: number;
};

type SearchContextLine = {
  lineNumber: number;
  lineText: string;
};

type SearchPathSpec = {
  original: string;
  clean: string;
  ranges?: LineRange[];
  archiveCandidate?: boolean;
};

type SearchMatch = {
  absolutePath: string;
  relativePath: string;
  lineNumber: number;
  lineText: string;
  contextBefore?: SearchContextLine[];
  contextAfter?: SearchContextLine[];
};

type SearchFrameLine = {
  lineNumber: number;
  lineText: string;
  isMatch: boolean;
};

type SearchToolParams = {
  pattern?: unknown;
  path?: unknown;
  paths?: unknown;
  i?: unknown;
  gitignore?: unknown;
  skip?: unknown;
};

function normalizePathInput(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function hasGlobChars(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function containsTopLevelComma(entry: string): boolean {
  let braceDepth = 0;
  for (let index = 0; index < entry.length; index += 1) {
    const char = entry[index];
    if (char === "\\" && index + 1 < entry.length) {
      index += 1;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      continue;
    }
    if (char === "," && braceDepth === 0) {
      return true;
    }
  }
  return false;
}

function splitPathAndSelector(rawPath: string): { path: string; selector?: string } {
  const colon = rawPath.lastIndexOf(":");
  if (colon <= 0) {
    return { path: rawPath };
  }
  const selector = rawPath.slice(colon + 1);
  if (!SEARCH_SELECTOR_RE.test(selector)) {
    return { path: rawPath };
  }
  return {
    path: rawPath.slice(0, colon),
    selector,
  };
}

function parseLineRanges(selector: string): LineRange[] {
  return selector.split(",").map((chunk) => {
    const match = /^L?(\d+)(?:([-+])L?(\d+)?)?$/i.exec(chunk);
    if (!match) {
      throw new Error(`Invalid line selector: ${selector}`);
    }
    const startLine = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error(`Invalid line selector: ${selector}`);
    }
    const operator = match[2];
    const rhs = match[3] ? Number.parseInt(match[3], 10) : undefined;
    if (!operator) {
      return { startLine, endLine: startLine };
    }
    if (operator === "+") {
      if (!rhs || rhs < 1) {
        throw new Error(`Invalid line selector: ${selector}`);
      }
      return { startLine, endLine: startLine + rhs - 1 };
    }
    if (rhs === undefined) {
      return { startLine };
    }
    if (rhs < startLine) {
      throw new Error(`Invalid line selector: ${selector}`);
    }
    return { startLine, endLine: rhs };
  });
}

function lineIsInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
  return ranges.some((range) =>
    lineNumber >= range.startLine && (range.endLine === undefined || lineNumber <= range.endLine)
  );
}

function truncateSearchLine(line: string): { text: string; truncated: boolean } {
  const sanitizedLine = line.replace(/\r?\n/g, "\\n");
  const truncatedLine = truncateLine(sanitizedLine);
  return {
    text: truncatedLine.text,
    truncated: truncatedLine.wasTruncated,
  };
}

function parsePathSpecs(pathInputs: readonly string[]): SearchPathSpec[] {
  if (pathInputs.length === 0) {
    throw new Error("Provide at least one search path.");
  }
  return pathInputs.map((entry) => {
    const normalized = normalizePathInput(entry);
    if (!normalized) {
      throw new Error("Search paths must not be empty.");
    }
    if (parseArchivePathCandidates(normalized).length > 0) {
      return {
        original: entry,
        clean: normalized,
        archiveCandidate: true,
      };
    }
    const split = splitPathAndSelector(normalized);
    if (containsTopLevelComma(split.path)) {
      throw new Error(`paths is an array; pass [\"a\", \"b\"] not [\"a,b\"] (got ${JSON.stringify(entry)})`);
    }
    if (split.selector && hasGlobChars(split.path)) {
      throw new Error(`Line-range selector requires a single file, not a glob: ${entry}`);
    }
    return {
      original: entry,
      clean: split.path,
      ranges: split.selector ? parseLineRanges(split.selector) : undefined,
    };
  });
}

async function expandSearchTargets(
  specs: readonly SearchPathSpec[],
  cwd: string,
  rgPath: string,
): Promise<{
  targets: string[];
  rangesByAbsolutePath: Map<string, LineRange[]>;
  missingPaths: string[];
  displayPathByAbsolutePath: Map<string, string>;
  cleanup: () => Promise<void>;
}> {
  const targets: string[] = [];
  const seenTargets = new Set<string>();
  const rangesByAbsolutePath = new Map<string, LineRange[]>();
  const missingPaths: string[] = [];
  const displayPathByAbsolutePath = new Map<string, string>();
  const tempRoots: string[] = [];

  const cleanup = async () => {
    await Promise.all(tempRoots.map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })));
  };

  for (const spec of specs) {
    if (spec.archiveCandidate) {
      let expandedArchive = false;
      for (const candidate of parseArchivePathCandidates(spec.clean)) {
        const archiveAbsolutePath = path.resolve(resolveToCwd(candidate.archivePath, cwd));
        try {
          const stats = await fs.stat(archiveAbsolutePath);
          if (!stats.isFile()) {
            continue;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            continue;
          }
          throw error;
        }

        const archive = await openArchive(archiveAbsolutePath);
        const archiveDisplayPath = normalizeDisplayPath(cwd, archiveAbsolutePath);
        const archiveSubPath = candidate.archivePath === spec.clean ? "" : candidate.subPath;
        const splitSubPath = splitPathAndSelector(archiveSubPath);
        const selectorRanges = splitSubPath.selector ? parseLineRanges(splitSubPath.selector) : null;
        if (splitSubPath.selector && !selectorRanges) {
          throw new Error(`Invalid line selector: ${spec.original}`);
        }
        const node = archive.getNode(splitSubPath.path);
        if (!node) {
          continue;
        }
        const files = node.isDirectory ? archive.listFiles(splitSubPath.path) : [node];
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-archive-"));
        tempRoots.push(tempRoot);

        for (const fileNode of files) {
          if (fileNode.isDirectory) {
            continue;
          }
          const extracted = await archive.readFile(fileNode.path);
          const bytes = Buffer.from(extracted.bytes);
          if (bytes.subarray(0, Math.min(bytes.length, 1024)).includes(0)) {
            continue;
          }
          const tempPath = path.join(tempRoot, extracted.path);
          await fs.mkdir(path.dirname(tempPath), { recursive: true });
          await fs.writeFile(tempPath, bytes);
          const absoluteTempPath = path.resolve(tempPath);
          if (!seenTargets.has(absoluteTempPath)) {
            seenTargets.add(absoluteTempPath);
            targets.push(absoluteTempPath);
          }
          displayPathByAbsolutePath.set(absoluteTempPath, `${archiveDisplayPath}:${extracted.path}`);
          if (!node.isDirectory && selectorRanges) {
            rangesByAbsolutePath.set(absoluteTempPath, selectorRanges);
          }
        }

        expandedArchive = true;
        break;
      }
      if (!expandedArchive) {
        missingPaths.push(spec.original);
      }
      continue;
    }

    if (hasGlobChars(spec.clean)) {
      const matches = await expandGlobTargets(spec.clean, cwd, rgPath);
      if (matches.length === 0) {
        missingPaths.push(spec.original);
        continue;
      }
      for (const match of matches) {
        const normalized = path.resolve(match);
        if (seenTargets.has(normalized)) {
          continue;
        }
        seenTargets.add(normalized);
        targets.push(normalized);
      }
      continue;
    }

    const absolutePath = path.resolve(resolveToCwd(spec.clean, cwd));
    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile() && !stats.isDirectory()) {
        missingPaths.push(spec.original);
        continue;
      }
      if (!seenTargets.has(absolutePath)) {
        seenTargets.add(absolutePath);
        targets.push(absolutePath);
      }
      if (spec.ranges && stats.isFile()) {
        const existing = rangesByAbsolutePath.get(absolutePath) ?? [];
        existing.push(...spec.ranges);
        rangesByAbsolutePath.set(absolutePath, existing);
      }
      if (spec.ranges && stats.isDirectory()) {
        throw new Error(`Line-range selector requires a single file: ${spec.original}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        missingPaths.push(spec.original);
        continue;
      }
      throw error;
    }
  }

  return { targets, rangesByAbsolutePath, missingPaths, displayPathByAbsolutePath, cleanup };
}

function parseSearchPathInputs(params: { path?: unknown; paths?: unknown }): string[] {
  const singlePath = typeof params.path === "string" ? params.path : null;
  const pathList = Array.isArray(params.paths)
    ? params.paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  const combined = [
    ...(singlePath ? [singlePath] : []),
    ...pathList,
  ];
  if (combined.length === 0) {
    throw new Error("Provide `path` or `paths` for the search tool.");
  }
  return combined;
}

function groupMatchesForOutput(matches: readonly SearchMatch[]): string[] {
  const filesInOrder: string[] = [];
  const matchesByFile = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    if (!matchesByFile.has(match.relativePath)) {
      matchesByFile.set(match.relativePath, []);
      filesInOrder.push(match.relativePath);
    }
    matchesByFile.get(match.relativePath)!.push(match);
  }

  const filesByDirectory = new Map<string, string[]>();
  for (const filePath of filesInOrder) {
    const directory = path.posix.dirname(filePath);
    const bucket = filesByDirectory.get(directory) ?? [];
    bucket.push(filePath);
    filesByDirectory.set(directory, bucket);
  }

  const lines: string[] = [];
  const pushSeparator = () => {
    if (lines.length > 0) {
      lines.push("");
    }
  };

  for (const [directory, directoryFiles] of filesByDirectory) {
    if (directory === ".") {
      for (const filePath of directoryFiles) {
        pushSeparator();
        lines.push(`# ${path.posix.basename(filePath)}`);
        renderSearchFrameLines(matchesByFile.get(filePath) ?? [], lines);
      }
      continue;
    }

    pushSeparator();
    lines.push(`# ${directory}/`);
    for (const filePath of directoryFiles) {
      lines.push(`## ${path.posix.basename(filePath)}`);
      renderSearchFrameLines(matchesByFile.get(filePath) ?? [], lines);
    }
  }

  return lines;
}

function collectSearchFrameLines(matches: readonly SearchMatch[]): SearchFrameLine[] {
  const frameLines: SearchFrameLine[] = [];
  let lastEmittedLine: number | undefined;

  const emitLine = (lineNumber: number, lineText: string, isMatch: boolean) => {
    if (lastEmittedLine !== undefined && lineNumber <= lastEmittedLine) {
      return;
    }
    frameLines.push({ lineNumber, lineText, isMatch });
    lastEmittedLine = lineNumber;
  };

  for (const match of matches) {
    for (const contextLine of match.contextBefore ?? []) {
      emitLine(contextLine.lineNumber, contextLine.lineText, false);
    }
    emitLine(match.lineNumber, match.lineText, true);
    for (const contextLine of match.contextAfter ?? []) {
      emitLine(contextLine.lineNumber, contextLine.lineText, false);
    }
  }

  return frameLines;
}

function renderSearchFrameLines(matches: readonly SearchMatch[], output: string[]): void {
  const frameLines = collectSearchFrameLines(matches);
  let lastRenderedLine: number | undefined;
  for (const frameLine of frameLines) {
    if (lastRenderedLine !== undefined && frameLine.lineNumber > lastRenderedLine + 1) {
      output.push("...");
    }
    output.push(`${frameLine.isMatch ? "*" : " "}${frameLine.lineNumber}:${frameLine.lineText}`);
    lastRenderedLine = frameLine.lineNumber;
  }
}

function summarizeSearchResult(params: {
  matches: readonly SearchMatch[];
  skip: number;
  totalFiles: number;
  selectedFiles: number;
  fileLimitReached: boolean;
  perFileLimitReached: boolean;
  matchCapReached: boolean;
  lineTruncationHit: boolean;
  missingPaths: readonly string[];
}): { text: string; details: Record<string, unknown> | undefined } {
  if (params.matches.length === 0) {
    const message = ["No matches found"];
    if (params.missingPaths.length > 0) {
      message.push(`Skipped missing paths: ${params.missingPaths.join(", ")}`);
    }
    return { text: message.join("\n"), details: undefined };
  }

  const groupedLines = groupMatchesForOutput(params.matches);
  const rawOutput = groupedLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const notices: string[] = [];
  const details: Record<string, unknown> = {
    file_count: new Set(params.matches.map((match) => match.relativePath)).size,
    match_count: params.matches.length,
  };

  if (params.fileLimitReached) {
    const nextSkip = params.skip + params.selectedFiles;
    notices.push(`Showing files ${params.skip + 1}-${nextSkip} of ${params.totalFiles}. Use skip=${nextSkip} for the next page.`);
    details.file_limit_reached = SEARCH_FILE_WINDOW;
    details.next_skip = nextSkip;
  }
  if (params.perFileLimitReached) {
    notices.push(`Showing first ${SEARCH_PER_FILE_MATCH_LIMIT} matches per file.`);
    details.per_file_limit_reached = SEARCH_PER_FILE_MATCH_LIMIT;
  }
  if (params.matchCapReached) {
    notices.push(`Search stopped after ${SEARCH_INTERNAL_MATCH_CAP} matches. Narrow the pattern or paths.`);
    details.match_cap_reached = SEARCH_INTERNAL_MATCH_CAP;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit reached.`);
    details.truncation = truncation;
  }
  if (params.lineTruncationHit) {
    notices.push(`Some lines were truncated to ${GREP_MAX_LINE_LENGTH} characters. Use read for full context.`);
    details.lines_truncated = true;
  }
  if (params.missingPaths.length > 0) {
    notices.push(`Skipped missing paths: ${params.missingPaths.join(", ")}`);
    details.missing_paths = [...params.missingPaths];
  }
  if (notices.length > 0) {
    output += `\n\n[${notices.join(" ")}]`;
  }
  return { text: output, details };
}

async function enrichMatchesWithContext(params: {
  matches: readonly SearchMatch[];
  rangesByAbsolutePath: ReadonlyMap<string, LineRange[]>;
}): Promise<{ matches: SearchMatch[]; lineTruncationHit: boolean }> {
  const linesByAbsolutePath = new Map<string, string[]>();
  let lineTruncationHit = false;
  const enriched: SearchMatch[] = [];

  for (const match of params.matches) {
    let fileLines = linesByAbsolutePath.get(match.absolutePath);
    if (!fileLines) {
      const rawContent = await fs.readFile(match.absolutePath, "utf-8");
      const { text } = stripBom(rawContent);
      fileLines = normalizeToLF(text).split("\n");
      if (fileLines[fileLines.length - 1] === "") {
        fileLines.pop();
      }
      linesByAbsolutePath.set(match.absolutePath, fileLines);
    }

    const ranges = params.rangesByAbsolutePath.get(match.absolutePath);
    const contextBefore: SearchContextLine[] = [];
    const contextAfter: SearchContextLine[] = [];

    for (let lineNumber = Math.max(1, match.lineNumber - SEARCH_CONTEXT_BEFORE); lineNumber < match.lineNumber; lineNumber += 1) {
      if (ranges && !lineIsInRanges(lineNumber, ranges)) {
        continue;
      }
      const truncated = truncateSearchLine(fileLines[lineNumber - 1] ?? "");
      if (truncated.truncated) {
        lineTruncationHit = true;
      }
      contextBefore.push({ lineNumber, lineText: truncated.text });
    }

    for (
      let lineNumber = match.lineNumber + 1;
      lineNumber <= Math.min(fileLines.length, match.lineNumber + SEARCH_CONTEXT_AFTER);
      lineNumber += 1
    ) {
      if (ranges && !lineIsInRanges(lineNumber, ranges)) {
        continue;
      }
      const truncated = truncateSearchLine(fileLines[lineNumber - 1] ?? "");
      if (truncated.truncated) {
        lineTruncationHit = true;
      }
      contextAfter.push({ lineNumber, lineText: truncated.text });
    }

    enriched.push({
      ...match,
      contextBefore: contextBefore.length > 0 ? contextBefore : undefined,
      contextAfter: contextAfter.length > 0 ? contextAfter : undefined,
    });
  }

  return { matches: enriched, lineTruncationHit };
}

async function expandGlobTargets(
  pattern: string,
  cwd: string,
  rgPath: string,
): Promise<string[]> {
  const result = spawnSync(
    rgPath,
    [
      "--files",
      "--hidden",
      "--glob",
      pattern,
      "--glob",
      "!**/node_modules/**",
      "--glob",
      "!**/.git/**",
      // `--` terminates flag parsing so `cwd` (a path) can't be read as a flag.
      "--",
      cwd,
    ],
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) {
    throw new Error(`Failed to expand glob ${JSON.stringify(pattern)}: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr?.trim() || `rg --files exited with code ${result.status}`);
  }
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => path.resolve(cwd, line))
    .sort((left: string, right: string) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

export function createPiSearchToolDefinition(cwd: string) {
  const baseTool = createGrepTool(cwd);
  const parameters = Type.Object(
    {
      pattern: Type.String({ description: "Regex pattern to search for" }),
      path: Type.Optional(Type.String({
        description:
          'Single file, directory, glob, or file with line selector (for example "src/app.ts:50-120")',
      })),
      paths: Type.Optional(Type.Array(Type.String({
        description:
          'File, directory, glob, or file with line selector (for example "src/app.ts:50-120")',
      }), {
        description: "Optional multi-path search scope. Use instead of `path` when searching several scopes.",
      })),
      i: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
      gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore files. Defaults to true." })),
      skip: Type.Optional(Type.Number({
        description: `Number of matching files to skip before showing the next page. Defaults to 0. File window size is ${SEARCH_FILE_WINDOW}.`,
      })),
    },
    { additionalProperties: false },
  );

  return {
    ...baseTool,
    name: "search",
    label: "search",
    description:
      `Search file contents across files, directories, globs, or .zip archive members with grouped results. Use this tool for content search instead of shelling out to \`grep\`, \`rg\`, or \`git grep\`. Accepts file selectors like "src/app.ts:50-120" to constrain the search to specific line ranges. Results are grouped by file, show ${SEARCH_CONTEXT_BEFORE} line before and ${SEARCH_CONTEXT_AFTER} lines after each match with gap elision, paginate by ${SEARCH_FILE_WINDOW} files via skip, and truncate long lines to ${GREP_MAX_LINE_LENGTH} characters.`,
    promptSnippet: "Search workspace content with grouped match frames",
    promptGuidelines: [
      "Use search for content lookup instead of shelling out to `grep`, `rg`, `ripgrep`, or `git grep`.",
      "Use `paths` as separate array entries when searching multiple scopes; do not comma-join them into one string.",
      "When the relevant area is already known, add a file selector like `src/app.ts:50-120` to constrain the search window.",
      "Use `skip` to page to the next file window instead of rerunning the same broad search from the top.",
      "If a search frame is not enough to edit safely, follow up with read on the exact file or range before changing anything.",
    ],
    parameters,
    async execute(_toolCallId: string, rawParams: SearchToolParams, signal?: AbortSignal) {
      const params = rawParams as SearchToolParams;

      const normalizedPattern = typeof params.pattern === "string" ? params.pattern.trim() : "";
      if (!normalizedPattern) {
        throw new Error("Pattern must not be empty.");
      }
      const skip = typeof params.skip === "number" && Number.isFinite(params.skip)
        ? Math.max(0, Math.floor(params.skip))
        : 0;
      const pathSpecs = parsePathSpecs(parseSearchPathInputs(params));
      const rgPath = await ensureTool("rg", true);
      if (!rgPath) {
        throw new Error("The search backend (rg) is not available and could not be downloaded");
      }
      const { targets, rangesByAbsolutePath, missingPaths, displayPathByAbsolutePath, cleanup } = await expandSearchTargets(pathSpecs, cwd, rgPath);
      try {
        if (targets.length === 0) {
          throw new Error(`Path not found: ${missingPaths.join(", ")}`);
        }

        const ignoreCase = params.i === true;
        const useGitignore = params.gitignore !== false;
        const args = ["--json", "--line-number", "--color=never", "--hidden"];
        if (ignoreCase) {
          args.push("--ignore-case");
        }
        if (!useGitignore) {
          args.push("--no-ignore", "--no-ignore-parent", "--no-ignore-vcs");
        }
        for (const ignorePattern of SEARCH_IGNORE_PATTERNS) {
          args.push("--glob", `!${ignorePattern}`);
        }
        if (normalizedPattern.includes("\n") || normalizedPattern.includes("\\n")) {
          args.push("--multiline");
        }
        // `--` terminates rg flag parsing so a pattern/path beginning with a
        // dash (e.g. "--pre", "-f") can't be interpreted as an rg option.
        args.push("--", normalizedPattern, ...targets);

        const matches: SearchMatch[] = [];
        const seenMatchKeys = new Set<string>();
        let stderr = "";
        let aborted = false;
        let matchCapReached = false;
        let lineTruncationHit = false;

        await new Promise<void>((resolve, reject) => {
          const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
          const reader = createInterface({ input: child.stdout });
          const cleanupChild = () => {
            reader.close();
            signal?.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            aborted = true;
            if (!child.killed) {
              child.kill();
            }
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
          });
          reader.on("line", (line) => {
          if (!line.trim()) {
            return;
          }
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          const parsed = event as {
            type?: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
              lines?: { text?: string };
            };
          };
          if (parsed.type !== "match") {
            return;
          }
          const matchPath = parsed.data?.path?.text;
          const lineNumber = parsed.data?.line_number;
          const lineText = parsed.data?.lines?.text;
          if (!matchPath || typeof lineNumber !== "number" || typeof lineText !== "string") {
            return;
          }
          const absolutePath = path.resolve(matchPath);
          const ranges = rangesByAbsolutePath.get(absolutePath);
          if (ranges && !lineIsInRanges(lineNumber, ranges)) {
            return;
          }
          const truncatedLine = truncateSearchLine(lineText.replace(/\r?\n$/, ""));
          if (truncatedLine.truncated) {
            lineTruncationHit = true;
          }
            const relativePath = displayPathByAbsolutePath.get(absolutePath)
              ?? (path.relative(cwd, absolutePath).replace(/\\/g, "/") || path.basename(absolutePath));
          const matchKey = `${absolutePath}:${lineNumber}:${truncatedLine.text}`;
          if (seenMatchKeys.has(matchKey)) {
            return;
          }
          seenMatchKeys.add(matchKey);
          matches.push({
            absolutePath,
            relativePath,
            lineNumber,
            lineText: truncatedLine.text,
          });
          if (matches.length >= SEARCH_INTERNAL_MATCH_CAP) {
            matchCapReached = true;
            if (!child.killed) {
              child.kill();
            }
          }
        });
          child.on("error", (error) => {
            cleanupChild();
            reject(new Error(`Failed to run the search backend (rg): ${error.message}`));
          });
          child.on("close", (code) => {
            cleanupChild();
            if (aborted) {
              reject(new Error("Operation aborted"));
              return;
            }
            if (matchCapReached) {
              resolve();
              return;
            }
            if (code !== 0 && code !== 1) {
              reject(new Error(stderr.trim() || `The search backend (rg) exited with code ${code}`));
              return;
            }
            resolve();
          });
        });

        const groupedByFile = new Map<string, SearchMatch[]>();
        for (const match of matches) {
          if (!groupedByFile.has(match.relativePath)) {
            groupedByFile.set(match.relativePath, []);
          }
          groupedByFile.get(match.relativePath)!.push(match);
        }
        const fileOrder = [...groupedByFile.keys()].sort((left, right) =>
          left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
        );

        let perFileLimitReached = false;
        for (const filePath of fileOrder) {
          const fileMatches = groupedByFile.get(filePath)!;
          if (fileMatches.length > SEARCH_PER_FILE_MATCH_LIMIT) {
            perFileLimitReached = true;
            fileMatches.length = SEARCH_PER_FILE_MATCH_LIMIT;
          }
        }

        const totalFiles = fileOrder.length;
        const visibleFiles = fileOrder.slice(skip, skip + SEARCH_FILE_WINDOW);
        const fileLimitReached = totalFiles > skip + SEARCH_FILE_WINDOW;
        const selectedMatches: SearchMatch[] = [];
        for (const filePath of visibleFiles) {
          selectedMatches.push(...(groupedByFile.get(filePath) ?? []));
        }
        const contextualMatches = await enrichMatchesWithContext({
          matches: selectedMatches,
          rangesByAbsolutePath,
        });
        if (contextualMatches.lineTruncationHit) {
          lineTruncationHit = true;
        }
        const summary = summarizeSearchResult({
          matches: contextualMatches.matches,
          skip,
          totalFiles,
          selectedFiles: visibleFiles.length,
          fileLimitReached,
          perFileLimitReached,
          matchCapReached,
          lineTruncationHit,
          missingPaths,
        });
        return {
          content: [{ type: "text" as const, text: summary.text }],
          details: summary.details,
        };
      } finally {
        await cleanup();
      }
    },
  };
}
