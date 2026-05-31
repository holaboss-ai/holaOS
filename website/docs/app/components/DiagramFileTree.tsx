type FileAccent = "brand" | "engine" | "context";

export interface FileNode {
  name: string;
  meta?: string;
  accent?: FileAccent;
  children?: FileNode[];
}

type PrefixSegment = "pipe" | "space" | "branch";

interface TreeRow {
  key: string;
  name: string;
  meta?: string;
  accent?: FileAccent;
  isRoot: boolean;
  prefix: PrefixSegment[];
  branchText?: string;
}

function flattenTree(
  node: FileNode,
  path: string[],
  ancestorsHaveNext: boolean[],
  isLast: boolean,
  isRoot: boolean,
): TreeRow[] {
  const children = node.children ?? [];
  const prefix = ancestorsHaveNext.map((hasNext) => (hasNext ? "pipe" : "space"));
  const rows: TreeRow[] = [
    {
      key: path.join("/"),
      name: node.name,
      meta: node.meta,
      accent: node.accent,
      isRoot,
      prefix,
      branchText: isRoot ? undefined : isLast ? "└─ " : "├─ ",
    },
  ];

  children.forEach((child, index) => {
    const childIsLast = index === children.length - 1;
    rows.push(
      ...flattenTree(
        child,
        [...path, child.name],
        [...ancestorsHaveNext, !childIsLast],
        childIsLast,
        false,
      ),
    );
  });

  return rows;
}

export function DiagramFileTree({ root }: { root: FileNode }) {
  const rows = flattenTree(root, [root.name], [], true, true);

  return (
    <div className="hb-diagram-filetree">
      <div className="hb-ftx" role="tree" aria-label="Workspace filesystem layout">
        {rows.map((row) => {
          const accentClass = row.accent
            ? `hb-ftx__name--${row.accent}`
            : "hb-ftx__name--default";

          return (
            <div
              className={`hb-ftx__row${row.isRoot ? " hb-ftx__row--root" : ""}`}
              key={row.key}
              role="treeitem"
              aria-level={row.prefix.length + 1}
            >
              <span className="hb-ftx__prefix" aria-hidden="true">
                {row.prefix.map((segment, index) => (
                  <span
                    className={`hb-ftx__segment hb-ftx__segment--${segment}`}
                    key={`${row.key}-prefix-${index}`}
                  >
                    {segment === "pipe" ? "│  " : "   "}
                  </span>
                ))}
                {row.branchText ? (
                  <span className="hb-ftx__segment hb-ftx__segment--branch">
                    {row.branchText}
                  </span>
                ) : null}
              </span>
              <span className="hb-ftx__content">
                <span className={`hb-ftx__name ${accentClass}`}>{row.name}</span>
                {row.meta ? <span className="hb-ftx__meta">{row.meta}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
