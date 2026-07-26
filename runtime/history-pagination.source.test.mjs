import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storeSourcePath = path.join(__dirname, "state-store", "src", "store.ts");
const apiSourcePath = path.join(__dirname, "api-server", "src", "app.ts");

test("runtime history path counts and pages messages directly from the store", async () => {
  const [storeSource, apiSource] = await Promise.all([
    readFile(storeSourcePath, "utf8"),
    readFile(apiSourcePath, "utf8"),
  ]);

  assert.match(
    storeSource,
    /countSessionMessages\(params: \{[\s\S]*workspaceId: string;[\s\S]*sessionId: string;[\s\S]*\}\): number \{/,
  );
  assert.match(
    storeSource,
    /SELECT COUNT\(\*\) AS total[\s\S]*FROM session_messages[\s\S]*WHERE workspace_id = \? AND session_id = \?/,
  );
  assert.match(
    apiSource,
    /const order = optionalString\(query\.order\) === "desc" \? "desc" : "asc";/,
  );
  assert.match(
    apiSource,
    /const total = store\.countSessionMessages\(\{ workspaceId, sessionId: params\.sessionId \}\);/,
  );
  assert.match(
    apiSource,
    /store\s*\.listSessionMessages\(\{[\s\S]*limit,[\s\S]*offset,[\s\S]*order[\s\S]*\}\)/,
  );
  assert.doesNotMatch(apiSource, /const allMessages = store\.listSessionMessages/);
});
