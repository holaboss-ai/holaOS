import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const AUTH_PANEL_PATH = new URL("./AuthPanel.tsx", import.meta.url);

test("auth panel sign-in messaging uses holaOS account branding", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(
    source,
    /Complete the flow on the holaOS sign-in page\./,
  );
  assert.match(
    source,
    /Managed search through your holaOS account\./,
  );
  assert.match(
    source,
    /Managed by your holaOS account session and runtime binding\./,
  );
  assert.doesNotMatch(
    source,
    /Complete the flow on the Holaboss sign-in page\./,
  );
});
