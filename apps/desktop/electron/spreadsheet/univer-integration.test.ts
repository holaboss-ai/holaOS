import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import type { IWorkbookData } from "@univerjs/core";

import { buildUniverWorkbookSnapshot } from "./univer-snapshot.js";
import { applyUniverEditsToWorkbook } from "./univer-writeback.js";

type ExcelJSWorkbook = ExcelJS.Workbook;

// A CRM-style sheet like the user's: Chinese headers, a filled/bold banded
// header row, a merged title, a currency-formatted column, a formula total,
// and enough rows to look real.
function buildCrmWorkbook(workbook: ExcelJSWorkbook) {
  const ws = workbook.addWorksheet("客户数据");
  ws.mergeCells("A1:D1");
  ws.getCell("A1").value = "小型公司 CRM 销售客户 mock 数据";

  const headers = ["客户编号", "公司名称", "客户类型", "年度金额"];
  headers.forEach((header, index) => {
    const cell = ws.getCell(2, index + 1);
    cell.value = header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2E7D46" },
    };
  });

  for (let i = 0; i < 20; i += 1) {
    const row = i + 3;
    ws.getCell(row, 1).value = `CUST-${String(i + 1).padStart(4, "0")}`;
    ws.getCell(row, 2).value = `星河数科科技有限公司 ${i + 1}`;
    ws.getCell(row, 3).value = i % 2 === 0 ? "潜在客户" : "成交客户";
    const amount = ws.getCell(row, 4);
    amount.value = (i + 1) * 1000;
    amount.numFmt = "¥#,##0.00";
  }

  const totalRow = 23;
  ws.getCell(totalRow, 3).value = "合计";
  ws.getCell(totalRow, 4).value = { formula: "SUM(D3:D22)", result: 210000 };
}

async function roundTrip(): Promise<{
  snapshot: IWorkbookData;
  originalBuffer: Buffer;
}> {
  const source = new ExcelJS.Workbook();
  buildCrmWorkbook(source);
  const originalBuffer = Buffer.from(await source.xlsx.writeBuffer());
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(originalBuffer as unknown as ArrayBuffer);
  return { snapshot: buildUniverWorkbookSnapshot(reloaded), originalBuffer };
}

test("preserves CRM sheet fidelity in the snapshot", async () => {
  const { snapshot } = await roundTrip();
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]];

  assert.equal(sheet?.name, "客户数据");
  // Merged title.
  assert.deepEqual(sheet?.mergeData, [
    { startRow: 0, startColumn: 0, endRow: 0, endColumn: 3 },
  ]);
  // Chinese header text.
  assert.equal(sheet?.cellData?.[1]?.[0]?.v, "客户编号");
  // Header styling deduped and captured.
  const headerStyleId = sheet?.cellData?.[1]?.[0]?.s;
  assert.equal(typeof headerStyleId, "string");
  const headerStyle = snapshot.styles[headerStyleId as string];
  assert.equal(headerStyle?.bl, 1);
  assert.equal(headerStyle?.bg?.rgb?.toUpperCase(), "#2E7D46");
  // Currency number format on the amount column.
  const amountStyleId = sheet?.cellData?.[2]?.[3]?.s;
  const amountStyle = snapshot.styles[amountStyleId as string];
  assert.equal(amountStyle?.n?.pattern, "¥#,##0.00");
  // Formula total with cached result.
  assert.equal(sheet?.cellData?.[22]?.[3]?.f, "=SUM(D3:D22)");
  assert.equal(sheet?.cellData?.[22]?.[3]?.v, 210000);
});

test("edits round-trip while preserving untouched formatting", async () => {
  const { snapshot, originalBuffer } = await roundTrip();
  const edited = structuredClone(snapshot);
  const sheet = edited.sheets[edited.sheetOrder[0]];
  const matrix = sheet.cellData as Record<number, Record<number, unknown>>;
  // Rename a company (value edit) and recolor a data cell (style edit).
  matrix[2][1] = { v: "蓝杉智造贸易有限公司", t: 1 };
  matrix[3][2] = { v: "意向客户", t: 1, s: { bg: { rgb: "#FFF3CD" } } };

  const target = new ExcelJS.Workbook();
  await target.xlsx.load(originalBuffer as unknown as ArrayBuffer);
  applyUniverEditsToWorkbook(target, snapshot, edited);
  const out = Buffer.from(await target.xlsx.writeBuffer());
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(out as unknown as ArrayBuffer);
  const ws = reloaded.getWorksheet("客户数据");

  // Edited value applied.
  assert.equal(ws?.getCell("B3").value, "蓝杉智造贸易有限公司");
  // Edited style applied.
  const recolored = ws?.getCell("C4").fill as ExcelJS.FillPattern;
  assert.equal(recolored?.fgColor?.argb, "FFFFF3CD");
  // Untouched header keeps its fill.
  const header = ws?.getCell("A2").fill as ExcelJS.FillPattern;
  assert.equal(header?.fgColor?.argb, "FF2E7D46");
  // Untouched formula stays a formula.
  assert.equal(
    (ws?.getCell("D23").value as ExcelJS.CellFormulaValue)?.formula,
    "SUM(D3:D22)",
  );
  // Untouched currency format survives.
  assert.equal(ws?.getCell("D3").numFmt, "¥#,##0.00");
});
