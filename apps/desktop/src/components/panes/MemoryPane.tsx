import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SettingsCard } from "@/components/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

type MemorySource = "workspace" | "integrations";
type MemoryViewMode = "file" | "graph";

const GRAPH_LAYOUT_MIN_WIDTH = 860;
const GRAPH_LAYOUT_MIN_HEIGHT = 620;
const GRAPH_LAYOUT_PADDING = 56;
const GRAPH_LAYER_GAP = 96;
const GRAPH_SIBLING_GAP = 34;

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function firstFilePath(
  node: MemoryBrowserTreeNodePayload | null | undefined,
): string | null {
  if (!node) {
    return null;
  }
  if (node.kind === "file") {
    return node.path;
  }
  for (const child of node.children ?? []) {
    const found = firstFilePath(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function treeHasFile(
  node: MemoryBrowserTreeNodePayload | null | undefined,
  targetPath: string,
): boolean {
  if (!node) {
    return false;
  }
  if (node.kind === "file") {
    return node.path === targetPath;
  }
  return (node.children ?? []).some((child) => treeHasFile(child, targetPath));
}

function ancestorPaths(targetPath: string): string[] {
  const segments = targetPath.split("/").filter(Boolean);
  const paths = [""];
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = current ? `${current}/${segment}` : segment;
    paths.push(current);
  }
  return paths;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded =
    value >= 10 || unitIndex === 0
      ? Math.round(value)
      : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function defaultExpandedPaths(): Set<string> {
  return new Set(["", "interaction", "interaction/trees", "integration", "integration/trees"]);
}

function scopedRootNode(
  root: MemoryBrowserTreeNodePayload | null,
  source: MemorySource,
): MemoryBrowserTreeNodePayload | null {
  if (!root) {
    return null;
  }
  const targetChildName = source === "workspace" ? "interaction" : "integration";
  const child = (root.children ?? []).find((entry) => entry.name === targetChildName);
  return {
    ...root,
    children: child ? [child] : [],
  };
}

function graphNodeColor(node: MemoryBrowserGraphNodePayload): string {
  if (node.kind === "root") {
    return "#f2f4f8";
  }
  if (node.kind === "tree") {
    return node.category === "interaction" ? "#ef4444" : "#f59e0b";
  }
  if (node.kind === "entity") {
    return node.category === "integration" ? "#fb7185" : "#38bdf8";
  }
  if (node.kind === "branch") {
    return node.category === "integration" ? "#c084fc" : "#60a5fa";
  }
  if (node.kind === "summary") {
    return "#94a3b8";
  }
  return "#d1d5db";
}

function graphNodeFill(node: MemoryBrowserGraphNodePayload): string {
  if (node.kind === "root") {
    return "#f8fafc";
  }
  if (node.kind === "tree") {
    return node.category === "interaction" ? "#ef4444" : "#f59e0b";
  }
  if (node.kind === "entity") {
    return node.category === "integration" ? "#fb7185" : "#38bdf8";
  }
  if (node.kind === "branch") {
    return node.category === "integration" ? "#c084fc" : "#60a5fa";
  }
  if (node.kind === "summary") {
    return "#d1d5db";
  }
  return "#9ca3af";
}

function graphNodeRadius(node: MemoryBrowserGraphNodePayload): number {
  if (node.kind === "root") {
    return 11;
  }
  if (node.kind === "tree") {
    return 7.5;
  }
  if (node.kind === "entity") {
    return 5.6;
  }
  if (node.kind === "branch") {
    return 4.7;
  }
  if (node.kind === "summary") {
    return 4.25;
  }
  return 3.1;
}

function nodeSortKey(node: MemoryBrowserGraphNodePayload): string {
  const kindOrder =
    node.kind === "root"
      ? "0"
      : node.kind === "tree"
        ? "1"
        : node.kind === "entity"
          ? "2"
          : node.kind === "branch"
            ? "3"
            : node.kind === "summary"
              ? "4"
              : "5";
  const level = node.level == null ? "999" : String(node.level).padStart(3, "0");
  return `${kindOrder}:${level}:${node.label.toLowerCase()}`;
}

interface PositionedGraphNode extends MemoryBrowserGraphNodePayload {
  x: number;
  y: number;
  radius: number;
}

interface MemoryGraphLayout {
  width: number;
  height: number;
  nodes: PositionedGraphNode[];
}

interface MemoryGraphViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

function hashValue(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(value: string, salt: string): number {
  return (hashValue(`${salt}:${value}`) % 10_000) / 10_000;
}

function buildGraphLayout(
  nodes: MemoryBrowserGraphNodePayload[],
  edges: MemoryBrowserGraphEdgePayload[],
): MemoryGraphLayout {
  if (nodes.length === 0) {
    return { width: GRAPH_LAYOUT_MIN_WIDTH, height: GRAPH_LAYOUT_MIN_HEIGHT, nodes: [] };
  }

  const width = Math.max(
    GRAPH_LAYOUT_MIN_WIDTH,
    520 + Math.sqrt(nodes.length) * 170,
  );
  const height = Math.max(
    GRAPH_LAYOUT_MIN_HEIGHT,
    420 + Math.sqrt(nodes.length) * 150,
  );
  const centerX = width / 2;
  const centerY = height / 2;

  const degreeById = new Map<string, number>();
  for (const node of nodes) {
    degreeById.set(node.id, 0);
  }
  for (const edge of edges) {
    degreeById.set(edge.from, (degreeById.get(edge.from) ?? 0) + 1);
    degreeById.set(edge.to, (degreeById.get(edge.to) ?? 0) + 1);
  }

  const byDepth = [...nodes].sort(
    (left, right) =>
      (left.level ?? (left.kind === "root" ? 0 : 10)) -
        (right.level ?? (right.kind === "root" ? 0 : 10)) ||
      nodeSortKey(left).localeCompare(nodeSortKey(right)),
  );
  const positioned = byDepth.map((node, index) => {
    const radius = graphNodeRadius(node);
    const ring =
      node.kind === "root"
        ? 0
        : node.kind === "tree"
          ? 1
          : node.kind === "entity"
            ? 2
            : node.kind === "branch"
              ? 3
              : node.kind === "summary"
                ? 4
                : 5;
    const angle = seededUnit(node.id, "angle") * Math.PI * 2;
    const spread = 68 + ring * 92 + seededUnit(node.id, "spread") * 32;
    const jitterX = (seededUnit(node.id, "jx") - 0.5) * 34;
    const jitterY = (seededUnit(node.id, "jy") - 0.5) * 34;
    return {
      ...node,
      radius,
      x:
        node.kind === "root"
          ? centerX
          : centerX + Math.cos(angle) * spread + jitterX + (index % 3) * 2,
      y:
        node.kind === "root"
          ? centerY
          : centerY + Math.sin(angle) * spread + jitterY + (index % 5) * 1.5,
    };
  });

  const positionById = new Map(positioned.map((node) => [node.id, node]));
  const iterations = nodes.length > 180 ? 160 : 220;
  const repulsionBase = nodes.length > 180 ? 8500 : 11000;
  const centerForce = 0.0024;
  const edgeSpring = 0.0105;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const velocities = new Map<string, { x: number; y: number }>();
    for (const node of positioned) {
      velocities.set(node.id, { x: 0, y: 0 });
    }

    for (let leftIndex = 0; leftIndex < positioned.length; leftIndex += 1) {
      const left = positioned[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < positioned.length; rightIndex += 1) {
        const right = positioned[rightIndex];
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq < 0.01) {
          dx = 0.1 + seededUnit(`${left.id}:${right.id}`, "dx");
          dy = 0.1 + seededUnit(`${left.id}:${right.id}`, "dy");
          distanceSq = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(distanceSq);
        const minDistance = left.radius + right.radius + 18;
        const repulsion = repulsionBase / Math.max(distanceSq, 120);
        const overlap = Math.max(0, minDistance - distance) * 0.16;
        const force = repulsion + overlap;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const leftVelocity = velocities.get(left.id);
        const rightVelocity = velocities.get(right.id);
        if (leftVelocity) {
          leftVelocity.x -= fx;
          leftVelocity.y -= fy;
        }
        if (rightVelocity) {
          rightVelocity.x += fx;
          rightVelocity.y += fy;
        }
      }
    }

    for (const edge of edges) {
      const from = positionById.get(edge.from);
      const to = positionById.get(edge.to);
      if (!from || !to) {
        continue;
      }
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const targetDistance =
        from.kind === "root" || to.kind === "root"
          ? 146
          : from.kind === "tree" || to.kind === "tree"
            ? 106
            : from.kind === "entity" || to.kind === "entity"
              ? 84
              : from.kind === "branch" || to.kind === "branch"
                ? 76
                : 68;
      const spring = (distance - targetDistance) * edgeSpring;
      const fx = (dx / distance) * spring;
      const fy = (dy / distance) * spring;
      const fromVelocity = velocities.get(from.id);
      const toVelocity = velocities.get(to.id);
      if (fromVelocity) {
        fromVelocity.x += fx;
        fromVelocity.y += fy;
      }
      if (toVelocity) {
        toVelocity.x -= fx;
        toVelocity.y -= fy;
      }
    }

    for (const node of positioned) {
      if (node.kind === "root") {
        node.x = centerX;
        node.y = centerY;
        continue;
      }
      const velocity = velocities.get(node.id);
      if (!velocity) {
        continue;
      }
      const degree = degreeById.get(node.id) ?? 1;
      const centralBias =
        node.kind === "tree"
          ? 0.4
          : node.kind === "entity"
            ? 0.28
            : node.kind === "branch"
              ? 0.22
              : node.kind === "summary"
                ? 0.18
                : 0.07;
      velocity.x += (centerX - node.x) * (centerForce + centralBias / 120);
      velocity.y += (centerY - node.y) * (centerForce + centralBias / 120);
      const dampedX = velocity.x / Math.max(1, Math.sqrt(degree));
      const dampedY = velocity.y / Math.max(1, Math.sqrt(degree));
      node.x += Math.max(-14, Math.min(14, dampedX));
      node.y += Math.max(-14, Math.min(14, dampedY));
      node.x = Math.max(
        GRAPH_LAYOUT_PADDING,
        Math.min(width - GRAPH_LAYOUT_PADDING, node.x),
      );
      node.y = Math.max(
        GRAPH_LAYOUT_PADDING,
        Math.min(height - GRAPH_LAYOUT_PADDING, node.y),
      );
    }
  }

  return { width, height, nodes: positioned };
}

function buildGraphViewBox(nodes: PositionedGraphNode[]): MemoryGraphViewBox {
  if (nodes.length === 0) {
    return {
      minX: 0,
      minY: 0,
      width: GRAPH_LAYOUT_MIN_WIDTH,
      height: GRAPH_LAYOUT_MIN_HEIGHT,
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const halo = node.radius + 14;
    minX = Math.min(minX, node.x - halo);
    minY = Math.min(minY, node.y - halo);
    maxX = Math.max(maxX, node.x + halo);
    maxY = Math.max(maxY, node.y + halo);
  }

  const contentWidth = Math.max(120, maxX - minX);
  const contentHeight = Math.max(120, maxY - minY);
  const padding = Math.max(28, Math.min(contentWidth, contentHeight) * 0.12);

  return {
    minX: minX - padding,
    minY: minY - padding,
    width: contentWidth + padding * 2,
    height: contentHeight + padding * 2,
  };
}

interface MemoryTreeEntryProps {
  node: MemoryBrowserTreeNodePayload;
  depth: number;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  onToggleDirectory: (targetPath: string) => void;
  onSelectFile: (targetPath: string) => void;
}

function MemoryTreeEntry({
  node,
  depth,
  expandedPaths,
  selectedPath,
  onToggleDirectory,
  onSelectFile,
}: MemoryTreeEntryProps) {
  const indentStyle = { paddingLeft: `${depth * 14}px` };
  if (node.kind === "directory") {
    const expanded = expandedPaths.has(node.path);
    return (
      <div className="grid gap-1">
        <button
          type="button"
          onClick={() => onToggleDirectory(node.path)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
          style={indentStyle}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
          <FolderOpen className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="text-[11px] text-muted-foreground">
            {(node.children ?? []).length}
          </span>
        </button>
        {expanded
          ? (node.children ?? []).map((child) => (
              <MemoryTreeEntry
                key={child.path || child.name}
                node={child}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                selectedPath={selectedPath}
                onToggleDirectory={onToggleDirectory}
                onSelectFile={onSelectFile}
              />
            ))
          : null}
      </div>
    );
  }

  const selected = selectedPath === node.path;
  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.path)}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        selected
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      style={indentStyle}
    >
      <FileText className="size-4" />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
    </button>
  );
}

interface MemoryGraphCanvasProps {
  graph: MemoryBrowserGraphResponsePayload;
  selectedNodeId: string | null;
  onSelectNode: (node: MemoryBrowserGraphNodePayload) => void;
}

function MemoryGraphCanvas({
  graph,
  selectedNodeId,
  onSelectNode,
}: MemoryGraphCanvasProps) {
  const hasRenderableContent = useMemo(
    () => graph.nodes.some((node) => node.kind !== "root"),
    [graph.nodes],
  );
  const layout = useMemo(
    () => buildGraphLayout(graph.nodes, graph.edges),
    [graph.edges, graph.nodes],
  );
  const positionedById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );
  const viewBox = useMemo(() => buildGraphViewBox(layout.nodes), [layout.nodes]);

  if (!hasRenderableContent) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No graph nodes are visible for this selection.
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden bg-[#171717]">
      <svg
        viewBox={`${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}`}
        className="block h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        style={{
          minHeight: "100%",
        }}
      >
        <rect
          x={viewBox.minX}
          y={viewBox.minY}
          width={viewBox.width}
          height={viewBox.height}
          fill="#171717"
        />
        <g stroke="#7c8593" strokeWidth={1.1} opacity={0.62}>
          {graph.edges.map((edge) => {
            const from = positionedById.get(edge.from);
            const to = positionedById.get(edge.to);
            if (!from || !to) {
              return null;
            }
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            const startX = from.x + (dx / distance) * from.radius;
            const startY = from.y + (dy / distance) * from.radius;
            const endX = to.x - (dx / distance) * to.radius;
            const endY = to.y - (dy / distance) * to.radius;
            return (
              <line
                key={`${edge.from}-${edge.to}-${edge.kind}`}
                x1={startX}
                y1={startY}
                x2={endX}
                y2={endY}
              />
            );
          })}
        </g>
        <g>
          {layout.nodes.map((node) => {
            const selected = node.id === selectedNodeId;
            const glowRadius = node.radius + (selected ? 5.5 : 2.4);
            const interactive = node.kind !== "root";
            return (
              <g
                key={node.id}
                onClick={interactive ? () => onSelectNode(node) : undefined}
                style={{ cursor: interactive ? "pointer" : "default" }}
              >
                <title>{node.label}</title>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={glowRadius}
                  fill={selected ? graphNodeColor(node) : "#ffffff"}
                  opacity={selected ? 0.14 : 0.035}
                />
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.radius}
                  fill={graphNodeFill(node)}
                  stroke={selected ? "#ffffff" : graphNodeColor(node)}
                  strokeWidth={selected ? 2.1 : node.kind === "leaf" ? 0.55 : 0.95}
                />
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export function MemoryPane({ embedded }: { embedded?: boolean } = {}) {
  const { selectedWorkspace, workspaces } = useWorkspaceDesktop();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(
    selectedWorkspace?.id?.trim() || "",
  );
  const [viewMode, setViewMode] = useState<MemoryViewMode>("graph");
  const [memorySource, setMemorySource] = useState<MemorySource>("workspace");
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(
    null,
  );
  const [tree, setTree] = useState<MemoryBrowserTreeResponsePayload | null>(
    null,
  );
  const [graph, setGraph] = useState<MemoryBrowserGraphResponsePayload | null>(
    null,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] =
    useState<MemoryBrowserFileResponsePayload | null>(null);
  const [treeError, setTreeError] = useState("");
  const [graphError, setGraphError] = useState("");
  const [fileError, setFileError] = useState("");
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [isLoadingGraph, setIsLoadingGraph] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    defaultExpandedPaths,
  );
  const workspaceId = activeWorkspaceId.trim();

  useEffect(() => {
    if (selectedWorkspace?.id?.trim()) {
      setActiveWorkspaceId((current) =>
        current.trim() ? current : selectedWorkspace.id.trim(),
      );
      return;
    }
    if (workspaces.length > 0) {
      setActiveWorkspaceId((current) =>
        current.trim() ? current : workspaces[0]?.id?.trim() || "",
      );
    }
  }, [selectedWorkspace?.id, workspaces]);

  const activeWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === workspaceId) ??
      selectedWorkspace ??
      null,
    [selectedWorkspace, workspaceId, workspaces],
  );

  const loadFile = useCallback(
    async (targetPath: string) => {
      if (!workspaceId) {
        return;
      }
      setIsLoadingFile(true);
      setFileError("");
      try {
        const response = await window.electronAPI.workspace.readMemoryBrowserFile(
          workspaceId,
          targetPath,
        );
        setSelectedFile(response);
      } catch (error) {
        setSelectedFile(null);
        setFileError(normalizeErrorMessage(error));
      } finally {
        setIsLoadingFile(false);
      }
    },
    [workspaceId],
  );

  const loadTree = useCallback(
    async (preferredPath?: string | null) => {
      if (!workspaceId) {
        setTree(null);
        setSelectedPath(null);
        setSelectedFile(null);
        setTreeError("");
        setFileError("");
        setExpandedPaths(defaultExpandedPaths());
        return;
      }
      setIsLoadingTree(true);
      setTreeError("");
      try {
        const response = await window.electronAPI.workspace.listMemoryBrowserTree(
          workspaceId,
        );
        setTree(response);
        const nextSelectedPath =
          preferredPath && treeHasFile(response.root, preferredPath)
            ? preferredPath
            : firstFilePath(response.root);
        setExpandedPaths((previous) => {
          const next = new Set(previous);
          for (const target of ancestorPaths(nextSelectedPath ?? "")) {
            next.add(target);
          }
          return next;
        });
        setSelectedPath(nextSelectedPath);
        if (nextSelectedPath) {
          await loadFile(nextSelectedPath);
        } else {
          setSelectedFile(null);
          setFileError("");
        }
      } catch (error) {
        setTree(null);
        setSelectedPath(null);
        setSelectedFile(null);
        setTreeError(normalizeErrorMessage(error));
      } finally {
        setIsLoadingTree(false);
      }
    },
    [loadFile, workspaceId],
  );

  const loadGraph = useCallback(
    async (preferredNodeId?: string | null) => {
      if (!workspaceId) {
        setGraph(null);
        setSelectedGraphNodeId(null);
        setGraphError("");
        return;
      }
      setIsLoadingGraph(true);
      setGraphError("");
      try {
        const response = await window.electronAPI.workspace.listMemoryBrowserGraph(
          workspaceId,
          {
            forest: memorySource,
          },
        );
        setGraph(response);
        const preferredNode =
          preferredNodeId == null
            ? null
            : response.nodes.find((node) => node.id === preferredNodeId) ?? null;
        const nextSelectedNode =
          preferredNode ??
          response.nodes.find((node) => node.kind !== "root") ??
          response.nodes.find((node) => node.kind === "root") ??
          response.nodes[0] ??
          null;
        setSelectedGraphNodeId(nextSelectedNode?.id ?? null);
        if (nextSelectedNode?.path) {
          await loadFile(nextSelectedNode.path);
        } else if (!nextSelectedNode) {
          setSelectedFile(null);
          setFileError("");
        }
      } catch (error) {
        setGraph(null);
        setSelectedGraphNodeId(null);
        setGraphError(normalizeErrorMessage(error));
      } finally {
        setIsLoadingGraph(false);
      }
    },
    [loadFile, memorySource, workspaceId],
  );

  useEffect(() => {
    void loadTree(null);
  }, [loadTree, workspaceId]);

  useEffect(() => {
    void loadGraph(null);
  }, [loadGraph, memorySource, workspaceId]);

  useEffect(() => {
    setExpandedPaths(defaultExpandedPaths());
    setSelectedPath(null);
    setSelectedFile(null);
    setFileError("");
  }, [memorySource]);

  useEffect(() => {
    setSelectedGraphNodeId(null);
    setSelectedFile(null);
    setFileError("");
  }, [memorySource, workspaceId]);

  const handleRefresh = useCallback(() => {
    void loadTree(selectedPath);
    void loadGraph(selectedGraphNodeId);
  }, [loadGraph, loadTree, selectedGraphNodeId, selectedPath]);

  const handleSelectFile = useCallback(
    (targetPath: string) => {
      setViewMode("file");
      setSelectedGraphNodeId(null);
      setSelectedPath(targetPath);
      setExpandedPaths((previous) => {
        const next = new Set(previous);
        for (const target of ancestorPaths(targetPath)) {
          next.add(target);
        }
        return next;
      });
      void loadFile(targetPath);
    },
    [loadFile],
  );

  const handleToggleDirectory = useCallback((targetPath: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(targetPath)) {
        next.delete(targetPath);
      } else {
        next.add(targetPath);
      }
      return next;
    });
  }, []);

  const handleSelectGraphNode = useCallback(
    (node: MemoryBrowserGraphNodePayload) => {
      setViewMode("file");
      setSelectedGraphNodeId(node.id);
      if (node.path) {
        setSelectedPath(node.path);
        setExpandedPaths((previous) => {
          const next = new Set(previous);
          for (const target of ancestorPaths(node.path ?? "")) {
            next.add(target);
          }
          return next;
        });
        void loadFile(node.path);
      } else {
        setSelectedPath(null);
        setSelectedFile(null);
        setFileError("");
      }
    },
    [loadFile],
  );

  const visibleRoot = useMemo(
    () => scopedRootNode(tree?.root ?? null, memorySource),
    [memorySource, tree?.root],
  );

  const selectedGraphNode = useMemo(
    () =>
      graph?.nodes.find((node) => node.id === selectedGraphNodeId) ??
      null,
    [graph, selectedGraphNodeId],
  );

  if (workspaces.length === 0) {
    return (
      <SettingsCard>
        <div className="p-4 text-sm text-muted-foreground">
          No workspace is selected.
        </div>
      </SettingsCard>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1">
          {([
            { id: "workspace", label: "Workspace" },
            { id: "integrations", label: "Integrations" },
          ] as const).map((option) => (
            <Button
              key={option.id}
              type="button"
              size="xs"
              variant={memorySource === option.id ? "secondary" : "ghost"}
              onClick={() => setMemorySource(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>

        {memorySource === "workspace" ? (
          <>
            <Badge variant="outline" className="bg-background text-foreground">
              Workspace
            </Badge>
            <Select
              value={workspaceId}
              onValueChange={(value) => {
                setActiveWorkspaceId(String(value));
                setExpandedPaths(defaultExpandedPaths());
                setSelectedGraphNodeId(null);
              }}
            >
              <SelectTrigger className="min-w-[220px] max-w-[320px] bg-background">
                <SelectValue>
                  <span className="flex min-w-0 items-center gap-2">
                    {activeWorkspace ? (
                      <WorkspaceIcon workspace={activeWorkspace} size="sm" />
                    ) : null}
                    <span className="truncate">
                      {activeWorkspace?.name?.trim() || workspaceId || "Select workspace"}
                    </span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start" className="min-w-[260px]">
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      <WorkspaceIcon workspace={workspace} size="sm" />
                      <span className="truncate">
                        {workspace.name?.trim() || workspace.id}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : null}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={viewMode === "graph" ? isLoadingGraph : isLoadingTree}
          className="ml-auto"
        >
          {viewMode === "graph" ? (
            isLoadingGraph ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )
          ) : isLoadingTree ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh
        </Button>
      </div>

      <SettingsCard className={embedded ? "" : "overflow-hidden"}>
        <div className="grid h-[540px] grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col border-r border-border bg-muted/10">
            <div className="border-b border-border px-4 py-3 text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Explorer
            </div>
            <div className="min-h-0 overflow-auto p-2">
              {treeError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {treeError}
                </div>
              ) : isLoadingTree && !visibleRoot ? (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading memory tree…
                </div>
              ) : visibleRoot ? (
                <MemoryTreeEntry
                  node={visibleRoot}
                  depth={0}
                  expandedPaths={expandedPaths}
                  selectedPath={selectedPath}
                  onToggleDirectory={handleToggleDirectory}
                  onSelectFile={handleSelectFile}
                />
              ) : (
                <div className="p-3 text-sm text-muted-foreground">
                  No visible memory files yet.
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1">
                {([
                  { id: "graph", label: "Graph" },
                  { id: "file", label: "File" },
                ] as const).map((option) => (
                  <Button
                    key={option.id}
                    type="button"
                    size="xs"
                    variant={viewMode === option.id ? "secondary" : "ghost"}
                    onClick={() => setViewMode(option.id)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>

              {viewMode === "file" ? (
                selectedFile ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Badge variant="outline" className="bg-background">
                      {selectedFile.path}
                    </Badge>
                    <Badge variant="outline" className="bg-background">
                      {formatBytes(selectedFile.size_bytes)}
                    </Badge>
                  </div>
                ) : selectedGraphNode ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Badge variant="outline" className="bg-background">
                      {selectedGraphNode.kind}
                    </Badge>
                    <Badge variant="outline" className="bg-background">
                      {selectedGraphNode.category}
                    </Badge>
                    {selectedGraphNode.level != null ? (
                      <Badge variant="outline" className="bg-background">
                        L{selectedGraphNode.level}
                      </Badge>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    Select a file or graph node to inspect it.
                  </div>
                )
              ) : (
                <div className="text-sm text-muted-foreground">
                  {memorySource === "workspace"
                    ? "Workspace interaction forest"
                    : "Workspace-visible integration forest"}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {viewMode === "graph" ? (
                graphError ? (
                  <div className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    {graphError}
                  </div>
                ) : isLoadingGraph && !graph ? (
                  <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Loading graph…
                  </div>
                ) : graph ? (
                  <MemoryGraphCanvas
                    graph={graph}
                    selectedNodeId={selectedGraphNodeId}
                    onSelectNode={handleSelectGraphNode}
                  />
                ) : (
                  <div className="p-4 text-sm text-muted-foreground">
                    No graph data is visible for this selection.
                  </div>
                )
              ) : (
                <div className="grid gap-4 p-4">
                  {selectedGraphNode ? (
                    <div className="grid gap-2">
                      <div className="text-sm font-medium text-foreground">
                        {selectedGraphNode.label}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="bg-background">
                          {selectedGraphNode.kind}
                        </Badge>
                        <Badge variant="outline" className="bg-background">
                          {selectedGraphNode.category}
                        </Badge>
                        {selectedGraphNode.status ? (
                          <Badge variant="outline" className="bg-background">
                            {selectedGraphNode.status}
                          </Badge>
                        ) : null}
                        {selectedGraphNode.level != null ? (
                          <Badge variant="outline" className="bg-background">
                            L{selectedGraphNode.level}
                          </Badge>
                        ) : null}
                      </div>
                      {selectedGraphNode.subtitle ? (
                        <div className="text-sm text-muted-foreground">
                          {selectedGraphNode.subtitle}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {selectedGraphNode?.tree_id ? (
                    <div className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">Tree:</span>{" "}
                      {selectedGraphNode.tree_id}
                    </div>
                  ) : null}

                  {selectedGraphNode?.child_count != null ? (
                    <div className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">Children:</span>{" "}
                      {selectedGraphNode.child_count}
                    </div>
                  ) : null}

                  {selectedGraphNode?.path && !selectedFile ? (
                    <div className="text-sm text-muted-foreground break-all">
                      <span className="font-medium text-foreground">Path:</span>{" "}
                      {selectedGraphNode.path}
                    </div>
                  ) : null}

                  {fileError ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                      {fileError}
                    </div>
                  ) : isLoadingFile ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      Loading file…
                    </div>
                  ) : selectedFile ? (
                    <pre className="overflow-x-auto rounded-md border border-border bg-muted/20 p-3 text-xs leading-6 whitespace-pre-wrap text-foreground">
                      {selectedFile.content}
                    </pre>
                  ) : selectedGraphNode ? (
                    <div className="text-sm text-muted-foreground">
                      This node does not have a backing markdown file.
                    </div>
                  ) : selectedPath ? (
                    <div className="text-sm text-muted-foreground">
                      Select a file to inspect it.
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      Select a file or graph node to inspect it.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
