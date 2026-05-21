// Reject dashboard apps whose src/client/ doesn't actually use the
// @holaboss/ui layout primitives. The SKILL.md widget recipes, the
// Linear visual anchor, and the density rules tell the agent how to
// lay out a dashboard — but agents keep ignoring all of that and
// hand-rolling Tailwind-flexbox + naked Card stacks. Multiple
// iterations of stronger prompt language did not move the needle.
//
// This is the structural backstop: at register time, if the app has a
// src/client/ directory (i.e. it's a dashboard, not an integration-
// only module), it must import at least one of the canonical layout
// primitives from @holaboss/ui. If not, register rejects with a
// concrete list of what the agent should be importing and from where.
//
// This is intentionally a coarse gate. It does NOT try to detect
// "imported StatPill but used it wrong" — that's the next level of
// enforcement (block primitives + scaffold templates), still on the
// table for a future pass. What it DOES kill is the failure mode the
// user just hit: a dashboard with zero @holaboss/ui layout in sight,
// 5 KPIs stacked full-width, no Section, no StatPill, no DataTable.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
]);

const SKIPPED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "out",
]);

// Any one of these as a named or default import from @holaboss/ui is
// enough to pass the gate. The intent is to confirm the agent reached
// for the platform layout vocabulary at least once. The full set
// matters less than the gesture.
const HOLABOSS_UI_LAYOUT_NAMES: ReadonlyArray<string> = [
  // Top-level scaffolding
  "DashboardShell",
  "PageHeader",
  // Section / structure
  "Section",
  // KPI / metric row
  "StatPill",
  // List / table
  "DataTable",
  // States
  "EmptyState",
  "LoadingState",
  "ErrorState",
  // Filter row
  "FilterBar",
];

function walkSourceFiles(rootDir: string): string[] {
  const out: string[] = [];
  function visit(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      out.push(full);
    }
  }
  try {
    if (!statSync(rootDir).isDirectory()) return out;
  } catch {
    return out;
  }
  visit(rootDir);
  return out;
}

// True iff the file imports anything from "@holaboss/ui" (with any
// path suffix — /core, /layouts, /primitives, etc.) and at least one
// of the named imports matches a known layout primitive.
function fileImportsHolabossUiLayout(contents: string): boolean {
  const importRegex = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']@holaboss\/ui(?:\/[^"']*)?["']/g;
  let match: RegExpExecArray | null;
  importRegex.lastIndex = 0;
  while ((match = importRegex.exec(contents)) !== null) {
    const names = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.split(/\s+as\s+/)[0]?.trim() ?? "")
      .filter(Boolean);
    for (const name of names) {
      if (HOLABOSS_UI_LAYOUT_NAMES.includes(name)) return true;
    }
  }
  return false;
}

export interface DashboardUiLintResult {
  hasClientDir: boolean;
  usesHolabossUiLayout: boolean;
  scannedFiles: number;
}

export function inspectDashboardUiUsage(appDir: string): DashboardUiLintResult {
  const clientDir = path.join(appDir, "src", "client");
  if (!existsSync(clientDir)) {
    return { hasClientDir: false, usesHolabossUiLayout: false, scannedFiles: 0 };
  }
  const files = walkSourceFiles(clientDir);
  for (const file of files) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (fileImportsHolabossUiLayout(contents)) {
      return {
        hasClientDir: true,
        usesHolabossUiLayout: true,
        scannedFiles: files.length,
      };
    }
  }
  return {
    hasClientDir: true,
    usesHolabossUiLayout: false,
    scannedFiles: files.length,
  };
}

export function formatDashboardUiLintError(result: DashboardUiLintResult): string {
  return [
    "Dashboard app has a src/client/ directory but its source does not import any layout primitives from `@holaboss/ui`.",
    `Scanned ${result.scannedFiles} client file(s); zero imports of:`,
    `  ${HOLABOSS_UI_LAYOUT_NAMES.join(", ")}`,
    "Pick at least one and use it. Hand-rolled <div className=\"flex flex-col gap-2\"> stacks of cards are the failure mode this lint exists to prevent — they look broken (5 KPIs stacked full-width, no hierarchy, no density) no matter what the SKILL guidance says.",
    "Concretely:",
    "  - KPI row → grid of `StatPill`",
    "  - list of rows → `DataTable`",
    "  - section heading → `Section`",
    "  - empty / loading / error → `EmptyState` / `LoadingState` / `ErrorState`",
    "  - page chrome → `DashboardShell` + `PageHeader`",
    "All exported from `@holaboss/ui`. Do not redefine them. Do not import from `shadcn/ui` or generate a `components/ui/` directory.",
  ].join("\n");
}
