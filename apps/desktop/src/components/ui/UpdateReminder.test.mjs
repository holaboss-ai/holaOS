import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const UPDATE_REMINDER_PATH = new URL("./UpdateReminder.tsx", import.meta.url);

test("update reminder shows run-in-background only while the update is downloading", async () => {
  const source = await readFile(UPDATE_REMINDER_PATH, "utf8");

  assert.match(source, /function releaseVersionLabel\(status: AppUpdateStatusPayload\)/);
  assert.match(source, /rounded-\[24px\] border border-border\/60 bg-popover\/95 shadow-2xl/);
  assert.match(source, /Desktop update/);
  assert.match(source, /Restart/);
  assert.match(source, /Changelog/);
  assert.match(source, /const shouldShowDismissIcon = status\.downloaded \|\| hasError;/);
  assert.match(source, /const shouldShowBackgroundAction = !status\.downloaded && !hasError;/);
  assert.match(source, /aria-label="Dismiss desktop update"/);
  assert.match(source, /Run in background/);
  assert.doesNotMatch(source, /rounded-full border border-border\/50 px-2 py-0\.5/);
});

test("update reminder maps unsigned-build signature failures to a short hint", async () => {
  const source = await readFile(UPDATE_REMINDER_PATH, "utf8");

  assert.match(source, /code failed to satisfy specified code requirements/);
  assert.match(source, /This install is unsigned, so macOS blocked the signed update\./);
});

test("update reminder keeps the update hint concise", async () => {
  const source = await readFile(UPDATE_REMINDER_PATH, "utf8");

  assert.doesNotMatch(source, /Downloading quietly in the background\./);
  assert.doesNotMatch(source, /Restart now, or close later and Holaboss will install it on quit\./);
  assert.match(source, /%\ downloaded/);
});
