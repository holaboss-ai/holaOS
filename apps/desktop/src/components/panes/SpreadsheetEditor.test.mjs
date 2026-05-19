import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "SpreadsheetEditor.tsx");

test("spreadsheet editor preserves link metadata and opens sheet links through the browser callback", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /import type \{ MouseEvent \} from "react";/);
  assert.match(source, /import \{ ArrowUpRight, Plus \} from "lucide-react";/);
  assert.match(source, /onOpenLinkInBrowser\?: \(url: string\) => void;/);
  assert.match(source, /function normalizeSpreadsheetCellLinkTarget\(/);
  assert.match(source, /function cloneTablePreviewSheetLinks\(/);
  assert.match(source, /function cloneTablePreviewSheetImages\(/);
  assert.match(source, /images: cloneTablePreviewSheetImages\(sheet\.images\),/);
  assert.match(source, /function spreadsheetPreviewImagesByCell\(/);
  assert.match(source, /const cellImages = spreadsheetPreviewImagesByCell\(activeSheet\?\.images\);/);
  assert.match(source, /const renderSpreadsheetCellImages = \(/);
  assert.match(source, /<img[\s\S]*src=\{image\.dataUrl\}/);
  assert.match(source, /maxWidth: image\.widthPx/);
  assert.match(source, /maxHeight: image\.heightPx/);
  assert.match(
    source,
    /links: cloneTablePreviewSheetLinks\([\s\S]*sheet\.links,[\s\S]*sheet\.rows,[\s\S]*sheet\.columns,[\s\S]*\),/,
  );
  assert.match(source, /if \(onOpenLinkInBrowser\) \{\s*onOpenLinkInBrowser\(url\);\s*return;\s*\}/);
  assert.match(source, /window\.electronAPI\.ui\.openExternalUrl\(url\)/);
  assert.match(source, /const maybeOpenEditableSpreadsheetCellLink = \(\s*event: MouseEvent<HTMLInputElement>,\s*url: string \| null,\s*\) => \{/);
  assert.match(source, /if \(!url \|\| \(!event\.metaKey && !event\.ctrlKey\)\) \{\s*return;\s*\}/);
  assert.match(source, /onClick=\{\(event\) =>\s*maybeOpenEditableSpreadsheetCellLink\(\s*event,\s*cellLink,\s*\)\s*\}/);
  assert.match(source, /nextLinks\[rowIndex\]\[columnIndex\] =\s*normalizeSpreadsheetCellLinkTarget\(value\);/);
  assert.match(source, /activeSheet\.links\?\.\[rowIndex\]\?\.\[columnIndex\] \?\?\s*normalizeSpreadsheetCellLinkTarget\(value\)/);
  assert.match(source, /aria-label=\{`Open link from row \$\{rowIndex \+ 1\}, column \$\{columnIndex \+ 1\}`\}/);
  assert.match(source, /<ArrowUpRight size=\{12\} \/>/);
  assert.match(source, /onClick=\{\(\) => openSpreadsheetCellLink\(cellLink\)\}/);
  assert.match(source, /text-primary underline underline-offset-2/);
});
