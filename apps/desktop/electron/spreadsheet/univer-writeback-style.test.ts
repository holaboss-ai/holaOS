import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import type { IStyleData, IWorkbookData } from "@univerjs/core";

import { buildUniverWorkbookSnapshot } from "./univer-snapshot.js";
import { applyUniverEditsToWorkbook } from "./univer-writeback.js";

type ExcelJSWorkbook = ExcelJS.Workbook;

async function serialize(workbook: ExcelJSWorkbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function load(buffer: Buffer): Promise<ExcelJSWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

async function applyEdits(
  build: (workbook: ExcelJSWorkbook) => void,
  edit: (edited: IWorkbookData) => void,
): Promise<ExcelJSWorkbook> {
  const source = new ExcelJS.Workbook();
  build(source);
  const originalBuffer = await serialize(source);

  const baseline = buildUniverWorkbookSnapshot(await load(originalBuffer));
  const edited = structuredClone(baseline);
  edit(edited);

  const target = await load(originalBuffer);
  applyUniverEditsToWorkbook(target, baseline, edited);
  return load(await serialize(target));
}

// Overwrite a cell's inline style in the edited snapshot (registry ref ignored).
function setStyle(
  snapshot: IWorkbookData,
  sheetIndex: number,
  row: number,
  column: number,
  style: IStyleData,
) {
  const sheet = snapshot.sheets[snapshot.sheetOrder[sheetIndex]];
  sheet.cellData ??= {};
  const matrix = sheet.cellData as Record<number, Record<number, unknown>>;
  matrix[row] ??= {};
  const existing = (matrix[row][column] ?? {}) as Record<string, unknown>;
  matrix[row][column] = { ...existing, s: style };
}

test("persists bold applied to a previously plain cell", async () => {
  const workbook = await applyEdits(
    (wb) => {
      wb.addWorksheet("S").getCell("A1").value = "Name";
    },
    (edited) => setStyle(edited, 0, 0, 0, { bl: 1 }),
  );

  assert.equal(workbook.getWorksheet("S")?.getCell("A1").font?.bold, true);
});

test("persists a background fill change", async () => {
  const workbook = await applyEdits(
    (wb) => {
      wb.addWorksheet("S").getCell("A1").value = "Name";
    },
    (edited) => setStyle(edited, 0, 0, 0, { bg: { rgb: "#2E7D46" } }),
  );

  const fill = workbook.getWorksheet("S")?.getCell("A1")
    .fill as ExcelJS.FillPattern;
  assert.equal(fill?.fgColor?.argb, "FF2E7D46");
});

test("persists a font color change", async () => {
  const workbook = await applyEdits(
    (wb) => {
      wb.addWorksheet("S").getCell("A1").value = "Name";
    },
    (edited) => setStyle(edited, 0, 0, 0, { cl: { rgb: "#FF0000" } }),
  );

  assert.equal(
    workbook.getWorksheet("S")?.getCell("A1").font?.color?.argb,
    "FFFF0000",
  );
});

test("persists a number format change", async () => {
  const workbook = await applyEdits(
    (wb) => {
      wb.addWorksheet("S").getCell("A1").value = 1234.5;
    },
    (edited) => setStyle(edited, 0, 0, 0, { n: { pattern: "#,##0.00" } }),
  );

  assert.equal(workbook.getWorksheet("S")?.getCell("A1").numFmt, "#,##0.00");
});

test("persists a horizontal alignment change", async () => {
  const workbook = await applyEdits(
    (wb) => {
      wb.addWorksheet("S").getCell("A1").value = "Name";
    },
    (edited) => setStyle(edited, 0, 0, 0, { ht: 2 }),
  );

  assert.equal(
    workbook.getWorksheet("S")?.getCell("A1").alignment?.horizontal,
    "center",
  );
});

test("adds a new merge", async () => {
  const workbook = await applyEdits(
    (wb) => {
      wb.addWorksheet("S").getCell("A1").value = "Title";
    },
    (edited) => {
      edited.sheets[edited.sheetOrder[0]].mergeData = [
        { startRow: 0, startColumn: 0, endRow: 0, endColumn: 2 },
      ];
    },
  );

  assert.equal(workbook.getWorksheet("S")?.getCell("C1").isMerged, true);
});

test("removes an existing merge", async () => {
  const workbook = await applyEdits(
    (wb) => {
      const ws = wb.addWorksheet("S");
      ws.getCell("A1").value = "Title";
      ws.mergeCells("A1:C1");
    },
    (edited) => {
      edited.sheets[edited.sheetOrder[0]].mergeData = [];
    },
  );

  assert.equal(workbook.getWorksheet("S")?.getCell("A1").isMerged, false);
});

test("a style-only edit does not rewrite the cell value (date preserved)", async () => {
  const when = new Date(Date.UTC(2026, 0, 15));
  const workbook = await applyEdits(
    (wb) => {
      const cell = wb.addWorksheet("S").getCell("A1");
      cell.value = when;
      cell.numFmt = "yyyy-mm-dd";
    },
    (edited) => setStyle(edited, 0, 0, 0, { bl: 1, n: { pattern: "yyyy-mm-dd" } }),
  );

  const cell = workbook.getWorksheet("S")?.getCell("A1");
  assert.ok(cell?.value instanceof Date, "date value should be preserved");
  assert.equal(cell?.font?.bold, true);
});
