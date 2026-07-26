import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import type { IWorkbookData } from "@univerjs/core";

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

// Full round-trip: build source workbook -> snapshot (baseline) -> mutate a
// clone of the snapshot as the user's edits -> apply the diff to a fresh load
// of the original -> serialize + reload and inspect.
async function applyEdits(
  build: (workbook: ExcelJSWorkbook) => void,
  edit: (edited: IWorkbookData) => void,
): Promise<ExcelJSWorkbook> {
  const source = new ExcelJS.Workbook();
  build(source);
  const originalBuffer = await serialize(source);

  const baselineWorkbook = await load(originalBuffer);
  const baseline = buildUniverWorkbookSnapshot(baselineWorkbook);
  const edited = structuredClone(baseline);
  edit(edited);

  const target = await load(originalBuffer);
  applyUniverEditsToWorkbook(target, baseline, edited);
  return load(await serialize(target));
}

function setCell(
  snapshot: IWorkbookData,
  sheetIndex: number,
  row: number,
  column: number,
  cell: { v?: string | number | boolean; f?: string } | null,
) {
  const sheetId = snapshot.sheetOrder[sheetIndex];
  const sheet = snapshot.sheets[sheetId];
  sheet.cellData ??= {};
  const matrix = sheet.cellData as Record<
    number,
    Record<number, unknown>
  >;
  matrix[row] ??= {};
  if (cell === null) {
    matrix[row][column] = {};
  } else {
    matrix[row][column] = cell;
  }
}

test("writes a changed cell value", async () => {
  const workbook = await applyEdits(
    (wb) => {
      const ws = wb.addWorksheet("S");
      ws.getCell("A1").value = "Acme";
    },
    (edited) => setCell(edited, 0, 0, 0, { v: "Globex" }),
  );

  assert.equal(workbook.getWorksheet("S")?.getCell("A1").value, "Globex");
});

test("leaves untouched cells and their styles intact", async () => {
  const workbook = await applyEdits(
    (wb) => {
      const ws = wb.addWorksheet("S");
      const header = ws.getCell("A1");
      header.value = "Name";
      header.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2E7D46" },
      };
      ws.getCell("A2").value = "Acme";
    },
    (edited) => setCell(edited, 0, 1, 0, { v: "Globex" }),
  );

  const ws = workbook.getWorksheet("S");
  assert.equal(ws?.getCell("A1").value, "Name");
  const fill = ws?.getCell("A1").fill as ExcelJS.FillPattern;
  assert.equal(fill?.fgColor?.argb, "FF2E7D46");
  assert.equal(ws?.getCell("A2").value, "Globex");
});

test("updates a formula and keeps it a formula", async () => {
  const workbook = await applyEdits(
    (wb) => {
      const ws = wb.addWorksheet("S");
      ws.getCell("A1").value = 2;
      ws.getCell("A2").value = 3;
      ws.getCell("A3").value = { formula: "A1+A2", result: 5 };
    },
    (edited) => setCell(edited, 0, 2, 0, { f: "=A1*A2", v: 6 }),
  );

  const cell = workbook.getWorksheet("S")?.getCell("A3");
  assert.equal((cell?.value as ExcelJS.CellFormulaValue)?.formula, "A1*A2");
});

test("writes appended rows beyond the original extent", async () => {
  const workbook = await applyEdits(
    (wb) => {
      const ws = wb.addWorksheet("S");
      ws.getCell("A1").value = "Name";
      ws.getCell("A2").value = "Acme";
    },
    (edited) => setCell(edited, 0, 2, 0, { v: "Initech" }),
  );

  assert.equal(workbook.getWorksheet("S")?.getCell("A3").value, "Initech");
});

test("clears an emptied cell", async () => {
  const workbook = await applyEdits(
    (wb) => {
      const ws = wb.addWorksheet("S");
      ws.getCell("A1").value = "remove me";
    },
    (edited) => setCell(edited, 0, 0, 0, null),
  );

  const value = workbook.getWorksheet("S")?.getCell("A1").value;
  assert.ok(value === null || value === undefined);
});

test("does not rewrite an untouched date cell (lossy text representation)", async () => {
  const when = new Date(Date.UTC(2026, 0, 15));
  const workbook = await applyEdits(
    (wb) => {
      const ws = wb.addWorksheet("S");
      const cell = ws.getCell("A1");
      cell.value = when;
      cell.numFmt = "yyyy-mm-dd";
      ws.getCell("B1").value = "keep";
      // Edit an unrelated cell only.
    },
    (edited) => setCell(edited, 0, 0, 1, { v: "changed" }),
  );

  const dateCell = workbook.getWorksheet("S")?.getCell("A1");
  assert.ok(dateCell?.value instanceof Date, "date cell should stay a Date");
  assert.equal(
    (dateCell?.value as Date).getTime(),
    when.getTime(),
  );
});
