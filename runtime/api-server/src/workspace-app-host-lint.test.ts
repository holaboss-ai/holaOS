import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  findProviderEffectManifestViolations,
  formatProviderEffectManifestLintError,
} from "./workspace-app-host-lint.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeAppDir(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-effect-lint-"));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  return root;
}

describe("findProviderEffectManifestViolations", () => {
  test("flags providerEffectAction providers that are missing from integrations", () => {
    const appDir = makeAppDir({
      "src/send.ts": [
        "import { providerEffectAction } from \"@holaboss/app-builder-sdk\";",
        "",
        "export const send = providerEffectAction({",
        "  provider: \"gmail\",",
        "  fromStates: [\"approved\"],",
        "  toState: \"sent\",",
        "  blockedState: \"send_blocked\",",
        "  buildRequest: ({ row }) => ({ to: row.email }),",
        "  execute: async ({ bridge, request }) => bridge.call(\"POST\", \"/messages/send\", request),",
        "});",
        "",
      ].join("\n"),
    });

    const violations = findProviderEffectManifestViolations(appDir, ["twitter"]);
    assert.equal(violations.length, 1);
    assert.deepEqual(violations[0], {
      file: "src/send.ts",
      line: 3,
      provider: "gmail",
      snippet: "export const send = providerEffectAction({",
    });

    const formatted = formatProviderEffectManifestLintError(violations);
    assert.match(formatted, /providerEffectAction/);
    assert.match(formatted, /gmail/);
    assert.match(formatted, /app\.runtime\.yaml/);
  });

  test("accepts providerEffectAction providers that are declared in integrations", () => {
    const appDir = makeAppDir({
      "src/send.ts": [
        "import { providerEffectAction } from \"@holaboss/app-builder-sdk\";",
        "",
        "export const send = providerEffectAction({",
        "  provider: \"gmail\",",
        "  fromStates: [\"approved\"],",
        "  toState: \"sent\",",
        "  blockedState: \"send_blocked\",",
        "  buildRequest: ({ row }) => ({ to: row.email }),",
        "  execute: async ({ bridge, request }) => bridge.call(\"POST\", \"/messages/send\", request),",
        "});",
        "",
      ].join("\n"),
    });

    const violations = findProviderEffectManifestViolations(appDir, ["gmail"]);
    assert.deepEqual(violations, []);
  });
});
