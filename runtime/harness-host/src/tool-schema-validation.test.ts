import assert from "node:assert/strict";
import test from "node:test";

import {
  collectInvalidSchemaPropertyKeys,
  countUnionTypeSiblings,
  normalizeUnionTypeSiblings,
  partitionToolsByValidSchema,
  sanitizeInvalidSchemaPropertyKeys,
} from "./tool-schema-validation.js";

test("accepts schemas whose property keys match the Anthropic pattern", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "number" },
      "filter.value": { type: "string" },
    },
  };
  assert.deepEqual(collectInvalidSchemaPropertyKeys(schema), []);
});

test("flags a top-level property key containing a space", () => {
  const schema = {
    type: "object",
    properties: {
      "competitor moves": { type: "string" },
    },
  };
  assert.deepEqual(collectInvalidSchemaPropertyKeys(schema), ["competitor moves"]);
});

test("flags invalid keys nested inside object properties and arrays", () => {
  const schema = {
    type: "object",
    properties: {
      payload: {
        type: "object",
        properties: { "bad key": { type: "string" } },
      },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: { "another bad": { type: "number" } },
        },
      },
    },
  };
  assert.deepEqual(
    collectInvalidSchemaPropertyKeys(schema).sort(),
    ["another bad", "bad key"],
  );
});

test("flags invalid keys under $defs", () => {
  const schema = {
    type: "object",
    properties: { ref: { $ref: "#/$defs/Bad Def" } },
    $defs: { "Bad Def": { type: "string" } },
  };
  assert.deepEqual(collectInvalidSchemaPropertyKeys(schema), ["Bad Def"]);
});

test("flags keys longer than 64 characters", () => {
  const longKey = "a".repeat(65);
  const schema = { type: "object", properties: { [longKey]: { type: "string" } } };
  assert.deepEqual(collectInvalidSchemaPropertyKeys(schema), [longKey]);
});

test("tolerates non-object schemas without throwing", () => {
  assert.deepEqual(collectInvalidSchemaPropertyKeys(null), []);
  assert.deepEqual(collectInvalidSchemaPropertyKeys(undefined), []);
  assert.deepEqual(collectInvalidSchemaPropertyKeys("string"), []);
});

test("partitions tools, keeping valid ones and reporting offending keys", () => {
  const good = {
    name: "twitter_create_post",
    parameters: { type: "object", properties: { text: { type: "string" } } },
  };
  const bad = {
    name: "composio_competitor_watch",
    parameters: { type: "object", properties: { "competitor moves": { type: "string" } } },
  };
  const { valid, dropped } = partitionToolsByValidSchema([good, bad]);
  assert.deepEqual(valid, [good]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].tool.name, "composio_competitor_watch");
  assert.deepEqual(dropped[0].invalidKeys, ["competitor moves"]);
});

test("sanitize leaves a clean schema structurally unchanged", () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string" }, "filter.value": { type: "number" } },
    required: ["query"],
  };
  assert.deepEqual(sanitizeInvalidSchemaPropertyKeys(schema), schema);
});

test("sanitize strips invalid keys but keeps valid siblings and the tool usable", () => {
  const schema = {
    type: "object",
    properties: {
      base_id: { type: "string" },
      fields: {
        type: "object",
        properties: {
          Name: { type: "string" },
          "Due Date": { type: "string" },
          "Assigned To": { type: "string" },
        },
      },
    },
  };
  const clean = sanitizeInvalidSchemaPropertyKeys(schema);
  // Offending nested keys gone, valid ones (including the whole outer schema) kept.
  assert.deepEqual(collectInvalidSchemaPropertyKeys(clean), []);
  const fields = (clean as typeof schema).properties.fields.properties;
  assert.deepEqual(Object.keys(fields), ["Name"]);
  assert.ok("base_id" in (clean as typeof schema).properties);
});

test("sanitize prunes required entries whose property was removed", () => {
  const schema = {
    type: "object",
    properties: { ok_field: { type: "string" }, "bad key": { type: "string" } },
    required: ["ok_field", "bad key"],
  };
  const clean = sanitizeInvalidSchemaPropertyKeys(schema) as typeof schema;
  assert.deepEqual(clean.required, ["ok_field"]);
  assert.deepEqual(collectInvalidSchemaPropertyKeys(clean), []);
});

test("sanitize strips invalid keys nested in array item schemas", () => {
  const schema = {
    type: "object",
    properties: {
      records: {
        type: "array",
        items: { type: "object", properties: { "bad key": { type: "string" } } },
      },
    },
  };
  assert.deepEqual(
    collectInvalidSchemaPropertyKeys(sanitizeInvalidSchemaPropertyKeys(schema)),
    [],
  );
});

test("sanitize tolerates non-object schemas", () => {
  assert.equal(sanitizeInvalidSchemaPropertyKeys(null), null);
  assert.equal(sanitizeInvalidSchemaPropertyKeys("x"), "x");
});

test("counts union nodes that also carry a sibling type", () => {
  const schema = {
    anyOf: [{ type: "string" }, { type: "null" }],
    type: "string",
    properties: {
      nested: { oneOf: [{ type: "number" }], type: "number" },
      clean: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };
  assert.equal(countUnionTypeSiblings(schema), 2);
});

test("normalizes a root anyOf + type into the Moonshot-accepted form", () => {
  const schema = { anyOf: [{ type: "string" }, { type: "null" }], type: "string" };
  const fixed = normalizeUnionTypeSiblings(schema);
  assert.deepEqual(fixed, { anyOf: [{ type: "string" }, { type: "null" }] });
  assert.equal(countUnionTypeSiblings(fixed), 0);
});

test("pushes a parent string type down into union branches that lack one", () => {
  const schema = {
    anyOf: [{ maxLength: 5 }, { const: "x" }],
    type: "string",
  };
  const fixed = normalizeUnionTypeSiblings(schema) as {
    anyOf: Array<Record<string, unknown>>;
    type?: unknown;
  };
  assert.equal("type" in fixed, false);
  assert.deepEqual(fixed.anyOf, [
    { maxLength: 5, type: "string" },
    { const: "x", type: "string" },
  ]);
});

test("normalizes union+type nodes nested inside properties and arrays", () => {
  const schema = {
    type: "object",
    properties: {
      choice: { anyOf: [{ type: "string" }, { type: "number" }], type: "string" },
      rows: {
        type: "array",
        items: { oneOf: [{ type: "object" }, { type: "null" }], type: "object" },
      },
    },
  };
  const fixed = normalizeUnionTypeSiblings(schema);
  assert.equal(countUnionTypeSiblings(fixed), 0);
  // The object root (no union) keeps its type; only the union nodes are rewritten.
  assert.equal((fixed as { type: string }).type, "object");
});

test("normalize leaves a schema without union+type collisions untouched", () => {
  const schema = {
    type: "object",
    properties: {
      maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
      name: { type: "string" },
    },
  };
  assert.deepEqual(normalizeUnionTypeSiblings(schema), schema);
});

test("normalize tolerates non-object schemas", () => {
  assert.equal(normalizeUnionTypeSiblings(null), null);
  assert.equal(normalizeUnionTypeSiblings("x"), "x");
  assert.equal(countUnionTypeSiblings(null), 0);
});
