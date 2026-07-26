import { remoteApi } from "@/lib/remoteApiClient";

type ListOutputsParams = Parameters<typeof remoteApi.outputs.list>[0];
export type OutputItem = Awaited<
  ReturnType<typeof remoteApi.outputs.list>
>["items"][number];

/** Human label for an output row: capability/skill id, explicit title, else the
 *  file name. */
export function outputDisplayLabel(output: OutputItem): string {
  if (outputDeliverableKind(output)) {
    const id = outputDeliverableId(output);
    if (id) {
      return id;
    }
  }
  const title = typeof output.title === "string" ? output.title.trim() : "";
  if (title && !/[\\/]/.test(title)) {
    return title;
  }
  const parts = outputDisplayPath(output)
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length > 0) {
    return parts[parts.length - 1];
  }
  return title || "Untitled output";
}

// Workspace-managed scaffolding (app source, skills, AGENTS.md) is written to
// the outputs table when the runtime mirrors the workspace folder, but it is
// never a user-facing output. This display filter mirrors what the desktop
// applied at the IPC layer before outputs moved onto the Remote API; it's a
// desktop composition concern over the raw contract and a candidate to push
// server-side under the Phase A2 enrichment pattern.
function outputDisplayPath(output: OutputItem): string {
  const metadataPath =
    typeof output.metadata?.file_path === "string"
      ? output.metadata.file_path.trim()
      : "";
  if (metadataPath) {
    return metadataPath;
  }
  const filePath =
    typeof output.file_path === "string" ? output.file_path.trim() : "";
  if (filePath) {
    return filePath;
  }
  const title = typeof output.title === "string" ? output.title.trim() : "";
  if (/[\\/]/.test(title) || /\.[A-Za-z0-9]+$/.test(title)) {
    return title;
  }
  return "";
}

function outputDisplayPathSegments(output: OutputItem): string[] {
  const normalized = outputDisplayPath(output)
    .replace(/[\\/]+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return normalized ? normalized.split("/").filter(Boolean) : [];
}

export type OutputDeliverableKind = "capability" | "skill";

/**
 * Agent-built capabilities and skills are real deliverables, but they live at
 * well-known workspace paths (capabilities/<id>/capability.yaml, skills/<id>/
 * SKILL.md) whose filename/extension/path would otherwise be filtered out as
 * config or scaffolding. Recognize them so they surface as outputs, and so the
 * UI can label them by id instead of "capability.yaml" / "SKILL.md".
 */
export function outputDeliverableKind(
  output: OutputItem,
): OutputDeliverableKind | null {
  const segments = outputDisplayPathSegments(output);
  const fileName = segments[segments.length - 1] ?? "";
  if (fileName === "capability.yaml" && segments.includes("capabilities")) {
    return "capability";
  }
  if (fileName === "skill.md" && segments.includes("skills")) {
    return "skill";
  }
  return null;
}

/** The capability/skill id (its containing folder) — the label we show. */
function outputDeliverableId(output: OutputItem): string {
  const segments = outputDisplayPathSegments(output);
  return segments[segments.length - 2] ?? "";
}

export function shouldHideWorkspaceManagedArtifactOutput(
  output: OutputItem,
): boolean {
  const segments = outputDisplayPathSegments(output);
  if (segments.length === 0) {
    return false;
  }
  const fileName = segments[segments.length - 1];
  return (
    fileName === "agents.md" ||
    segments[0] === "apps" ||
    segments.includes("skills")
  );
}

// The agent's working files — scripts, code, config, logs, intermediates — get
// written to the outputs table the same way deliverables do, but they are the
// HOW, not the WHAT the user asked for. They already surface inline in chat as
// "Edited X" diff cards, so showing them in Outputs is noise + duplication.
// Outputs should read like a deliverables shelf: documents, images, posts.
const WORKING_FILE_EXTENSIONS = new Set<string>([
  // code / scripts
  "py", "pyi", "ipynb", "js", "mjs", "cjs", "ts", "tsx", "jsx", "sh", "bash",
  "zsh", "fish", "rb", "go", "rs", "java", "kt", "kts", "c", "cc", "cpp", "h",
  "hpp", "cs", "php", "swift", "lua", "pl", "r", "scala", "sql", "vue", "svelte",
  // config / data / build
  "json", "jsonl", "yaml", "yml", "toml", "lock", "env", "ini", "cfg", "conf",
  "xml", "gradle", "dockerfile", "gitignore", "editorconfig", "npmrc",
  // logs / temp / build artifacts
  "log", "tmp", "temp", "map", "pyc", "pyo", "cache", "bak", "swp", "ddl",
]);

function outputFileExtension(output: OutputItem): string {
  const segments = outputDisplayPathSegments(output);
  const fileName = segments[segments.length - 1] ?? "";
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1) : "";
}

/**
 * True for anything that isn't a user-facing deliverable. The outputs table is
 * polluted two ways: (1) tool-call records (`web_search-call_…`, `mcp__…`) that
 * carry no real file — they have NO extension; (2) the agent's working files
 * (`.py`, `.json`, `.log`, …). A genuine deliverable is either a file with a
 * real, non-working extension, or a module/app output (a post — no file, but a
 * `module_id`).
 */
export function shouldHideNonDeliverableOutput(output: OutputItem): boolean {
  const extension = outputFileExtension(output);
  if (extension === "") {
    const moduleId =
      typeof output.module_id === "string" ? output.module_id.trim() : "";
    // No file → keep only real module outputs; the rest are tool-call records.
    return moduleId === "";
  }
  return WORKING_FILE_EXTENSIONS.has(extension);
}

/** Raw outputs minus scaffolding + the agent's working files, de-duplicated by
 *  file — the deliverables shelf the UI shows. The same file is re-recorded on
 *  every save, so collapse those to one row (the most recent, assuming the API
 *  returns newest-first). */
/** Filter scaffolding + the agent's working files and de-duplicate by file.
 *  Shared so every Outputs surface (chat context card, project landing, …)
 *  filters identically. */
export function toDisplayOutputs<T extends OutputItem>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    // Capabilities/skills are deliverables even though their path + extension
    // would normally read as scaffolding/config — keep them.
    if (
      !outputDeliverableKind(item) &&
      (shouldHideWorkspaceManagedArtifactOutput(item) ||
        shouldHideNonDeliverableOutput(item))
    ) {
      continue;
    }
    const key = (
      outputDisplayPath(item) || outputDisplayLabel(item)
    ).toLowerCase();
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    result.push(item);
  }
  return result;
}

export async function listDisplayOutputs(params: ListOutputsParams) {
  const response = await remoteApi.outputs.list(params);
  return { ...response, items: toDisplayOutputs(response.items) };
}
