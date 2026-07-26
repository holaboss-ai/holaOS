// Picks the user-facing *results* out of everything a turn dirtied. A run
// produces lots of process noise (source, lockfiles, screenshots, scratch);
// the chat should show the deliverable — the .pptx, the doc, the app — not the
// pile. Pure + dependency-free so it stays unit-testable.

export type TurnResultCard =
  | { kind: "output"; output: WorkspaceOutputRecordPayload }
  | { kind: "app"; appId: string };

// Final, user-facing formats (rendered/data deliverables + links).
const FINAL_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".pdf",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".csv",
  ".tsv",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".avif",
  // Generated video clips are final deliverables (mirrors VIDEO_EXTENSIONS in
  // runtime turn-output-capture). Without these, a rendered .mp4 is classified
  // as neither final nor source and gets dropped — no card renders.
  ".mp4",
  ".mov",
  ".webm",
  ".m4v",
  ".avi",
  ".mkv",
  ".url",
  ".webloc",
]);

// Source / draft formats the agent typically works in on the way to a final
// deliverable. Shown only when the run produced no final deliverable.
const SOURCE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".txt",
  ".rtf",
  ".html",
  ".htm",
]);

type Tier = "final" | "source" | null;

function normalizedPath(output: WorkspaceOutputRecordPayload): string {
  const metaPath =
    typeof output.metadata?.file_path === "string"
      ? (output.metadata.file_path as string)
      : "";
  return (output.file_path ?? metaPath)
    .replace(/[\\/]+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
}

// Lowercased for case-insensitive name/extension/keyword matching.
function pathSegments(output: WorkspaceOutputRecordPayload): string[] {
  const raw = normalizedPath(output).toLowerCase();
  return raw ? raw.split("/").filter(Boolean) : [];
}

// Case-preserving — app ids are matched verbatim against installedApps[].id
// and passed to appSurface.resolveUrl, so they must keep their original case.
function rawPathSegments(output: WorkspaceOutputRecordPayload): string[] {
  const raw = normalizedPath(output);
  return raw ? raw.split("/").filter(Boolean) : [];
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

// Agent-built capabilities/skills are deliverables, not scaffolding — their
// manifest is the artifact. Mirrors outputDeliverableKind in lib/outputs so the
// inline chips and the Outputs library agree on what counts. (Kept inline to
// keep this module dependency-free / unit-testable.)
function isDeliverableManifest(segments: string[]): boolean {
  const name = segments[segments.length - 1] ?? "";
  return (
    (name === "capability.yaml" && segments.includes("capabilities")) ||
    (name === "skill.md" && segments.includes("skills"))
  );
}

// Workspace-managed files that are never a user deliverable: app internals
// (apps/<id>/*), skills, agents.md, and agent process imagery. The library
// hides these centrally; the turn layer keeps them in the raw set so apps/<id>
// can become an App card, then excludes them everywhere else.
function isManagedNoise(segments: string[]): boolean {
  if (segments.length === 0) return false;
  const name = segments[segments.length - 1] ?? "";
  return (
    name === "agents.md" ||
    segments[0] === "apps" ||
    segments.includes("skills") ||
    segments.some((seg) => seg.includes("screenshot"))
  );
}

export function isWorkspaceManagedNoiseOutput(
  output: WorkspaceOutputRecordPayload,
): boolean {
  return isManagedNoise(pathSegments(output));
}

// A file the agent explicitly handed over with `send_file` is a deliverable by
// intent — the user asked for the file itself. Honor that regardless of
// extension, so a delivered docker-compose.yml / config / .txt still gets a
// card instead of being dropped by the final/source whitelist.
function isExplicitlyDeliveredOutput(
  output: WorkspaceOutputRecordPayload,
): boolean {
  const metadata = output.metadata ?? {};
  return (
    metadata.tool_id === "send_file" || metadata.change_type === "delivered"
  );
}

// Classify a non-app output: "final" deliverable, "source" draft, or drop.
function classify(
  output: WorkspaceOutputRecordPayload,
  segments: string[],
): Tier {
  if (isExplicitlyDeliveredOutput(output)) return "final";
  if (segments.length === 0) {
    // Path-less artifact (a generated report / page held as html_content).
    return output.output_type === "document" || output.html_content
      ? "final"
      : null;
  }
  if (isDeliverableManifest(segments)) return "final";
  if (isManagedNoise(segments)) return null;
  const name = segments[segments.length - 1] ?? "";
  const ext = extensionOf(name);
  if (FINAL_EXTENSIONS.has(ext)) return "final";
  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  return null;
}

/**
 * Reduce a turn's raw outputs to the cards worth showing inline.
 * - `apps/<id>/…` files collapse into a single { kind: "app" } card.
 * - final deliverables (docx/pdf/pptx/xlsx/images/links) become output cards.
 * - source drafts (md/txt/html/…) show ONLY when the run produced no final
 *   deliverable and no app — otherwise they're intermediates and get dropped.
 * - everything else (code, config, lockfiles, screenshots, scratch) is dropped.
 * `totalCount` counts the user-facing files (managed noise excluded), so the
 * "view all N files" hatch matches what the browser modal will actually show.
 */
export function selectTurnResultCards(
  outputs: WorkspaceOutputRecordPayload[],
): { cards: TurnResultCard[]; totalCount: number } {
  const appIds: string[] = [];
  const seenApps = new Set<string>();
  const finals: WorkspaceOutputRecordPayload[] = [];
  const sources: WorkspaceOutputRecordPayload[] = [];

  for (const output of outputs) {
    const segments = pathSegments(output);
    if (segments[0] === "apps") {
      const appId = rawPathSegments(output)[1];
      if (appId && !seenApps.has(appId)) {
        seenApps.add(appId);
        appIds.push(appId);
      }
      continue;
    }
    const tier = classify(output, segments);
    if (tier === "final") finals.push(output);
    else if (tier === "source") sources.push(output);
  }

  // Source drafts are intermediates whenever a real result exists this turn.
  const showSources = finals.length === 0 && appIds.length === 0;
  const deliverables = showSources ? sources : finals;

  const cards: TurnResultCard[] = [
    ...appIds.map((appId) => ({ kind: "app", appId }) as const),
    ...deliverables.map((output) => ({ kind: "output", output }) as const),
  ];
  const totalCount = outputs.filter(
    (output) => !isManagedNoise(pathSegments(output)),
  ).length;
  return { cards, totalCount };
}

// True when a turn's outputs would render anything (an App card, a deliverable
// card, or the "view all" hatch). Mirrors what AssistantTurnOutputs shows, so a
// turn whose only outputs are managed noise (skills/agents.md/screenshots) is
// not treated as renderable — otherwise it shows as an empty assistant bubble.
export function turnHasDisplayableOutputs(
  outputs: WorkspaceOutputRecordPayload[],
): boolean {
  const { cards, totalCount } = selectTurnResultCards(outputs);
  return cards.length > 0 || totalCount > 0;
}
