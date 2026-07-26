import { Language, Parser, type Node } from "web-tree-sitter";

export type SummarySegment =
  | { kind: "elided"; startLine: number; endLine: number }
  | { startLine: number; text: string };

export type SummaryResult = {
  parsed: boolean;
  elided: boolean;
  segments: SummarySegment[];
};

export type SummarizeCodeParams = {
  code: string;
  path: string;
  minBodyLines: number;
  minCommentLines: number;
  unfoldUntilLines?: number;
  unfoldLimitLines?: number;
};

const GRAMMAR_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".cts": "typescript",
  ".mts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "tsx",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".json": "json",
};

type BodyConfig = {
  bodyTypes: ReadonlySet<string>;
  parentTypes?: ReadonlySet<string>;
};

const BODY_CONFIG: Record<string, BodyConfig> = {
  typescript: { bodyTypes: new Set(["statement_block"]) },
  tsx: { bodyTypes: new Set(["statement_block"]) },
  javascript: { bodyTypes: new Set(["statement_block"]) },
  python: {
    bodyTypes: new Set(["block"]),
    parentTypes: new Set(["function_definition", "decorated_definition", "lambda"]),
  },
  rust: {
    bodyTypes: new Set(["block"]),
    parentTypes: new Set(["function_item", "closure_expression"]),
  },
  go: {
    bodyTypes: new Set(["block"]),
    parentTypes: new Set(["function_declaration", "method_declaration", "func_literal"]),
  },
  bash: { bodyTypes: new Set(["compound_statement"]) },
  json: { bodyTypes: new Set<string>() },
};

const COMMENT_NODE_TYPES: ReadonlySet<string> = new Set([
  "comment",
  "line_comment",
  "block_comment",
  "doc_comment",
]);

const EMPTY_RESULT: SummaryResult = { parsed: false, elided: false, segments: [] };

let parserInitPromise: Promise<void> | null = null;
const grammarCache = new Map<string, Promise<Language | null>>();
let parser: Parser | null = null;

function pickGrammarName(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  let bestExt = "";
  let bestGrammar: string | null = null;
  for (const [ext, grammar] of Object.entries(GRAMMAR_BY_EXTENSION)) {
    if (lower.endsWith(ext) && ext.length > bestExt.length) {
      bestExt = ext;
      bestGrammar = grammar;
    }
  }
  return bestGrammar;
}

async function ensureParserInitialized(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init({
      locateFile: (name: string) => {
        if (name === "tree-sitter.wasm") {
          try {
            return require.resolve(`web-tree-sitter/${name}`);
          } catch {
            return name;
          }
        }
        return name;
      },
    });
  }
  await parserInitPromise;
}

async function loadGrammar(name: string): Promise<Language | null> {
  let promise = grammarCache.get(name);
  if (!promise) {
    promise = (async () => {
      try {
        const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
        return await Language.load(wasmPath);
      } catch {
        return null;
      }
    })();
    grammarCache.set(name, promise);
  }
  return promise;
}

type Range = { startRow: number; endRow: number };

function collectFoldRanges(root: Node, config: BodyConfig): Range[] {
  const ranges: Range[] = [];
  if (config.bodyTypes.size === 0) return ranges;

  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (config.bodyTypes.has(node.type)) {
      const parentType = node.parent?.type;
      if (!config.parentTypes || (parentType && config.parentTypes.has(parentType))) {
        ranges.push({ startRow: node.startPosition.row, endRow: node.endPosition.row });
      }
    }
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
  return ranges;
}

function collectCommentRanges(root: Node): Range[] {
  const ranges: Range[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (COMMENT_NODE_TYPES.has(node.type)) {
      ranges.push({ startRow: node.startPosition.row, endRow: node.endPosition.row });
      continue;
    }
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
  return ranges;
}

function rangeContains(outer: Range, inner: Range): boolean {
  return outer.startRow < inner.startRow && inner.endRow < outer.endRow;
}

function selectLeafBodies(ranges: Range[], minBodyLines: number): Range[] {
  const qualifying = ranges.filter((r) => Math.max(0, r.endRow - r.startRow - 1) >= minBodyLines);
  return qualifying.filter((candidate) =>
    !qualifying.some((other) => other !== candidate && rangeContains(candidate, other)),
  );
}

function mergeCommentRuns(ranges: Range[], minCommentLines: number): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startRow - b.startRow);
  const runs: Range[] = [];
  let current = { startRow: sorted[0]!.startRow, endRow: sorted[0]!.endRow };
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i]!;
    if (next.startRow <= current.endRow + 1) {
      current.endRow = Math.max(current.endRow, next.endRow);
    } else {
      runs.push(current);
      current = { startRow: next.startRow, endRow: next.endRow };
    }
  }
  runs.push(current);
  return runs.filter((r) => r.endRow - r.startRow + 1 >= minCommentLines);
}

function buildSegments(lines: readonly string[], elidedFlags: readonly boolean[]): {
  segments: SummarySegment[];
  anyElided: boolean;
} {
  const segments: SummarySegment[] = [];
  let anyElided = false;
  let i = 0;
  while (i < lines.length) {
    if (elidedFlags[i]) {
      let j = i;
      while (j < lines.length && elidedFlags[j]) j += 1;
      segments.push({ kind: "elided", startLine: i + 1, endLine: j });
      anyElided = true;
      i = j;
    } else {
      let j = i;
      while (j < lines.length && !elidedFlags[j]) j += 1;
      segments.push({ startLine: i + 1, text: lines.slice(i, j).join("\n") });
      i = j;
    }
  }
  return { segments, anyElided };
}

export async function summarizeCode(params: SummarizeCodeParams): Promise<SummaryResult> {
  const grammarName = pickGrammarName(params.path);
  if (!grammarName) return EMPTY_RESULT;

  try {
    await ensureParserInitialized();
  } catch {
    return EMPTY_RESULT;
  }

  const language = await loadGrammar(grammarName);
  if (!language) return EMPTY_RESULT;

  if (!parser) {
    parser = new Parser();
  }
  parser.setLanguage(language);

  let tree;
  try {
    tree = parser.parse(params.code);
  } catch {
    return EMPTY_RESULT;
  }
  if (!tree) return EMPTY_RESULT;

  try {
    const lines = params.code.split("\n");
    const lineCount = lines.length;

    const unfoldUntil = params.unfoldUntilLines ?? 0;
    if (lineCount < unfoldUntil) {
      return { parsed: true, elided: false, segments: [] };
    }

    const bodyConfig = BODY_CONFIG[grammarName] ?? { bodyTypes: new Set<string>() };
    const bodyRanges = collectFoldRanges(tree.rootNode, bodyConfig);
    const leafBodies = selectLeafBodies(bodyRanges, params.minBodyLines);

    const commentRanges = collectCommentRanges(tree.rootNode);
    const commentRuns = mergeCommentRuns(commentRanges, params.minCommentLines);

    const elidedFlags = new Array<boolean>(lineCount).fill(false);

    for (const range of leafBodies) {
      const interiorStart = range.startRow + 1;
      const interiorEnd = range.endRow - 1;
      for (let r = interiorStart; r <= interiorEnd; r += 1) {
        if (r >= 0 && r < lineCount) elidedFlags[r] = true;
      }
    }

    for (const run of commentRuns) {
      for (let r = run.startRow; r <= run.endRow; r += 1) {
        if (r >= 0 && r < lineCount) elidedFlags[r] = true;
      }
    }

    const { segments, anyElided } = buildSegments(lines, elidedFlags);
    return { parsed: true, elided: anyElided, segments };
  } finally {
    tree.delete();
  }
}
