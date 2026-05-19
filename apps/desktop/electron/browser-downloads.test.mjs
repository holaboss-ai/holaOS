import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("browser downloads save into the workspace Downloads folder", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /function resolveWorkspaceDownloadTargetPath\(/);
  assert.match(source, /function consumeBrowserDownloadOverride\(/);
  assert.match(
    source,
    /const downloadsDir = path\.join\(\s*resolveWorkspaceDirSync\(workspaceId\),\s*"Downloads",\s*\);/,
  );
  assert.match(source, /mkdirSync\(downloadsDir, \{ recursive: true \}\);/);
  assert.match(
    source,
    /const sanitizedFilename = sanitizeAttachmentName\(filename \|\| "download"\);/,
  );
  assert.match(source, /while \(existsSync\(candidatePath\)\) \{/);
  assert.match(
    source,
    /const override = consumeBrowserDownloadOverride\(\s*currentWorkspace,\s*item\.getURL\(\),\s*\);/,
  );
  assert.match(
    source,
    /const savePath = override\s*\?\s*""\s*:\s*resolveWorkspaceDownloadTargetPath\(/,
  );
  assert.match(
    source,
    /item\.setSaveDialogOptions\(\{\s*title: override\.dialogTitle,\s*buttonLabel: override\.buttonLabel,\s*defaultPath: override\.defaultPath,/,
  );
  assert.match(
    source,
    /item\.setSavePath\(savePath\);/,
  );
  assert.match(
    source,
    /targetPath: item\.getSavePath\(\) \|\| savePath,/,
  );
  assert.match(
    source,
    /targetPath: item\.getSavePath\(\) \|\| "",/,
  );
  assert.doesNotMatch(source, /app\.getPath\("downloads"\), item\.getFilename\(\)/);
});
