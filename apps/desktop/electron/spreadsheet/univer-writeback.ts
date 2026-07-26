import type ExcelJSNamespace from "exceljs";
import type {
  IBorderData,
  ICellData,
  IRange,
  IStyleData,
  IWorkbookData,
  IWorksheetData,
} from "@univerjs/core";

type ExcelJSWorkbook = ExcelJSNamespace.Workbook;
type ExcelJSWorksheet = ExcelJSNamespace.Worksheet;
type ExcelJSCell = ExcelJSNamespace.Cell;
type ExcelJSStyleRecord = Record<string, IStyleData | null>;

const H_ALIGN_REVERSE: Record<number, string> = {
  1: "left",
  2: "center",
  3: "right",
  4: "justify",
  5: "fill",
  6: "distributed",
};
const V_ALIGN_REVERSE: Record<number, string> = {
  1: "top",
  2: "middle",
  3: "bottom",
};
const WRAP_STRATEGY_WRAP = 3;
const BORDER_STYLE_REVERSE: Record<number, string> = {
  1: "thin",
  2: "hair",
  3: "dotted",
  4: "dashed",
  5: "dashDot",
  6: "dashDotDot",
  7: "double",
  8: "medium",
  9: "mediumDashed",
  10: "mediumDashDot",
  11: "mediumDashDotDot",
  12: "slantDashDot",
  13: "thick",
};

// Apply the cells and merges the user changed onto the original ExcelJS
// workbook. Value and style are diffed independently: a value edit never
// rewrites style, and a style edit never rewrites the value — that separation
// is what keeps lossy value representations (dates rendered as text) intact
// when only formatting changed.
export function applyUniverEditsToWorkbook(
  workbook: ExcelJSWorkbook,
  baseline: IWorkbookData,
  edited: IWorkbookData,
): void {
  edited.sheetOrder.forEach((sheetId, sheetIndex) => {
    const worksheet = workbook.worksheets[sheetIndex];
    if (!worksheet) {
      return;
    }
    const editedSheet = edited.sheets[sheetId];
    const baselineSheet =
      baseline.sheets[baseline.sheetOrder[sheetIndex] ?? ""];
    applySheetCellEdits(
      worksheet,
      baselineSheet,
      editedSheet,
      baseline.styles as ExcelJSStyleRecord,
      edited.styles as ExcelJSStyleRecord,
    );
    applyMergeEdits(
      worksheet,
      baselineSheet?.mergeData ?? [],
      editedSheet?.mergeData ?? [],
    );
  });
}

type CellMatrix = Record<number, Record<number, ICellData | undefined>>;

function applySheetCellEdits(
  worksheet: ExcelJSWorksheet,
  baselineSheet: Partial<IWorksheetData> | undefined,
  editedSheet: Partial<IWorksheetData> | undefined,
  baselineStyles: ExcelJSStyleRecord,
  editedStyles: ExcelJSStyleRecord,
): void {
  const baselineCells = (baselineSheet?.cellData ?? {}) as CellMatrix;
  const editedCells = (editedSheet?.cellData ?? {}) as CellMatrix;

  const rows = unionKeys(baselineCells, editedCells);
  for (const row of rows) {
    const columns = unionKeys(baselineCells[row] ?? {}, editedCells[row] ?? {});
    for (const column of columns) {
      const baseCell = baselineCells[row]?.[column];
      const editedCell = editedCells[row]?.[column];

      const valueChanged =
        valueSignature(baseCell) !== valueSignature(editedCell);
      const baseStyle = resolveStyle(baseCell, baselineStyles);
      const editedStyle = resolveStyle(editedCell, editedStyles);
      const styleChanged =
        stableStringify(baseStyle) !== stableStringify(editedStyle);

      if (!valueChanged && !styleChanged) {
        continue;
      }
      const cell = worksheet.getCell(row + 1, column + 1);
      if (valueChanged) {
        applyCellValue(cell, editedCell);
      }
      if (styleChanged) {
        applyCellStyle(cell, editedStyle);
      }
    }
  }
}

function unionKeys(
  a: Record<number, unknown>,
  b: Record<number, unknown>,
): number[] {
  return [
    ...new Set<number>([
      ...Object.keys(a).map(Number),
      ...Object.keys(b).map(Number),
    ]),
  ];
}

function resolveStyle(
  cell: ICellData | undefined,
  styles: ExcelJSStyleRecord,
): IStyleData | undefined {
  const style = cell?.s;
  if (style === undefined || style === null) {
    return undefined;
  }
  if (typeof style === "string") {
    return styles[style] ?? undefined;
  }
  return style;
}

function valueSignature(cell: ICellData | undefined): string {
  if (!cell) {
    return "∅";
  }
  return JSON.stringify([cell.v ?? null, cell.f ?? null]);
}

function applyCellValue(cell: ExcelJSCell, editedCell: ICellData | undefined) {
  if (editedCell?.f) {
    cell.value = {
      formula: editedCell.f.replace(/^=/, ""),
      result: coerceFormulaResult(editedCell.v),
    };
    return;
  }
  const value = editedCell?.v;
  if (value === undefined || value === null || value === "") {
    cell.value = null;
    return;
  }
  cell.value = value;
}

function applyCellStyle(cell: ExcelJSCell, style: IStyleData | undefined) {
  const resolved = style ?? {};

  const font: Partial<ExcelJSNamespace.Font> = {};
  if (resolved.ff) {
    font.name = resolved.ff;
  }
  if (typeof resolved.fs === "number") {
    font.size = resolved.fs;
  }
  if (resolved.bl === 1) {
    font.bold = true;
  }
  if (resolved.it === 1) {
    font.italic = true;
  }
  if (resolved.ul?.s === 1) {
    font.underline = true;
  }
  if (resolved.st?.s === 1) {
    font.strike = true;
  }
  const fontColor = hexToArgb(resolved.cl?.rgb ?? undefined);
  if (fontColor) {
    font.color = { argb: fontColor };
  }
  cell.font = font;

  const backgroundColor = hexToArgb(resolved.bg?.rgb ?? undefined);
  cell.fill = backgroundColor
    ? {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: backgroundColor },
      }
    : { type: "pattern", pattern: "none" };

  const alignment: Partial<ExcelJSNamespace.Alignment> = {};
  const horizontal = resolved.ht ? H_ALIGN_REVERSE[resolved.ht] : undefined;
  if (horizontal) {
    alignment.horizontal =
      horizontal as ExcelJSNamespace.Alignment["horizontal"];
  }
  const vertical = resolved.vt ? V_ALIGN_REVERSE[resolved.vt] : undefined;
  if (vertical) {
    alignment.vertical = vertical as ExcelJSNamespace.Alignment["vertical"];
  }
  if (resolved.tb === WRAP_STRATEGY_WRAP) {
    alignment.wrapText = true;
  }
  if (resolved.tr?.a) {
    alignment.textRotation =
      resolved.tr.a as ExcelJSNamespace.Alignment["textRotation"];
  }
  cell.alignment = alignment;

  cell.numFmt = resolved.n?.pattern ?? "General";
  cell.border = buildBorder(resolved.bd ?? undefined);
}

function buildBorder(
  border: IBorderData | null | undefined,
): Partial<ExcelJSNamespace.Borders> {
  if (!border) {
    return {};
  }
  const result: Partial<ExcelJSNamespace.Borders> = {};
  const top = buildBorderEdge(border.t);
  const bottom = buildBorderEdge(border.b);
  const left = buildBorderEdge(border.l);
  const right = buildBorderEdge(border.r);
  if (top) {
    result.top = top;
  }
  if (bottom) {
    result.bottom = bottom;
  }
  if (left) {
    result.left = left;
  }
  if (right) {
    result.right = right;
  }
  return result;
}

function buildBorderEdge(
  edge: IBorderData["t"],
): Partial<ExcelJSNamespace.Border> | undefined {
  if (!edge) {
    return undefined;
  }
  const style = BORDER_STYLE_REVERSE[edge.s] ?? "thin";
  const argb = hexToArgb(edge.cl?.rgb ?? undefined) ?? "FF000000";
  return {
    style: style as ExcelJSNamespace.BorderStyle,
    color: { argb },
  };
}

function applyMergeEdits(
  worksheet: ExcelJSWorksheet,
  baselineMerges: IRange[],
  editedMerges: IRange[],
): void {
  const baselineKeys = new Set(baselineMerges.map(mergeKey));
  const editedKeys = new Set(editedMerges.map(mergeKey));

  for (const merge of baselineMerges) {
    if (!editedKeys.has(mergeKey(merge))) {
      worksheet.unMergeCells(rangeToA1(merge));
    }
  }
  for (const merge of editedMerges) {
    if (!baselineKeys.has(mergeKey(merge))) {
      worksheet.mergeCells(rangeToA1(merge));
    }
  }
}

function mergeKey(range: IRange): string {
  return `${range.startRow},${range.startColumn},${range.endRow},${range.endColumn}`;
}

function rangeToA1(range: IRange): string {
  return `${columnToLetters(range.startColumn)}${range.startRow + 1}:${columnToLetters(range.endColumn)}${range.endRow + 1}`;
}

function columnToLetters(column: number): string {
  let result = "";
  let index = column + 1;
  while (index > 0) {
    const remainder = (index - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    index = Math.floor((index - 1) / 26);
  }
  return result;
}

function coerceFormulaResult(
  value: ICellData["v"],
): string | number | boolean | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function hexToArgb(rgb: string | null | undefined): string | undefined {
  if (typeof rgb !== "string") {
    return undefined;
  }
  const normalized = rgb.trim().replace(/^#/, "");
  if (normalized.length === 6) {
    return `FF${normalized.toUpperCase()}`;
  }
  if (normalized.length === 8) {
    return normalized.toUpperCase();
  }
  return undefined;
}

// Order-insensitive comparison so a converter-built baseline style and a
// Univer-emitted edited style with identical content don't read as changed.
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
