// Dashboard-app UI integrity lints, fired at workspace_apps_register
// for any app that ships a `src/client/` directory.
//
// Two failure modes observed in the field, both bypassing the
// @holaboss/ui design system without obvious symptom:
//
//   1. Agent imports `@holaboss/ui/styles.css` (to get tokens + the
//      pre-baked Tailwind layer), then hand-rolls every component
//      from scratch with ad-hoc class names (e.g. `count-tile`,
//      `state-pill`, `command-rail`, `skeleton-block`). Zero named
//      imports from the library, so the font-weight cap, the OKLch
//      theme tokens, and the density-bearing primitives never touch
//      the rendered output. The dashboard ships looking like an
//      ad-hoc CSS one-off.
//
//   2. Agent ships a local `src/client/src/styles.css` next to
//      `@holaboss/ui/styles.css` containing a parallel design
//      system: hand-rolled CSS custom properties (`--git-open:
//      #1f883d`), hardcoded hex colors, custom radii. The library
//      tokens get overridden by the local stylesheet's variables and
//      the design system becomes purely advisory.
//
// Both are bypasses — the library is imported (so the register-time
// check "is @holaboss/ui in the dep graph?" passes), but no library
// primitives actually compose the UI. The result is the same look
// the user keeps rejecting.
//
// The lints below catch each bypass at register time with a concrete
// error message naming the file and what to do instead. Integration-
// only modules (no src/client/) are exempt from both — they have no
// dashboard UI to constrain.
//
// Note on local stylesheets: this file does NOT forbid app-local
// `*.css` files outright. A legitimate pattern is a small local file
// containing just `@import "tailwindcss"` so the app's compose-time
// classNames (e.g. `grid grid-cols-4 gap-3` around library primitives)
// have utilities available — `@holaboss/ui/styles.css` only ships the
// utilities its OWN primitives use, not every Tailwind class an app
// might compose. What gets rejected is content patterns that signal a
// parallel design system: hex color literals, oklch/hsl/rgb literals
// outside @holaboss/ui, and `--custom-var:` definitions other than
// passthrough `var(--holaOS-token)` forwards.

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

// Threshold: a dashboard whose entire src/client/ uses fewer than
// this many distinct named imports from @holaboss/ui is almost
// certainly bypassing the library. Picked low (3) so apps with a
// genuinely sparse UI (e.g. a single full-bleed Chart) still pass,
// but high enough to catch the "0 imports" bypass cleanly.
const MIN_HOLABOSS_UI_NAMED_IMPORTS = 3;

// Hex literals + standalone color functions in app-local CSS are the
// canonical "parallel design system" signal. The library's stylesheet
// is OKLch tokens routed through CSS variables; an app file that
// defines its own raw colors is bypassing the theme.
const HEX_COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FUNCTION_LITERAL = /\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/i;
// Any CSS custom-property *definition* (`--foo: <value>;`) in app-local
// CSS that doesn't forward an existing holaOS token. The library's
// own tokens live behind `var(--<name>)` references; legitimate app
// passthroughs look like `--my-thing: var(--background);`.
const CUSTOM_VAR_DEFINITION = /^\s*--[a-zA-Z][\w-]*\s*:/m;
const PASSTHROUGH_VAR_VALUE = /:\s*var\(\s*--[a-zA-Z][\w-]+\s*[,)]/;

// Suggestions surfaced in the rejection message. Not exhaustive —
// the message just needs to remind the agent that primitives exist
// for the everyday building blocks.
const SUGGESTED_PRIMITIVES = [
  "Button",
  "Card / CardHeader / CardTitle / CardContent",
  "Table / TableBody / TableRow / TableCell",
  "Badge",
  "StatusDot",
  "EmptyState",
  "Skeleton",
  "Tooltip",
  "Tabs",
  "Dialog / Sheet / Drawer",
  "Input / Select",
  "ChartContainer / ChartTooltip / ChartLegend",
];

function walkSourceFiles(rootDir: string, extensions: ReadonlySet<string>): string[] {
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
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.has(ext)) continue;
      out.push(full);
    }
  }
  visit(rootDir);
  return out;
}

// Extract distinct named imports `{ X, Y as Z }` from any `from
// "@holaboss/ui"` (with optional /subpath) statement in `contents`.
// The `import "@holaboss/ui/styles.css"` side-effect import is NOT
// a named import and does NOT count toward the threshold.
function holabossUiNamedImports(contents: string): Set<string> {
  const out = new Set<string>();
  const re = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']@holaboss\/ui(?:\/[^"']*)?["']/g;
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(contents)) !== null) {
    const names = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.split(/\s+as\s+/)[0]?.trim() ?? "")
      .map((entry) => entry.replace(/^type\s+/, "").trim())
      .filter((entry) => entry.length > 0);
    for (const name of names) out.add(name);
  }
  return out;
}

interface CssParallelSystemFinding {
  file: string;
  line: number;
  /** Raw matched line snippet, trimmed; used to ground the error message. */
  snippet: string;
  /** Why this line was flagged. */
  reason:
    | "hex_color_literal"
    | "color_function_literal"
    | "custom_var_definition";
}

/** Walk every `.css` file under `clientDir` (excluding the library's
 *  own stylesheet — apps don't ship that) and flag every line that
 *  signals a parallel design system. Caller turns the findings into a
 *  rejection message. */
function findParallelDesignSystemMarkers(
  clientDir: string,
): CssParallelSystemFinding[] {
  const cssFiles = walkSourceFiles(clientDir, new Set([".css"]));
  const out: CssParallelSystemFinding[] = [];
  for (const file of cssFiles) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = contents.split(/\r?\n/);
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? "";
      // Strip block comments line-by-line.
      let line = raw;
      if (inBlockComment) {
        const close = line.indexOf("*/");
        if (close < 0) continue;
        line = line.slice(close + 2);
        inBlockComment = false;
      }
      const open = line.indexOf("/*");
      if (open >= 0) {
        const close = line.indexOf("*/", open + 2);
        if (close < 0) {
          inBlockComment = true;
          line = line.slice(0, open);
        } else {
          line = line.slice(0, open) + line.slice(close + 2);
        }
      }
      if (!line.trim()) continue;

      if (HEX_COLOR_LITERAL.test(line)) {
        out.push({
          file,
          line: i + 1,
          snippet: raw.trim().slice(0, 200),
          reason: "hex_color_literal",
        });
        continue;
      }
      if (COLOR_FUNCTION_LITERAL.test(line)) {
        out.push({
          file,
          line: i + 1,
          snippet: raw.trim().slice(0, 200),
          reason: "color_function_literal",
        });
        continue;
      }
      if (CUSTOM_VAR_DEFINITION.test(line) && !PASSTHROUGH_VAR_VALUE.test(line)) {
        out.push({
          file,
          line: i + 1,
          snippet: raw.trim().slice(0, 200),
          reason: "custom_var_definition",
        });
        continue;
      }
    }
  }
  return out;
}

export interface DashboardUiLintResult {
  hasClientDir: boolean;
  /** Number of distinct named imports from @holaboss/ui across src/client/. */
  uniqueHolabossUiNamedImports: number;
  /** The actual names imported (sorted), useful for the error message. */
  holabossUiNamedImportNames: string[];
  /** Lines in app-local CSS that signal a parallel design system. */
  parallelDesignSystemMarkers: Array<{
    file: string;
    line: number;
    snippet: string;
    reason: CssParallelSystemFinding["reason"];
  }>;
  scannedFiles: number;
}

export function inspectDashboardUiUsage(appDir: string): DashboardUiLintResult {
  const clientDir = path.join(appDir, "src", "client");
  if (!existsSync(clientDir)) {
    return {
      hasClientDir: false,
      uniqueHolabossUiNamedImports: 0,
      holabossUiNamedImportNames: [],
      parallelDesignSystemMarkers: [],
      scannedFiles: 0,
    };
  }
  const sourceFiles = walkSourceFiles(clientDir, SCANNABLE_EXTENSIONS);
  const allImports = new Set<string>();
  for (const file of sourceFiles) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const name of holabossUiNamedImports(contents)) {
      allImports.add(name);
    }
  }
  const cssMarkers = findParallelDesignSystemMarkers(clientDir).map((entry) => ({
    file: path.relative(appDir, entry.file),
    line: entry.line,
    snippet: entry.snippet,
    reason: entry.reason,
  }));
  return {
    hasClientDir: true,
    uniqueHolabossUiNamedImports: allImports.size,
    holabossUiNamedImportNames: [...allImports].sort(),
    parallelDesignSystemMarkers: cssMarkers,
    scannedFiles: sourceFiles.length,
  };
}

export interface DashboardUiLintViolation {
  code:
    | "workspace_app_holaboss_ui_named_imports_too_few"
    | "workspace_app_parallel_design_system";
  message: string;
}

const PARALLEL_REASON_LABEL: Record<CssParallelSystemFinding["reason"], string> = {
  hex_color_literal: "hex color literal",
  color_function_literal: "raw color function (rgb/hsl/oklch/lab/lch)",
  custom_var_definition: "custom CSS variable definition (not a `var(--<token>)` forward)",
};

/** Return any violations the registrar should reject on. Empty list
 *  means the dashboard passes both gates. */
export function dashboardUiLintViolations(
  result: DashboardUiLintResult,
): DashboardUiLintViolation[] {
  if (!result.hasClientDir) return [];
  const out: DashboardUiLintViolation[] = [];

  if (result.uniqueHolabossUiNamedImports < MIN_HOLABOSS_UI_NAMED_IMPORTS) {
    out.push({
      code: "workspace_app_holaboss_ui_named_imports_too_few",
      message: [
        `Dashboard app has \`src/client/\` but only ${result.uniqueHolabossUiNamedImports} distinct named import(s) from \`@holaboss/ui\` across ${result.scannedFiles} client file(s).`,
        `Minimum is ${MIN_HOLABOSS_UI_NAMED_IMPORTS}. Importing only \`@holaboss/ui/styles.css\` (the stylesheet) does NOT count — the library exists to provide composable components, not just tokens.`,
        "Replace your hand-rolled className-based components with primitives from `@holaboss/ui`. The everyday building blocks are exported as:",
        SUGGESTED_PRIMITIVES.map((entry) => `  - ${entry}`).join("\n"),
        `Currently imported names: ${result.holabossUiNamedImportNames.length > 0 ? result.holabossUiNamedImportNames.join(", ") : "(none)"}.`,
        "If the library is genuinely missing a primitive, surface to the SDK team — do not redefine one locally.",
      ].join("\n"),
    });
  }

  if (result.parallelDesignSystemMarkers.length > 0) {
    const violations = result.parallelDesignSystemMarkers
      .slice(0, 30)
      .map((entry) => `  - ${entry.file}:${entry.line} [${PARALLEL_REASON_LABEL[entry.reason]}]   ${entry.snippet}`)
      .join("\n");
    const trailer =
      result.parallelDesignSystemMarkers.length > 30
        ? `\n  ...and ${result.parallelDesignSystemMarkers.length - 30} more.`
        : "";
    out.push({
      code: "workspace_app_parallel_design_system",
      message: [
        `Dashboard app's \`src/client/\` CSS contains a parallel design system. The following lines are not allowed:`,
        violations + trailer,
        "Reason: hex color literals, raw color function calls (rgb / hsl / oklch / lab / lch), and `--custom-var:` definitions that don't forward an existing holaOS token all indicate the app is layering its own theme on top of `@holaboss/ui`'s tokens. This consistently produces dashboards that look nothing like the rest of the workspace and bypass the font-weight cap, the OKLch palette, and the workspace theme system entirely.",
        "What's allowed in app-local CSS:",
        "  - `@import \"tailwindcss\"` (so app-side composed Tailwind classes work)",
        "  - empty `@layer base {}` / `@layer components {}` / `@layer utilities {}` blocks",
        "  - `--my-thing: var(--background);` style passthrough forwards of existing holaOS tokens",
        "Use Tailwind utilities + `@holaboss/ui` primitives + theme tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`, etc.) for everything visual. If a value is genuinely missing from the token palette, surface to the SDK team — do not patch it locally.",
      ].join("\n"),
    });
  }

  return out;
}

/** Convenience: join all violation messages into a single string,
 *  suitable for the body of the RuntimeAgentToolsServiceError raised
 *  from `registerWorkspaceApp`. */
export function formatDashboardUiLintError(
  violations: DashboardUiLintViolation[],
): string {
  return violations.map((v) => v.message).join("\n\n");
}
