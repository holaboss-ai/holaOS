import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "SpaceBrowserExplorerPane.tsx");
const browserSessionUiPath = path.join(__dirname, "browserSessionUi.ts");

test("space browser explorer renders the arc-inspired bottom scope switcher", async () => {
  const source = await readFile(sourcePath, "utf8");

  // The top segmented Tabs control should be gone.
  assert.doesNotMatch(source, /<TabsList/);
  assert.doesNotMatch(source, /<TabsTrigger/);

  // Bottom switcher container.
  assert.match(
    source,
    /flex shrink-0 gap-1 border-t border-border p-1/,
  );

  // Both scope buttons must exist with counts from browserState.tabCounts.
  assert.match(source, /browserState\.tabCounts\.user/);
  assert.match(source, /browserState\.tabCounts\.agent/);

  // Pending agent dot surfaces only when not already on agent scope.
  assert.match(
    source,
    /hasPendingAgentJump && browserSpace !== "agent"/,
  );
});

test("space browser explorer keeps the agent session line compact and only on agent scope", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /Agent Session Browser/);

  // Agent session row is conditional on browserSpace === "agent" and the
  // wrapper is ghost-styled (no border, no background).
  assert.match(
    source,
    /browserSpace === "agent" \? \(\s*<div className="shrink-0 px-2 pt-2">/,
  );

  // Ghost-styled SelectTrigger (no border, transparent bg, text-xs).
  assert.match(
    source,
    /<SelectTrigger\s[\s\S]*?className="h-7 w-full gap-2 rounded-md border-transparent bg-transparent px-2\.5 text-xs leading-none shadow-none/,
  );

  // SelectContent unbinds from trigger position (so the trigger's focus
  // ring doesn't bleed through as a halo) but keeps trigger-matching
  // width so the popup stays inside the sidebar and is not covered by
  // the Electron <webview> in the adjacent browser pane.
  assert.match(
    source,
    /<SelectContent[\s\S]*?alignItemWithTrigger=\{false\}[\s\S]*?sideOffset=\{6\}[\s\S]*?className="p-1"/,
  );

  // Long session titles wrap to at most 2 lines inside the limited width
  // via line-clamp-2 + whitespace-normal, rather than truncating.
  assert.match(
    source,
    /line-clamp-2/,
  );
});

test("space browser explorer adapts the session line to session count", async () => {
  const source = await readFile(sourcePath, "utf8");

  // 0-session branch: plain muted text, no dot, no chevron.
  assert.match(
    source,
    /sortedAgentSessions\.length === 0 \? \(\s*<div className="px-2\.5 py-1 text-xs text-muted-foreground">\s*No agent sessions/,
  );

  // 1-session branch: static row with dot + title, no Select/chevron.
  assert.match(
    source,
    /sortedAgentSessions\.length === 1 \? \(\s*<div\s+className="flex items-center gap-2 px-2\.5 py-1 text-xs leading-none"/,
  );

  // ≥2 sessions fall through to the Select (chevron auto-rendered).
  assert.match(source, /<Select\s+value=\{browserState\.sessionId \?\? undefined\}/);
});

test("browser session status badges use short single-word labels", async () => {
  const source = await readFile(browserSessionUiPath, "utf8");

  assert.match(source, /label: "Active"/);
  assert.match(source, /label: "Waiting"/);
  assert.match(source, /label: "Paused"/);
  assert.match(source, /label: "Error"/);
  assert.match(source, /label: "Sleeping"/);
  assert.match(source, /label: "Locked"/);
  assert.doesNotMatch(source, /label: "Agent paused"/);
  assert.doesNotMatch(source, /label: "Agent operating"/);
});

test("space browser explorer encodes session status tone via dot color only", async () => {
  const source = await readFile(sourcePath, "utf8");

  // Status is now carried purely by a colored dot, not a bordered badge.
  assert.match(source, /case "active":\s*return "bg-success";/);
  assert.match(source, /case "waiting":\s*return "bg-warning";/);
  assert.match(source, /case "paused":\s*return "bg-info";/);
  assert.match(source, /case "error":\s*return "bg-destructive";/);

  // No more old-style status badge classnames.
  assert.doesNotMatch(source, /border-success\/30 bg-success\/10 text-success/);
});

test("space browser explorer does not render a per-tab agent status dot", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(
    source,
    /tab\.id === activeTab\.id[\s\S]*sessionBrowserStatus[\s\S]*inline-block size-2 shrink-0 rounded-full/,
  );
});

test("space browser explorer hides the bookmarks section when empty", async () => {
  const source = await readFile(sourcePath, "utf8");

  // Empty-state placeholder text should be gone — empty bookmarks render nothing.
  assert.doesNotMatch(source, /Saved bookmarks will appear here/);
  // Bookmarks block is conditional on hasBookmarks.
  assert.match(source, /\{hasBookmarks \? \(/);
});

test("space browser explorer preserves imported bookmark folders", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /import \{ buildBrowserBookmarkTree \} from "@\/lib\/browserBookmarks";/,
  );
  assert.match(source, /const bookmarkTree = useMemo\(\s*\(\) => buildBrowserBookmarkTree\(bookmarks\),/);
  assert.match(
    source,
    /const hasBookmarks =\s*bookmarkTree\.rootBookmarks\.length > 0 \|\| bookmarkTree\.folders\.length > 0;/,
  );
  assert.match(source, /<FolderOpen className="size-3\.5 shrink-0" \/>/);
  assert.match(
    source,
    /const \[collapsedBookmarkFolderKeys, setCollapsedBookmarkFolderKeys\] =\s*useState<Set<string>>\(\(\) => new Set\(\)\);/,
  );
  assert.match(source, /aria-expanded=\{isExpanded\}/);
  assert.match(source, /Collapse" : "Expand"} bookmark folder/);
  assert.match(source, /<ChevronRight[\s\S]*rotate-90/);
  assert.match(source, /bookmarkTree\.folders\.map\(\(folder\) => renderBookmarkFolder\(folder\)\)/);
  assert.match(source, /Saved/);
});
