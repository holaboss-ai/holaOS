import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyEnvValue } from "./mcp-env.js";

test("classifyEnvValue: a well-formed {env:NAME} placeholder resolves to its name", () => {
  assert.deepEqual(classifyEnvValue("{env:MY_TOKEN}"), { kind: "env", name: "MY_TOKEN" });
  assert.deepEqual(classifyEnvValue("  {env:A1_b}  "), { kind: "env", name: "A1_b" });
  assert.deepEqual(classifyEnvValue("{env:_underscore}"), { kind: "env", name: "_underscore" });
});

test("classifyEnvValue: placeholder-shaped but invalid var name -> malformed", () => {
  assert.equal(classifyEnvValue("{env:MY-TOKEN}").kind, "malformed"); // hyphen
  assert.equal(classifyEnvValue("{env:9X}").kind, "malformed"); // leading digit
  assert.equal(classifyEnvValue("{env:}").kind, "malformed"); // empty name
  assert.equal(classifyEnvValue("{env:A B}").kind, "malformed"); // space
  assert.equal(classifyEnvValue("{env:a.b}").kind, "malformed"); // dot
});

test("classifyEnvValue: anything not whole-string placeholder-shaped is literal", () => {
  assert.deepEqual(classifyEnvValue("Bearer sk-123"), { kind: "literal" });
  assert.deepEqual(classifyEnvValue("prefix {env:X}"), { kind: "literal" }); // not the whole value
  assert.deepEqual(classifyEnvValue("{env:X} suffix"), { kind: "literal" });
  assert.deepEqual(classifyEnvValue(""), { kind: "literal" });
});
