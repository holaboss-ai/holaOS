import fs from "node:fs";
import path from "node:path";

export interface HarnessWorkspaceBoundaryPolicy {
  workspaceDir: string;
  workspaceRealDir: string;
  overrideRequested: boolean;
  allowedExternalDirs: string[];
}

function normalizedWorkspaceDir(workspaceDir: string): { resolved: string; real: string } {
  const resolved = path.resolve(workspaceDir);
  try {
    return { resolved, real: fs.realpathSync(resolved) };
  } catch {
    return { resolved, real: resolved };
  }
}

function normalizedAllowedExternalDirs(allowedExternalDirs: readonly string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const rawDir of allowedExternalDirs) {
    const trimmed = rawDir.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    let canonical = resolved;
    try {
      canonical = fs.realpathSync(resolved);
    } catch {
      canonical = resolved;
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    ordered.push(canonical);
  }
  return ordered;
}

export function createHarnessWorkspaceBoundaryPolicy(
  workspaceDir: string,
  overrideRequested: boolean,
  options: { allowedExternalDirs?: readonly string[] } = {},
): HarnessWorkspaceBoundaryPolicy {
  const normalized = normalizedWorkspaceDir(workspaceDir);
  return {
    workspaceDir: normalized.resolved,
    workspaceRealDir: normalized.real,
    overrideRequested,
    allowedExternalDirs: normalizedAllowedExternalDirs(
      options.allowedExternalDirs ?? [],
    ),
  };
}

/**
 * Resolve an MCP / skill / attachment path. Relative paths resolve against the
 * workspace dir. Workspace-boundary enforcement has been removed — paths that
 * land outside the workspace are resolved and returned rather than rejected, so
 * agent operations are no longer restricted to within the workspace.
 */
export function resolvePathWithinHarnessWorkspace(
  policy: Pick<HarnessWorkspaceBoundaryPolicy, "workspaceDir">,
  candidate: string,
): string | null {
  const raw = candidate.trim();
  if (!raw) {
    return null;
  }
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(policy.workspaceDir, raw);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Detects whether the instruction explicitly opts into broader access. The
 * tool-call boundary that this once gated has been removed; the flag is still
 * surfaced for skill widening (workspace-skills), so it is retained.
 */
export function workspaceBoundaryOverrideRequested(instruction: string): boolean {
  const normalized = instruction.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    /(?:workspace[_ -]?boundary[_ -]?override\s*[:=]\s*(?:1|true|yes|on))|(?:#allow-outside-workspace)/i.test(
      normalized,
    )
  ) {
    return true;
  }
  const insist = /\b(i insist|insist|override|must)\b/i.test(normalized);
  const outsideScope =
    /\b(outside (?:the )?workspace|outside workspace|cross[- ]workspace|parent directory|external path|beyond (?:the )?workspace)\b/i.test(
      normalized,
    ) || /(?:\.\.\/|~\/|\/users\/|\/etc\/|\/var\/)/i.test(normalized);
  return insist && outsideScope;
}
