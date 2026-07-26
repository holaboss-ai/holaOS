import { atomWithStorage } from "jotai/utils";

export type SpreadsheetEngine = "univer" | "legacy";

// Which spreadsheet preview surface to render. "univer" is the full-fidelity
// canvas engine; "legacy" is the original HTML-table editor, kept for rollback
// and side-by-side comparison.
export const spreadsheetEngineAtom = atomWithStorage<SpreadsheetEngine>(
  "holaboss.spreadsheet-engine",
  "univer",
);

export type DocumentEngine = "univer" | "legacy";

// Which docx preview surface to render. "univer" is the Univer Docs canvas
// (docx→HTML→Univer); "legacy" is the @eigenpal OOXML editor, kept for
// rollback and side-by-side comparison.
export const documentEngineAtom = atomWithStorage<DocumentEngine>(
  "holaboss.document-engine",
  "univer",
);

export type PresentationEngine = "univer" | "legacy";

// Which pptx preview surface to render. "legacy" is the @aiden0z renderer,
// which draws the real slides (images/shapes/fills) and is the default. The
// "univer" Univer Slides path is text-only today (no DrawingML) and kept
// behind the flag for future work.
export const presentationEngineAtom = atomWithStorage<PresentationEngine>(
  "holaboss.presentation-engine",
  "legacy",
);
