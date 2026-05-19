import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKSPACE_APPS_DIALOG_PATH = new URL(
  "./WorkspaceAppsDialog.tsx",
  import.meta.url,
);

test("workspace apps dialog wraps the apps gallery in a centered modal window", async () => {
  const source = await readFile(WORKSPACE_APPS_DIALOG_PATH, "utf8");

  assert.match(source, /import \{ LayoutGrid, X \} from "lucide-react";/);
  assert.match(source, /import \{ AppsGallery \} from "@\/components\/marketplace\/AppsGallery";/);
  assert.match(source, /interface WorkspaceAppsDialogProps \{\s*open: boolean;\s*onClose: \(\) => void;\s*\}/);
  assert.match(source, /if \(!open\) \{\s*return null;\s*\}/);
  assert.match(source, /document\.body\.style\.overflow = "hidden";/);
  assert.match(source, /document\.body\.style\.overflow = "";/);
  assert.match(source, /if \(event\.key === "Escape"\) \{\s*onClose\(\);\s*\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-label="Add apps"/);
  assert.match(source, /aria-label="Close add apps"/);
  assert.doesNotMatch(source, /Install available apps into/);
  assert.doesNotMatch(source, /Marketplace catalog/);
  assert.doesNotMatch(source, /Local catalog/);
  assert.doesNotMatch(source, /useWorkspaceDesktop/);
  assert.match(source, /<AppsGallery \/>/);
});
