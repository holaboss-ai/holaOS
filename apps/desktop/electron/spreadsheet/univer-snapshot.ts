import type ExcelJSNamespace from "exceljs";
import type {
  IBorderData,
  IBorderStyleData,
  ICellData,
  IColorStyle,
  IRange,
  IStyleData,
  IWorkbookData,
  IWorksheetData,
} from "@univerjs/core";

type ExcelJSWorkbook = ExcelJSNamespace.Workbook;
type ExcelJSWorksheet = ExcelJSNamespace.Worksheet;
type ExcelJSCell = ExcelJSNamespace.Cell;

// exceljs ValueType numeric enum, inlined so this module stays runtime-free
// (main.ts loads the exceljs runtime via nodeRequire). Values are stable.
const VALUE_TYPE = {
  Null: 0,
  Merge: 1,
  Number: 2,
  String: 3,
  Date: 4,
  Hyperlink: 5,
  Formula: 6,
  SharedString: 7,
  RichText: 8,
  Boolean: 9,
  Error: 10,
} as const;

// Univer enum values are inlined here so the Electron main bundle never pulls
// in the @univerjs/core runtime (browser-oriented, heavy). Values verified
// against @univerjs/core 0.25 — see the matching `import type` above.
const CELL_TYPE = { STRING: 1, NUMBER: 2, BOOLEAN: 3 } as const;
const BOOL_TRUE = 1;
const H_ALIGN: Record<string, number> = {
  left: 1,
  center: 2,
  right: 3,
  justify: 4,
  fill: 5,
  distributed: 6,
};
const V_ALIGN: Record<string, number> = { top: 1, middle: 2, bottom: 3 };
const WRAP_STRATEGY = { OVERFLOW: 1, CLIP: 2, WRAP: 3 } as const;
const BORDER_STYLE: Record<string, number> = {
  thin: 1,
  hair: 2,
  dotted: 3,
  dashed: 4,
  dashDot: 5,
  dashDotDot: 6,
  double: 7,
  medium: 8,
  mediumDashed: 9,
  mediumDashDot: 10,
  mediumDashDotDot: 11,
  slantDashDot: 12,
  thick: 13,
};
const LOCALE_ZH_CN = "zhCN";
const SNAPSHOT_APP_VERSION = "0.25.1";

// Legacy Excel indexed color palette (ECMA-376 §18.8.27). Indices 64/65 are
// system fore/background ("automatic") and are intentionally omitted so they
// fall through to the default.
const INDEXED_PALETTE: Record<number, string> = {
  0: "#000000", 1: "#FFFFFF", 2: "#FF0000", 3: "#00FF00", 4: "#0000FF",
  5: "#FFFF00", 6: "#FF00FF", 7: "#00FFFF", 8: "#000000", 9: "#FFFFFF",
  10: "#FF0000", 11: "#00FF00", 12: "#0000FF", 13: "#FFFF00", 14: "#FF00FF",
  15: "#00FFFF", 16: "#800000", 17: "#008000", 18: "#000080", 19: "#808000",
  20: "#800080", 21: "#008080", 22: "#C0C0C0", 23: "#808080", 24: "#9999FF",
  25: "#993366", 26: "#FFFFCC", 27: "#CCFFFF", 28: "#660066", 29: "#FF8080",
  30: "#0066CC", 31: "#CCCCFF", 32: "#000080", 33: "#FF00FF", 34: "#FFFF00",
  35: "#00FFFF", 36: "#800080", 37: "#800000", 38: "#008080", 39: "#0000FF",
  40: "#00CCFF", 41: "#CCFFFF", 42: "#CCFFCC", 43: "#FFFF99", 44: "#99CCFF",
  45: "#FF99CC", 46: "#CC99FF", 47: "#FFCC99", 48: "#3366FF", 49: "#33CCCC",
  50: "#99CC00", 51: "#FFCC00", 52: "#FF9900", 53: "#FF6600", 54: "#666699",
  55: "#969696", 56: "#003366", 57: "#339966", 58: "#003300", 59: "#333300",
  60: "#993300", 61: "#993366", 62: "#333399", 63: "#333333",
};

// Resolved theme color scheme, indexed by the numeric `theme` attribute Excel
// writes into cell styles (0=lt1, 1=dk1, 2=lt2, 3=dk2, 4..9=accent1..6,
// 10=hlink, 11=folHlink) — the first two pairs are swapped relative to the
// clrScheme XML order.
type ThemePalette = string[];

interface ColorContext {
  themePalette: ThemePalette;
}

const DEFAULT_COLUMN_WIDTH = 88;
const DEFAULT_ROW_HEIGHT = 24;
const GRID_ROW_PADDING = 12;
const GRID_COLUMN_PADDING = 4;
const MIN_GRID_ROWS = 50;
const MIN_GRID_COLUMNS = 20;

export interface BuildUniverSnapshotOptions {
  id?: string;
  name?: string;
  locale?: string;
  maxSheets?: number;
  maxRows?: number;
  maxColumns?: number;
}

const DEFAULTS = {
  maxSheets: 64,
  maxRows: 20_000,
  maxColumns: 512,
};

export function buildUniverWorkbookSnapshot(
  workbook: ExcelJSWorkbook,
  options: BuildUniverSnapshotOptions = {},
): IWorkbookData {
  const maxSheets = options.maxSheets ?? DEFAULTS.maxSheets;
  const maxRows = options.maxRows ?? DEFAULTS.maxRows;
  const maxColumns = options.maxColumns ?? DEFAULTS.maxColumns;

  const styleRegistry = new StyleRegistry();
  const worksheets = workbook.worksheets.slice(0, maxSheets);
  const themeXml = (
    workbook as unknown as { model?: { themes?: Record<string, string> } }
  ).model?.themes?.theme1;
  const colorContext: ColorContext = {
    themePalette: buildThemePalette(themeXml),
  };

  const sheetOrder: string[] = [];
  const sheets: Record<string, Partial<IWorksheetData>> = {};

  worksheets.forEach((worksheet, index) => {
    const sheetId = `sheet-${index}`;
    sheetOrder.push(sheetId);
    sheets[sheetId] = buildWorksheet(
      worksheet,
      sheetId,
      styleRegistry,
      maxRows,
      maxColumns,
      colorContext,
    );
  });

  return {
    id: options.id ?? "univer-preview",
    name: options.name ?? workbook.title ?? "Workbook",
    appVersion: SNAPSHOT_APP_VERSION,
    locale: (options.locale ?? LOCALE_ZH_CN) as IWorkbookData["locale"],
    styles: styleRegistry.toRecord(),
    sheetOrder,
    sheets,
  };
}

class StyleRegistry {
  private readonly byKey = new Map<string, string>();
  private readonly styles: Record<string, IStyleData> = {};
  private counter = 0;

  intern(style: IStyleData | undefined): string | undefined {
    if (!style || Object.keys(style).length === 0) {
      return undefined;
    }
    const key = JSON.stringify(style);
    const existing = this.byKey.get(key);
    if (existing) {
      return existing;
    }
    this.counter += 1;
    const id = `s${this.counter}`;
    this.byKey.set(key, id);
    this.styles[id] = style;
    return id;
  }

  toRecord(): Record<string, IStyleData> {
    return this.styles;
  }
}

function buildWorksheet(
  worksheet: ExcelJSWorksheet,
  sheetId: string,
  styleRegistry: StyleRegistry,
  maxRows: number,
  maxColumns: number,
  colorContext: ColorContext,
): Partial<IWorksheetData> {
  const cellData: Record<number, Record<number, ICellData>> = {};
  let maxRowIndex = 0;
  let maxColumnIndex = 0;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > maxRows) {
      return;
    }
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (columnNumber > maxColumns) {
        return;
      }
      const converted = convertCell(cell, styleRegistry, colorContext);
      if (!converted) {
        return;
      }
      const r = rowNumber - 1;
      const c = columnNumber - 1;
      (cellData[r] ??= {})[c] = converted;
      maxRowIndex = Math.max(maxRowIndex, r);
      maxColumnIndex = Math.max(maxColumnIndex, c);
    });
  });

  const dataRowCount = Math.max(maxRowIndex + 1, worksheet.rowCount);
  const dataColumnCount = Math.max(maxColumnIndex + 1, worksheet.columnCount);

  return {
    id: sheetId,
    name: worksheet.name,
    rowCount: Math.min(
      Math.max(dataRowCount + GRID_ROW_PADDING, MIN_GRID_ROWS),
      maxRows,
    ),
    columnCount: Math.min(
      Math.max(dataColumnCount + GRID_COLUMN_PADDING, MIN_GRID_COLUMNS),
      maxColumns,
    ),
    defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
    cellData,
    columnData: buildColumnData(worksheet, dataColumnCount),
    rowData: buildRowData(worksheet, dataRowCount),
    mergeData: buildMergeData(worksheet),
    freeze: buildFreeze(worksheet),
  };
}

function convertCell(
  cell: ExcelJSCell,
  styleRegistry: StyleRegistry,
  ctx: ColorContext,
): ICellData | undefined {
  const value = readCellValue(cell);
  const style = styleRegistry.intern(readCellStyle(cell, value.isDate, ctx));

  if (value.v === undefined && value.f === undefined && style === undefined) {
    return undefined;
  }

  const cellData: ICellData = {};
  if (value.v !== undefined) {
    cellData.v = value.v;
    cellData.t = value.t;
  }
  if (value.f !== undefined) {
    cellData.f = value.f;
  }
  if (style !== undefined) {
    cellData.s = style;
  }
  return cellData;
}

interface CellValue {
  v?: string | number | boolean;
  t?: number;
  f?: string;
  isDate: boolean;
}

function readCellValue(cell: ExcelJSCell): CellValue {
  switch (cell.type) {
    case VALUE_TYPE.Number:
      return { v: cell.value as number, t: CELL_TYPE.NUMBER, isDate: false };
    case VALUE_TYPE.Boolean:
      return { v: cell.value as boolean, t: CELL_TYPE.BOOLEAN, isDate: false };
    case VALUE_TYPE.Date:
      // Dates render as their formatted display text (Phase 1). Suppresses the
      // number format so Univer doesn't re-format a string.
      return { v: cell.text ?? "", t: CELL_TYPE.STRING, isDate: true };
    case VALUE_TYPE.Formula: {
      const formula = cell.formula ? `=${cell.formula}` : undefined;
      const result = readFormulaResult(cell.result);
      return { ...result, f: formula, isDate: false };
    }
    case VALUE_TYPE.Hyperlink: {
      const hyperlinkValue = cell.value as { text?: unknown } | null;
      const text =
        hyperlinkValue && typeof hyperlinkValue.text === "string"
          ? hyperlinkValue.text
          : (cell.text ?? "");
      return { v: text, t: CELL_TYPE.STRING, isDate: false };
    }
    case VALUE_TYPE.RichText:
      return { v: cell.text ?? "", t: CELL_TYPE.STRING, isDate: false };
    case VALUE_TYPE.Error:
      return { v: cell.text ?? "#ERROR", t: CELL_TYPE.STRING, isDate: false };
    case VALUE_TYPE.String:
    case VALUE_TYPE.SharedString:
      return { v: cell.value as string, t: CELL_TYPE.STRING, isDate: false };
    default:
      return { isDate: false };
  }
}

function readFormulaResult(result: unknown): {
  v?: string | number | boolean;
  t?: number;
} {
  if (result === null || result === undefined) {
    return {};
  }
  if (typeof result === "number") {
    return { v: result, t: CELL_TYPE.NUMBER };
  }
  if (typeof result === "boolean") {
    return { v: result, t: CELL_TYPE.BOOLEAN };
  }
  if (typeof result === "string") {
    return { v: result, t: CELL_TYPE.STRING };
  }
  if (result instanceof Date) {
    return { v: result.toISOString(), t: CELL_TYPE.STRING };
  }
  if (typeof result === "object" && "error" in result) {
    return {
      v: String((result as { error: unknown }).error),
      t: CELL_TYPE.STRING,
    };
  }
  return {};
}

function readCellStyle(
  cell: ExcelJSCell,
  isDate: boolean,
  ctx: ColorContext,
): IStyleData | undefined {
  const style: IStyleData = {};

  const font = cell.font;
  if (font) {
    if (font.name) {
      style.ff = font.name;
    }
    if (typeof font.size === "number") {
      style.fs = font.size;
    }
    if (font.bold) {
      style.bl = BOOL_TRUE;
    }
    if (font.italic) {
      style.it = BOOL_TRUE;
    }
    if (font.underline) {
      style.ul = { s: BOOL_TRUE };
    }
    if (font.strike) {
      style.st = { s: BOOL_TRUE };
    }
    const fontColor = convertColor(font.color, ctx);
    if (fontColor) {
      style.cl = fontColor;
    }
  }

  const fillColor = readFillColor(cell.fill, ctx);
  if (fillColor) {
    style.bg = fillColor;
  }

  const alignment = cell.alignment;
  if (alignment) {
    const horizontal = alignment.horizontal
      ? H_ALIGN[alignment.horizontal]
      : undefined;
    if (horizontal) {
      style.ht = horizontal;
    }
    const vertical = alignment.vertical
      ? V_ALIGN[alignment.vertical]
      : undefined;
    if (vertical) {
      style.vt = vertical;
    }
    if (alignment.wrapText) {
      style.tb = WRAP_STRATEGY.WRAP;
    }
    if (typeof alignment.textRotation === "number" && alignment.textRotation) {
      style.tr = { a: alignment.textRotation };
    }
  }

  const border = convertBorder(cell.border, ctx);
  if (border) {
    style.bd = border;
  }

  if (!isDate && cell.numFmt && cell.numFmt !== "General") {
    style.n = { pattern: cell.numFmt };
  }

  return Object.keys(style).length > 0 ? style : undefined;
}

type ExcelColor = Partial<{
  argb: string;
  theme: number;
  tint: number;
  indexed: number;
}>;

function convertColor(
  color: ExcelColor | undefined,
  ctx: ColorContext,
): IColorStyle | undefined {
  if (!color) {
    return undefined;
  }
  if (typeof color.argb === "string") {
    const rgb = argbToHex(color.argb);
    return rgb ? { rgb } : undefined;
  }
  if (typeof color.theme === "number") {
    const base = ctx.themePalette[color.theme];
    if (!base) {
      return undefined;
    }
    return { rgb: applyTint(base, color.tint ?? 0) };
  }
  if (typeof color.indexed === "number") {
    const rgb = INDEXED_PALETTE[color.indexed];
    return rgb ? { rgb } : undefined;
  }
  return undefined;
}

function readFillColor(
  fill: ExcelJSCell["fill"],
  ctx: ColorContext,
): IColorStyle | undefined {
  if (!fill || fill.type !== "pattern" || fill.pattern === "none") {
    return undefined;
  }
  return convertColor(fill.fgColor, ctx);
}

function argbToHex(argb: string): string | undefined {
  const normalized = argb.trim().replace(/^#/, "");
  if (normalized.length === 8) {
    return `#${normalized.slice(2).toUpperCase()}`;
  }
  if (normalized.length === 6) {
    return `#${normalized.toUpperCase()}`;
  }
  return undefined;
}

// Parse `xl/theme/theme1.xml` (exposed by exceljs as workbook.model.themes)
// into the theme palette, applying the lt1/dk1 + lt2/dk2 swap so numeric theme
// indices resolve the way Excel writes them.
function buildThemePalette(themeXml: string | undefined): ThemePalette {
  if (!themeXml) {
    return [];
  }
  const scheme = themeXml.match(/<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/)?.[0];
  if (!scheme) {
    return [];
  }
  const read = (name: string): string | undefined => {
    const node = scheme.match(
      new RegExp(`<a:${name}\\b[\\s\\S]*?</a:${name}>`),
    )?.[0];
    if (!node) {
      return undefined;
    }
    const srgb = node.match(/<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/)?.[1];
    if (srgb) {
      return `#${srgb.toUpperCase()}`;
    }
    const sys = node.match(/<a:sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/)?.[1];
    return sys ? `#${sys.toUpperCase()}` : undefined;
  };
  const dk1 = read("dk1") ?? "#000000";
  const lt1 = read("lt1") ?? "#FFFFFF";
  const dk2 = read("dk2") ?? "#000000";
  const lt2 = read("lt2") ?? "#FFFFFF";
  return [
    lt1, // 0
    dk1, // 1
    lt2, // 2
    dk2, // 3
    read("accent1") ?? "#000000",
    read("accent2") ?? "#000000",
    read("accent3") ?? "#000000",
    read("accent4") ?? "#000000",
    read("accent5") ?? "#000000",
    read("accent6") ?? "#000000",
    read("hlink") ?? "#0000FF",
    read("folHlink") ?? "#800080",
  ];
}

// Apply an OOXML tint to a "#RRGGBB" base by shifting HSL luminance:
// tint<0 darkens toward black, tint>0 lightens toward white.
function applyTint(hex: string, tint: number): string {
  if (!tint) {
    return hex;
  }
  const value = hex.replace(/^#/, "");
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) {
      h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) {
      tt += 1;
    }
    if (tt > 1) {
      tt -= 1;
    }
    if (tt < 1 / 6) {
      return p + (q - p) * 6 * tt;
    }
    if (tt < 1 / 2) {
      return q;
    }
    if (tt < 2 / 3) {
      return p + (q - p) * (2 / 3 - tt) * 6;
    }
    return p;
  };
  let nr = l;
  let ng = l;
  let nb = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    nr = hue(p, q, h + 1 / 3);
    ng = hue(p, q, h);
    nb = hue(p, q, h - 1 / 3);
  }
  const toHex = (n: number) =>
    Math.round(Math.max(0, Math.min(1, n)) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

function convertBorder(
  border: ExcelJSCell["border"],
  ctx: ColorContext,
): IBorderData | undefined {
  if (!border) {
    return undefined;
  }
  const result: IBorderData = {};
  const top = convertBorderEdge(border.top, ctx);
  const bottom = convertBorderEdge(border.bottom, ctx);
  const left = convertBorderEdge(border.left, ctx);
  const right = convertBorderEdge(border.right, ctx);
  if (top) {
    result.t = top;
  }
  if (bottom) {
    result.b = bottom;
  }
  if (left) {
    result.l = left;
  }
  if (right) {
    result.r = right;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function convertBorderEdge(
  edge: Partial<ExcelJSNamespace.Border> | undefined,
  ctx: ColorContext,
): IBorderStyleData | undefined {
  if (!edge || !edge.style) {
    return undefined;
  }
  const styleValue = BORDER_STYLE[edge.style] ?? BORDER_STYLE.thin;
  const color = convertColor(edge.color, ctx) ?? { rgb: "#000000" };
  return { s: styleValue, cl: color };
}

function buildColumnData(
  worksheet: ExcelJSWorksheet,
  columnCount: number,
): Record<number, { w?: number; hd?: number }> {
  const columnData: Record<number, { w?: number; hd?: number }> = {};
  for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
    const column = worksheet.getColumn(columnNumber);
    const entry: { w?: number; hd?: number } = {};
    if (typeof column.width === "number" && column.width > 0) {
      entry.w = excelWidthToPixels(column.width);
    }
    if (column.hidden) {
      entry.hd = BOOL_TRUE;
    }
    if (Object.keys(entry).length > 0) {
      columnData[columnNumber - 1] = entry;
    }
  }
  return columnData;
}

function buildRowData(
  worksheet: ExcelJSWorksheet,
  rowCount: number,
): Record<number, { h?: number; hd?: number }> {
  const rowData: Record<number, { h?: number; hd?: number }> = {};
  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const entry: { h?: number; hd?: number } = {};
    if (typeof row.height === "number" && row.height > 0) {
      entry.h = pointsToPixels(row.height);
    }
    if (row.hidden) {
      entry.hd = BOOL_TRUE;
    }
    if (Object.keys(entry).length > 0) {
      rowData[rowNumber - 1] = entry;
    }
  }
  return rowData;
}

function buildMergeData(worksheet: ExcelJSWorksheet): IRange[] {
  const merges = readWorksheetMerges(worksheet);
  return merges
    .map(parseA1Range)
    .filter((range): range is IRange => range !== undefined);
}

function readWorksheetMerges(worksheet: ExcelJSWorksheet): string[] {
  const model = (worksheet as unknown as { model?: { merges?: unknown } })
    .model;
  if (model && Array.isArray(model.merges)) {
    return model.merges.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  const internal = (worksheet as unknown as { _merges?: Record<string, unknown> })
    ._merges;
  if (internal && typeof internal === "object") {
    return Object.keys(internal);
  }
  return [];
}

function buildFreeze(worksheet: ExcelJSWorksheet): IWorksheetData["freeze"] {
  const view = worksheet.views?.[0];
  if (view && view.state === "frozen") {
    const xSplit = view.xSplit ?? 0;
    const ySplit = view.ySplit ?? 0;
    return {
      xSplit,
      ySplit,
      startRow: ySplit,
      startColumn: xSplit,
    };
  }
  return { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 };
}

function parseA1Range(range: string): IRange | undefined {
  const [start, end] = range.split(":");
  const startCell = parseA1Cell(start);
  const endCell = parseA1Cell(end ?? start);
  if (!startCell || !endCell) {
    return undefined;
  }
  return {
    startRow: Math.min(startCell.row, endCell.row),
    startColumn: Math.min(startCell.column, endCell.column),
    endRow: Math.max(startCell.row, endCell.row),
    endColumn: Math.max(startCell.column, endCell.column),
  };
}

function parseA1Cell(
  reference: string,
): { row: number; column: number } | undefined {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(reference.trim());
  if (!match) {
    return undefined;
  }
  const letters = match[1].toUpperCase();
  let column = 0;
  for (const char of letters) {
    column = column * 26 + (char.charCodeAt(0) - 64);
  }
  return { row: Number.parseInt(match[2], 10) - 1, column: column - 1 };
}

function excelWidthToPixels(width: number): number {
  return Math.round(width * 7 + 5);
}

function pointsToPixels(points: number): number {
  return Math.round((points * 96) / 72);
}
