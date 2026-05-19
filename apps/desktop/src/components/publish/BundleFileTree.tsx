import { ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BundleFileTreeProps {
  workspaceId: string;
  /** Workspace-relative paths the user has unchecked. */
  forceExcludePaths: string[];
  onForceExcludePathsChange: (next: string[]) => void;
}

interface TreeNode {
  /** Full workspace-relative path (forward slashes). */
  path: string;
  /** Last segment of `path` shown to the user. */
  name: string;
  isDir: boolean;
  /** Sum of bytes for this node and all descendants. */
  totalBytes: number;
  /** Direct children (sorted: dirs first, then files, both alpha). */
  children: TreeNode[];
}

interface FlatRow {
  node: TreeNode;
  depth: number;
}

function formatBytes(n: number): string {
  if (!n) {
    return "0 B";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Build a folder/file tree from a flat list of forward-slash paths +
 * sizes. Directories aggregate the byte total of their descendants.
 * Apps/* is filtered upstream — we never render those rows.
 */
function buildTree(files: { path: string; sizeBytes: number }[]): TreeNode {
  const root: TreeNode = {
    path: "",
    name: "",
    isDir: true,
    totalBytes: 0,
    children: [],
  };
  const dirs = new Map<string, TreeNode>();
  dirs.set("", root);

  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let parentPath = "";
    let parent = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const fullPath = parentPath ? `${parentPath}/${part}` : part;
      if (isLast) {
        parent.children.push({
          path: fullPath,
          name: part,
          isDir: false,
          totalBytes: f.sizeBytes,
          children: [],
        });
      } else {
        let next = dirs.get(fullPath);
        if (!next) {
          next = {
            path: fullPath,
            name: part,
            isDir: true,
            totalBytes: 0,
            children: [],
          };
          dirs.set(fullPath, next);
          parent.children.push(next);
        }
        parent = next;
      }
      parentPath = fullPath;
    }
  }

  // Aggregate bytes bottom-up + sort each level (dirs first, alpha).
  function finalize(node: TreeNode): number {
    if (node.isDir) {
      let total = 0;
      for (const child of node.children) {
        total += finalize(child);
      }
      node.totalBytes = total;
      node.children.sort((a, b) => {
        if (a.isDir !== b.isDir) {
          return a.isDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    }
    return node.totalBytes;
  }
  finalize(root);

  return root;
}

/** Resolve effective check state given the current force-exclude set. */
function isExcludedByPath(path: string, excluded: Set<string>): boolean {
  if (excluded.has(path)) {
    return true;
  }
  // Inherit exclusion from a checked-off ancestor directory so
  // `skills/foo.md` shows as unchecked once `skills/` is unchecked.
  for (const entry of excluded) {
    if (path.startsWith(`${entry}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Add `path` to the force-exclude set, then prune any descendants of `path`
 * (they're already covered by the ancestor entry — keeping both wastes
 * storage and confuses the diff for restore-on-reopen).
 */
function addExclusion(current: string[], path: string): string[] {
  const next = current.filter(
    (entry) => entry !== path && !entry.startsWith(`${path}/`),
  );
  next.push(path);
  return next.sort();
}

/**
 * Remove `path` from the force-exclude set. If `path` is itself a descendant
 * of an excluded ancestor (e.g. user excluded `skills/`, then expanded the
 * dir and re-checked `skills/foo.md`), we need to "split" the ancestor: drop
 * the ancestor entry and add explicit entries for every other sibling
 * (and ancestor sibling) that should remain excluded. Walks up at most one
 * ancestor — if there are nested ancestors we find the nearest one.
 */
function removeExclusion(
  current: string[],
  path: string,
  treeRoot: TreeNode,
): string[] {
  // Direct removal — easy case.
  if (current.includes(path)) {
    return current.filter((entry) => entry !== path).sort();
  }

  // Find the nearest excluded ancestor, if any.
  let nearestAncestor: string | null = null;
  for (const entry of current) {
    if (path.startsWith(`${entry}/`)) {
      if (nearestAncestor === null || entry.length > nearestAncestor.length) {
        nearestAncestor = entry;
      }
    }
  }
  if (!nearestAncestor) {
    return current;
  }

  // Split: drop the ancestor entry, then explicitly exclude every sibling
  // along the path from the ancestor down to (but not including) `path`.
  // Each "sibling" is every direct child of an intermediate dir other than
  // the one on our path.
  const next = current.filter((entry) => entry !== nearestAncestor);
  const ancestorParts = nearestAncestor.split("/");
  const targetParts = path.split("/");

  let cursorPath = "";
  let cursorNode: TreeNode | null = treeRoot;
  for (let i = 0; i < ancestorParts.length; i += 1) {
    const part = ancestorParts[i]!;
    cursorPath = cursorPath ? `${cursorPath}/${part}` : part;
    cursorNode = cursorNode?.children.find((c) => c.name === part) ?? null;
    if (!cursorNode) {
      break;
    }
  }
  for (let i = ancestorParts.length; i < targetParts.length; i += 1) {
    if (!cursorNode || !cursorNode.isDir) {
      break;
    }
    const onPath = targetParts[i]!;
    for (const child of cursorNode.children) {
      if (child.name === onPath) {
        continue;
      }
      next.push(child.path);
    }
    cursorNode = cursorNode.children.find((c) => c.name === onPath) ?? null;
    cursorPath = cursorPath ? `${cursorPath}/${onPath}` : onPath;
  }
  return next.sort();
}

/**
 * Flatten the tree into rows respecting the expanded-dir set, depth-first.
 * Hidden files (starting with `.`) are visible — the bundle does ship those
 * if they're not in any ignore list.
 */
function flatten(
  root: TreeNode,
  expanded: Set<string>,
  depth = 0,
  out: FlatRow[] = [],
): FlatRow[] {
  for (const child of root.children) {
    out.push({ node: child, depth });
    if (child.isDir && expanded.has(child.path)) {
      flatten(child, expanded, depth + 1, out);
    }
  }
  return out;
}

export function BundleFileTree({
  workspaceId,
  forceExcludePaths,
  onForceExcludePathsChange,
}: BundleFileTreeProps) {
  const [files, setFiles] = useState<{ path: string; sizeBytes: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Top-level directories start expanded so the tree feels alive on first
  // open — saves users a click before they can prune anything meaningful.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Fetch the canonical "would normally be bundled" file list once per
  // workspace. Pass forceExcludePaths: [] so the response describes the
  // pristine include set; user opt-outs are layered visually via checkboxes
  // and don't affect which rows are visible. apps/* is filtered out because
  // those bytes are never bundled (the install-time runtime fetches each
  // app's GitHub release tarball instead).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.electronAPI.workspace
      .previewBundle({ workspaceId, apps: [], forceExcludePaths: [] })
      .then((preview) => {
        if (cancelled) {
          return;
        }
        const visible = preview.included.filter(
          (f) => !f.path.startsWith("apps/"),
        );
        setFiles(visible);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const root = useMemo(() => buildTree(files), [files]);
  const excludedSet = useMemo(
    () => new Set(forceExcludePaths),
    [forceExcludePaths],
  );

  // Expand the first level by default once the tree is built — only if the
  // user hasn't manually toggled anything yet.
  useEffect(() => {
    if (root.children.length === 0 || expanded.size > 0) {
      return;
    }
    const next = new Set<string>();
    for (const child of root.children) {
      if (child.isDir) {
        next.add(child.path);
      }
    }
    setExpanded(next);
  }, [root, expanded.size]);

  const rows = useMemo(() => flatten(root, expanded), [root, expanded]);

  const totalIncludedBytes = root.totalBytes;
  const droppedBytes = useMemo(() => {
    let bytes = 0;
    function visit(node: TreeNode): void {
      if (excludedSet.has(node.path)) {
        bytes += node.totalBytes;
        return; // entire subtree is excluded; don't double-count children
      }
      for (const child of node.children) {
        visit(child);
      }
    }
    visit(root);
    return bytes;
  }, [root, excludedSet]);
  const remainingBytes = totalIncludedBytes - droppedBytes;
  const droppedCount = forceExcludePaths.length;

  function toggleExpanded(path: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function toggleChecked(node: TreeNode, currentlyExcluded: boolean): void {
    if (currentlyExcluded) {
      onForceExcludePathsChange(
        removeExclusion(forceExcludePaths, node.path, root),
      );
    } else {
      onForceExcludePathsChange(addExclusion(forceExcludePaths, node.path));
    }
  }

  function handleResetAll(): void {
    onForceExcludePathsChange([]);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Files in this template</p>
          <p className="text-xs text-muted-foreground">
            Uncheck anything you don't want to ship. Build artifacts, secrets,
            and personal memory are stripped automatically and don't appear
            here.
          </p>
        </div>
        {droppedCount > 0 ? (
          <Button
            className="shrink-0"
            onClick={handleResetAll}
            size="xs"
            type="button"
            variant="ghost"
          >
            <RotateCcw />
            Reset
          </Button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-lg ring-1 ring-border bg-background">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-3 py-10 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Reading workspace…
          </div>
        ) : error ? (
          <div className="px-3 py-6 text-center text-xs text-destructive">
            Couldn't read the workspace: {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            No files would be bundled.
          </div>
        ) : (
          <ul className="max-h-[420px] divide-y divide-border/40 overflow-y-auto">
            {rows.map(({ node, depth }) => {
              const excluded = isExcludedByPath(node.path, excludedSet);
              const isAncestorExcluded =
                excluded && !excludedSet.has(node.path);
              const expandedHere = expanded.has(node.path);
              return (
                <li key={node.path}>
                  <div
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1.5 text-sm transition-colors",
                      excluded ? "text-muted-foreground" : "hover:bg-fg-2",
                    )}
                    style={{ paddingLeft: 8 + depth * 14 }}
                  >
                    {node.isDir ? (
                      <button
                        aria-label={expandedHere ? "Collapse" : "Expand"}
                        className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-fg-4 hover:text-foreground"
                        onClick={() => toggleExpanded(node.path)}
                        type="button"
                      >
                        <ChevronRight
                          className={cn(
                            "size-3 transition-transform",
                            expandedHere && "rotate-90",
                          )}
                        />
                      </button>
                    ) : (
                      <span className="size-4 shrink-0" aria-hidden />
                    )}
                    <button
                      aria-checked={!excluded}
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                        excluded
                          ? "border-input bg-background"
                          : "border-primary bg-primary text-primary-foreground",
                        isAncestorExcluded && "opacity-50",
                      )}
                      onClick={() => toggleChecked(node, excluded)}
                      role="checkbox"
                      type="button"
                    >
                      {!excluded && (
                        <svg
                          aria-hidden
                          className="size-3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={3}
                          viewBox="0 0 24 24"
                        >
                          <title>checked</title>
                          <path
                            d="M5 13l4 4L19 7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </button>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono text-xs",
                        excluded && "line-through",
                      )}
                    >
                      {node.name}
                      {node.isDir ? "/" : ""}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {formatBytes(node.totalBytes)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {droppedCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          You opted out of {droppedCount} {droppedCount === 1 ? "entry" : "entries"} ·{" "}
          <span className="tabular-nums">{formatBytes(remainingBytes)}</span> /{" "}
          <span className="tabular-nums">{formatBytes(totalIncludedBytes)}</span>{" "}
          will be packaged.
        </p>
      ) : null}
    </div>
  );
}
