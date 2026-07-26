import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { buildUniverWorkbookSnapshot } from "./univer-snapshot.js";

type ExcelJSWorkbook = ExcelJS.Workbook;

// Build a workbook, serialize it, and reload it so the ExcelJS model we
// convert matches the production path (readFilePreview loads from a buffer).
async function roundTrip(
  build: (workbook: ExcelJSWorkbook) => void,
): Promise<ExcelJSWorkbook> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer as unknown as ArrayBuffer);
  return reloaded;
}

// Resolve a cell's style object out of the deduped registry.
function cellStyle(
  snapshot: ReturnType<typeof buildUniverWorkbookSnapshot>,
  sheetIndex: number,
  row: number,
  column: number,
) {
  const sheetId = snapshot.sheetOrder[sheetIndex];
  const sheet = snapshot.sheets[sheetId];
  const cell = sheet?.cellData?.[row]?.[column];
  if (!cell || cell.s === undefined || cell.s === null) {
    return undefined;
  }
  return typeof cell.s === "string" ? snapshot.styles[cell.s] : cell.s;
}

test("maps values, types, and sheet order across sheets", async () => {
  const workbook = await roundTrip((wb) => {
    const first = wb.addWorksheet("Customers");
    first.getCell("A1").value = "Name";
    first.getCell("B1").value = "Score";
    first.getCell("A2").value = "Acme";
    first.getCell("B2").value = 42;
    first.getCell("C2").value = true;
    wb.addWorksheet("Notes").getCell("A1").value = "hello";
  });

  const snapshot = buildUniverWorkbookSnapshot(workbook);

  assert.equal(snapshot.sheetOrder.length, 2);
  const firstId = snapshot.sheetOrder[0];
  const first = snapshot.sheets[firstId];
  assert.equal(first?.name, "Customers");
  assert.equal(first?.cellData?.[0]?.[0]?.v, "Name");
  assert.equal(first?.cellData?.[1]?.[0]?.v, "Acme");
  assert.equal(first?.cellData?.[1]?.[1]?.v, 42);
  assert.equal(first?.cellData?.[1]?.[1]?.t, 2); // NUMBER
  assert.equal(first?.cellData?.[0]?.[0]?.t, 1); // STRING
  assert.equal(first?.cellData?.[1]?.[2]?.v, true);
  assert.equal(first?.cellData?.[1]?.[2]?.t, 3); // BOOLEAN

  const secondId = snapshot.sheetOrder[1];
  assert.equal(snapshot.sheets[secondId]?.name, "Notes");
  assert.equal(snapshot.sheets[secondId]?.cellData?.[0]?.[0]?.v, "hello");
});

test("resolves theme, tint, indexed, and argb cell colors", async () => {
  const workbook = await roundTrip((wb) => {
    const ws = wb.addWorksheet("S");
    ws.getCell("A1").value = "themeFill";
    ws.getCell("A1").fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { theme: 4 },
    } as ExcelJS.Fill;
    ws.getCell("A2").value = "tinted";
    ws.getCell("A2").fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { theme: 4, tint: 0.6 },
    } as ExcelJS.Fill;
    ws.getCell("A3").value = "indexedRed";
    // exceljs's TS types omit `indexed`, though it round-trips at runtime.
    ws.getCell("A3").font = {
      color: { indexed: 10 } as unknown as ExcelJS.Color,
    };
    ws.getCell("A4").value = "argb";
    ws.getCell("A4").font = { color: { argb: "FF2E7D32" } };
  });

  const snapshot = buildUniverWorkbookSnapshot(workbook);
  // Office default theme accent1.
  assert.equal(cellStyle(snapshot, 0, 0, 0)?.bg?.rgb, "#4F81BD");
  const tinted = cellStyle(snapshot, 0, 1, 0)?.bg?.rgb;
  assert.notEqual(tinted, "#4F81BD");
  assert.match(tinted ?? "", /^#[0-9A-F]{6}$/); // lighter, still a valid hex
  assert.equal(cellStyle(snapshot, 0, 2, 0)?.cl?.rgb, "#FF0000");
  assert.equal(cellStyle(snapshot, 0, 3, 0)?.cl?.rgb, "#2E7D32");
});

test("emits a valid workbook envelope", async () => {
  const workbook = await roundTrip((wb) => {
    wb.addWorksheet("S").getCell("A1").value = "x";
  });

  const snapshot = buildUniverWorkbookSnapshot(workbook, { id: "wb-1" });

  assert.equal(snapshot.id, "wb-1");
  assert.equal(typeof snapshot.appVersion, "string");
  assert.ok(snapshot.styles && typeof snapshot.styles === "object");
  assert.equal(Object.keys(snapshot.sheets).length, snapshot.sheetOrder.length);
});

test("captures bold, font color, and background fill as a deduped style", async () => {
  const workbook = await roundTrip((wb) => {
    const ws = wb.addWorksheet("S");
    const header = ws.getCell("A1");
    header.value = "H";
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2E7D46" },
    };
    // A second cell with the identical style must share the registry entry.
    const twin = ws.getCell("B1");
    twin.value = "H2";
    twin.font = { bold: true, color: { argb: "FFFFFFFF" } };
    twin.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2E7D46" },
    };
  });

  const snapshot = buildUniverWorkbookSnapshot(workbook);
  const style = cellStyle(snapshot, 0, 0, 0);

  assert.equal(style?.bl, 1); // bold
  assert.equal(style?.cl?.rgb?.toUpperCase(), "#FFFFFF");
  assert.equal(style?.bg?.rgb?.toUpperCase(), "#2E7D46");

  // Deduped: both cells reference the same style id.
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]];
  assert.equal(
    sheet?.cellData?.[0]?.[0]?.s,
    sheet?.cellData?.[0]?.[1]?.s,
  );
  assert.equal(typeof sheet?.cellData?.[0]?.[0]?.s, "string");
});

test("maps alignment and number format", async () => {
  const workbook = await roundTrip((wb) => {
    const ws = wb.addWorksheet("S");
    const cell = ws.getCell("A1");
    cell.value = 1234.5;
    cell.numFmt = "#,##0.00";
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  const snapshot = buildUniverWorkbookSnapshot(workbook);
  const style = cellStyle(snapshot, 0, 0, 0);

  assert.equal(style?.ht, 2); // center
  assert.equal(style?.vt, 2); // middle
  assert.equal(style?.n?.pattern, "#,##0.00");
});

test("captures merged ranges as zero-based IRange", async () => {
  const workbook = await roundTrip((wb) => {
    const ws = wb.addWorksheet("S");
    ws.getCell("A1").value = "Title";
    ws.mergeCells("A1:C1");
  });

  const snapshot = buildUniverWorkbookSnapshot(workbook);
  const merges = snapshot.sheets[snapshot.sheetOrder[0]]?.mergeData;

  assert.deepEqual(merges, [
    { startRow: 0, startColumn: 0, endRow: 0, endColumn: 2 },
  ]);
});

test("preserves formulas with their cached result", async () => {
  const workbook = await roundTrip((wb) => {
    const ws = wb.addWorksheet("S");
    ws.getCell("A1").value = 2;
    ws.getCell("A2").value = 3;
    ws.getCell("A3").value = { formula: "A1+A2", result: 5 };
  });

  const snapshot = buildUniverWorkbookSnapshot(workbook);
  const cell = snapshot.sheets[snapshot.sheetOrder[0]]?.cellData?.[2]?.[0];

  assert.equal(cell?.f, "=A1+A2");
  assert.equal(cell?.v, 5);
});

test("maps column widths, row heights, and frozen panes", async () => {
  const workbook = await roundTrip((wb) => {
    const ws = wb.addWorksheet("S");
    ws.getColumn(1).width = 20;
    ws.getRow(1).height = 30;
    ws.getCell("A1").value = "x";
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];
  });

  const snapshot = buildUniverWorkbookSnapshot(workbook);
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]];

  assert.ok((sheet?.columnData?.[0]?.w ?? 0) > 0);
  assert.ok((sheet?.rowData?.[0]?.h ?? 0) > 0);
  assert.equal(sheet?.freeze?.ySplit, 1);
  assert.equal(sheet?.freeze?.xSplit, 0);
});

test("pads the grid beyond the data extent", async () => {
  const workbook = await roundTrip((wb) => {
    const ws = wb.addWorksheet("S");
    ws.getCell("A1").value = "only";
  });

  const snapshot = buildUniverWorkbookSnapshot(workbook);
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]];

  assert.ok((sheet?.rowCount ?? 0) >= 20);
  assert.ok((sheet?.columnCount ?? 0) >= 10);
});
