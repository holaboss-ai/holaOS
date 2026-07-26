import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const RENDERER_TYPES_PATH = new URL(
  "../src/types/electron.d.ts",
  import.meta.url,
);

test("desktop html-to-pdf export is exposed through the Electron bridge", async () => {
  const [preloadSource, rendererTypesSource] = await Promise.all([
    readFile(PRELOAD_PATH, "utf8"),
    readFile(RENDERER_TYPES_PATH, "utf8"),
  ]);

  assert.match(
    preloadSource,
    /interface HtmlToPdfExportRequestPayload \{\s*html: string;\s*suggestedName\?: string;\s*basePath\?: string \| null;\s*\}/,
  );
  assert.match(
    preloadSource,
    /exportHtmlToPdf: \(payload: HtmlToPdfExportRequestPayload\) =>\s*ipcRenderer\.invoke\("fs:exportHtmlToPdf", payload\)/,
  );
  assert.match(
    rendererTypesSource,
    /interface HtmlToPdfExportRequestPayload \{\s*html: string;\s*suggestedName\?: string;\s*basePath\?: string \| null;\s*\}/,
  );
  assert.match(
    rendererTypesSource,
    /exportHtmlToPdf: \(\s*payload: HtmlToPdfExportRequestPayload,\s*\) => Promise<\{ path: string \| null; canceled: boolean \}>;/,
  );
});

test("desktop html-to-pdf export renders HTML in a hidden BrowserWindow and prints with CSS page sizing", async () => {
  const mainSource = await readFile(MAIN_PATH, "utf8");

  assert.match(
    mainSource,
    /interface HtmlToPdfExportRequestPayload \{\s*html: string;\s*suggestedName\?: string;\s*basePath\?: string \| null;\s*\}/,
  );
  assert.match(mainSource, /const CONTENT_SECURITY_POLICY_META_PATTERN =/);
  assert.match(mainSource, /function htmlPdfSuggestedFileName\(/);
  assert.match(mainSource, /function htmlPdfBaseHrefFromPath\(/);
  assert.match(mainSource, /function prepareHtmlForPdfExport\(/);
  assert.match(mainSource, /async function waitForHtmlPdfRender\(contents: WebContents\): Promise<void> \{/);
  assert.match(mainSource, /new BrowserWindow\(\{\s*show: false,[\s\S]*backgroundColor: "#ffffff",/);
  assert.match(mainSource, /await fs\.mkdtemp\(\s*path\.join\(app\.getPath\("temp"\), "holaboss-html-pdf-"\),\s*\)/);
  assert.match(mainSource, /await renderWindow\.loadFile\(tempHtmlPath\);/);
  assert.match(mainSource, /await waitForHtmlPdfRender\(renderWindow\.webContents\);/);
  assert.match(
    mainSource,
    /await renderWindow\.webContents\.printToPDF\(\{\s*printBackground: true,\s*preferCSSPageSize: true,\s*\}\);/,
  );
  assert.match(
    mainSource,
    /handleTrustedIpc\(\s*"fs:exportHtmlToPdf",\s*\["main"\],\s*async \(_event, payload: HtmlToPdfExportRequestPayload\) =>\s*exportHtmlToPdf\(payload\),\s*\);/,
  );
});
