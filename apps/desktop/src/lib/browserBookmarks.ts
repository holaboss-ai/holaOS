export interface BrowserBookmarkFolderNode {
  name: string;
  key: string;
  folders: BrowserBookmarkFolderNode[];
  bookmarks: BrowserBookmarkPayload[];
}

interface MutableBrowserBookmarkFolderNode extends BrowserBookmarkFolderNode {
  children: Map<string, MutableBrowserBookmarkFolderNode>;
}

interface BrowserBookmarkTree {
  folders: BrowserBookmarkFolderNode[];
  rootBookmarks: BrowserBookmarkPayload[];
}

function normalizeFolderSegment(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function browserBookmarkFolderPath(
  bookmark: BrowserBookmarkPayload,
): string[] {
  if (!Array.isArray(bookmark.folderPath)) {
    return [];
  }
  return bookmark.folderPath.map(normalizeFolderSegment).filter(Boolean);
}

function createFolderNode(
  name: string,
  key: string,
): MutableBrowserBookmarkFolderNode {
  return {
    name,
    key,
    folders: [],
    bookmarks: [],
    children: new Map(),
  };
}

function compareFolderNodes(
  left: BrowserBookmarkFolderNode,
  right: BrowserBookmarkFolderNode,
) {
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareBookmarks(
  left: BrowserBookmarkPayload,
  right: BrowserBookmarkPayload,
) {
  const leftLabel = (left.title || left.url).trim();
  const rightLabel = (right.title || right.url).trim();
  return leftLabel.localeCompare(rightLabel, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function finalizeFolderNode(
  node: MutableBrowserBookmarkFolderNode,
): BrowserBookmarkFolderNode {
  return {
    name: node.name,
    key: node.key,
    folders: Array.from(node.children.values())
      .map(finalizeFolderNode)
      .sort(compareFolderNodes),
    bookmarks: [...node.bookmarks].sort(compareBookmarks),
  };
}

export function buildBrowserBookmarkTree(
  bookmarks: BrowserBookmarkPayload[],
): BrowserBookmarkTree {
  const root = createFolderNode("", "__root__");
  const rootBookmarks: BrowserBookmarkPayload[] = [];

  for (const bookmark of bookmarks) {
    const folderPath = browserBookmarkFolderPath(bookmark);
    if (folderPath.length === 0) {
      rootBookmarks.push(bookmark);
      continue;
    }

    let cursor = root;
    for (const segment of folderPath) {
      const nextKey =
        cursor.key === "__root__" ? segment : `${cursor.key}/${segment}`;
      const existing = cursor.children.get(segment);
      if (existing) {
        cursor = existing;
        continue;
      }
      const created = createFolderNode(segment, nextKey);
      cursor.children.set(segment, created);
      cursor = created;
    }
    cursor.bookmarks.push(bookmark);
  }

  return {
    folders: Array.from(root.children.values())
      .map(finalizeFolderNode)
      .sort(compareFolderNodes),
    rootBookmarks,
  };
}
