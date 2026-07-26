// Anthropic rejects the whole request if any tool's schema has a `properties`
// key outside this pattern; one bad external tool would poison every run.
const ANTHROPIC_PROPERTY_KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

const KEYED_SUBSCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkSchema(node: unknown, invalid: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) walkSchema(item, invalid);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (KEYED_SUBSCHEMA_MAPS.has(key) && isRecord(value)) {
      for (const propertyKey of Object.keys(value)) {
        if (!ANTHROPIC_PROPERTY_KEY_RE.test(propertyKey)) {
          invalid.add(propertyKey);
        }
      }
    }
    walkSchema(value, invalid);
  }
}

/** Every `properties`/`$defs`/`definitions` key, at any depth, Anthropic would reject. */
export function collectInvalidSchemaPropertyKeys(schema: unknown): string[] {
  const invalid = new Set<string>();
  walkSchema(schema, invalid);
  return [...invalid];
}

/** Strip Anthropic-invalid `properties`/`$defs`/`definitions` keys (and now-dangling `required` entries) so a tool with one bad nested key stays usable instead of being dropped. */
export function sanitizeInvalidSchemaPropertyKeys<T>(schema: T): T {
  return sanitizeNode(schema) as T;
}

function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeNode(item));
  }
  if (!isRecord(node)) {
    return node;
  }
  const out: Record<string, unknown> = {};
  const removedKeys = new Set<string>();
  for (const [key, value] of Object.entries(node)) {
    if (KEYED_SUBSCHEMA_MAPS.has(key) && isRecord(value)) {
      const cleaned: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value)) {
        if (ANTHROPIC_PROPERTY_KEY_RE.test(propKey)) {
          cleaned[propKey] = sanitizeNode(propValue);
        } else {
          removedKeys.add(propKey);
        }
      }
      out[key] = cleaned;
    } else {
      out[key] = sanitizeNode(value);
    }
  }
  if (removedKeys.size > 0 && Array.isArray(out.required)) {
    out.required = (out.required as unknown[]).filter(
      (name) => !(typeof name === "string" && removedKeys.has(name)),
    );
  }
  return out;
}

/** Nodes carrying both a union (`anyOf`/`oneOf`) and a sibling `type`. Moonshot/
 *  Kimi's JSON-schema flavor rejects the whole request for these ("type should
 *  be defined in anyOf items instead of the parent schema"). */
function walkUnionTypeSiblings(node: unknown, count: { n: number }): void {
  if (Array.isArray(node)) {
    for (const item of node) walkUnionTypeSiblings(item, count);
    return;
  }
  if (!isRecord(node)) return;
  const hasUnion = Array.isArray(node.anyOf) || Array.isArray(node.oneOf);
  if (hasUnion && "type" in node) count.n += 1;
  for (const value of Object.values(node)) walkUnionTypeSiblings(value, count);
}

export function countUnionTypeSiblings(schema: unknown): number {
  const count = { n: 0 };
  walkUnionTypeSiblings(schema, count);
  return count.n;
}

/** Rewrite every node that has both a union (`anyOf`/`oneOf`) and a sibling
 *  `type` into the form Moonshot/Kimi accepts: push a string parent `type` down
 *  into any union branch that lacks its own, then drop the parent `type`. The
 *  result is standard JSON Schema that OpenAI and Anthropic also accept, so this
 *  runs unconditionally (mirrors {@link sanitizeInvalidSchemaPropertyKeys}). */
export function normalizeUnionTypeSiblings<T>(schema: T): T {
  return normalizeUnionNode(schema) as T;
}

function normalizeUnionNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeUnionNode(item));
  }
  if (!isRecord(node)) {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = normalizeUnionNode(value);
  }
  const union = Array.isArray(out.anyOf)
    ? (out.anyOf as unknown[])
    : Array.isArray(out.oneOf)
      ? (out.oneOf as unknown[])
      : null;
  if (union && "type" in out) {
    const parentType = out.type;
    if (typeof parentType === "string") {
      for (const branch of union) {
        if (isRecord(branch) && !("type" in branch)) {
          branch.type = parentType;
        }
      }
    }
    delete out.type;
  }
  return out;
}

export interface DroppedToolSchema<T> {
  tool: T;
  invalidKeys: string[];
}

export interface PartitionedToolSchemas<T> {
  valid: T[];
  dropped: DroppedToolSchema<T>[];
}

/** Split tools by whether Anthropic will accept their schema; caller logs `dropped`. */
export function partitionToolsByValidSchema<T extends { parameters: unknown }>(
  tools: readonly T[],
): PartitionedToolSchemas<T> {
  const valid: T[] = [];
  const dropped: DroppedToolSchema<T>[] = [];
  for (const tool of tools) {
    const invalidKeys = collectInvalidSchemaPropertyKeys(tool.parameters);
    if (invalidKeys.length === 0) {
      valid.push(tool);
    } else {
      dropped.push({ tool, invalidKeys });
    }
  }
  return { valid, dropped };
}
