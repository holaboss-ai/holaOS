import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const preloadSourcePath = path.join(__dirname, "preload.ts");
const electronTypesPath = path.join(
  __dirname,
  "..",
  "src",
  "types",
  "electron.d.ts",
);

test("desktop browser exposes screenshot clipboard capture through Electron IPC", async () => {
  const mainSource = await readFile(mainSourcePath, "utf8");
  const preloadSource = await readFile(preloadSourcePath, "utf8");
  const electronTypes = await readFile(electronTypesPath, "utf8");

  assert.match(mainSource, /ipcMain\.handle\("browser:captureScreenshotToClipboard", async \(\) => \{/);
  assert.match(mainSource, /clipboard\.writeImage\(image\);/);
  assert.match(mainSource, /function readClipboardImagePayload\(\): ClipboardImagePayload \| null \{/);
  assert.match(mainSource, /const image = clipboard\.readImage\(\);/);
  assert.match(mainSource, /const png = image\.toPNG\(\);/);
  assert.match(mainSource, /"clipboard:readImage"/);
  assert.match(mainSource, /"clipboard:writeText"/);
  assert.match(
    preloadSource,
    /captureScreenshotToClipboard: \(\) =>\s*ipcRenderer\.invoke\("browser:captureScreenshotToClipboard"\) as Promise<BrowserClipboardScreenshotPayload>/,
  );
  assert.match(
    preloadSource,
    /readImage: \(\) =>\s*ipcRenderer\.invoke\("clipboard:readImage"\) as Promise<ClipboardImagePayload \| null>/,
  );
  assert.match(
    preloadSource,
    /writeText: \(text: string\) =>\s*ipcRenderer\.invoke\("clipboard:writeText", text\) as Promise<void>/,
  );
  assert.match(
    electronTypes,
    /captureScreenshotToClipboard: \(\) => Promise<BrowserClipboardScreenshotPayload>;/,
  );
  assert.match(electronTypes, /interface ClipboardImagePayload \{/);
  assert.match(electronTypes, /readImage: \(\) => Promise<ClipboardImagePayload \| null>;/);
  assert.match(electronTypes, /writeText: \(text: string\) => Promise<void>;/);
});

test("desktop browser does not expose injected comment capture", async () => {
  const mainSource = await readFile(mainSourcePath, "utf8");
  const preloadSource = await readFile(preloadSourcePath, "utf8");
  const electronTypes = await readFile(electronTypesPath, "utf8");

  assert.doesNotMatch(mainSource, /browserCommentCaptureScript/);
  assert.doesNotMatch(mainSource, /__holabossBrowserCommentCaptureSession/);
  assert.doesNotMatch(mainSource, /data-holaboss-browser-comment-mode/);
  assert.doesNotMatch(mainSource, /browser:captureCommentsForChat/);
  assert.doesNotMatch(preloadSource, /captureCommentsForChat/);
  assert.doesNotMatch(preloadSource, /BrowserCommentCapturePayload/);
  assert.doesNotMatch(electronTypes, /captureCommentsForChat/);
  assert.doesNotMatch(electronTypes, /BrowserCommentCapturePayload/);
});
