import type { MouseEvent } from "react";
import { ArrowUpRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SpreadsheetEditorProps {
  sheets: FilePreviewTableSheetPayload[];
  activeSheetIndex: number;
  onActiveSheetIndexChange: (index: number) => void;
  editable?: boolean;
  readOnlyReason?: string | null;
  onChange?: (sheets: FilePreviewTableSheetPayload[]) => void;
  onOpenLinkInBrowser?: (url: string) => void;
}

function normalizeSpreadsheetCellLinkTarget(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^localhost(?::\d+)?(?:[/?#]|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  if (
    /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)/.test(trimmed) ||
    /^(?:www\.)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?(?:[/?#]|$)/.test(
      trimmed,
    )
  ) {
    return /^www\./i.test(trimmed)
      ? `https://${trimmed}`
      : `https://${trimmed}`;
  }

  return null;
}

function cloneTablePreviewSheetLinks(
  links: (string | null)[][] | null | undefined,
  rows: string[][],
  columns: string[],
): (string | null)[][] {
  return rows.map((row, rowIndex) =>
    Array.from(
      { length: Math.max(columns.length, row.length, 1) },
      (_unused, columnIndex) =>
        normalizeSpreadsheetCellLinkTarget(links?.[rowIndex]?.[columnIndex]) ??
        null,
    ),
  );
}

function cloneTablePreviewSheetImages(
  images: FilePreviewTableImagePayload[] | null | undefined,
): FilePreviewTableImagePayload[] {
  return Array.isArray(images)
    ? images.map((image) => ({
        ...image,
      }))
    : [];
}

export function cloneTablePreviewSheets(
  sheets: FilePreviewTableSheetPayload[] | null | undefined,
): FilePreviewTableSheetPayload[] {
  return Array.isArray(sheets)
    ? sheets.map((sheet) => ({
        ...sheet,
        columns: [...sheet.columns],
        rows: sheet.rows.map((row) => [...row]),
        links: cloneTablePreviewSheetLinks(
          sheet.links,
          sheet.rows,
          sheet.columns,
        ),
        images: cloneTablePreviewSheetImages(sheet.images),
      }))
    : [];
}

export function areTablePreviewSheetsEqual(
  left: FilePreviewTableSheetPayload[] | null | undefined,
  right: FilePreviewTableSheetPayload[] | null | undefined,
): boolean {
  const normalizedLeft = cloneTablePreviewSheets(left);
  const normalizedRight = cloneTablePreviewSheets(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((sheet, sheetIndex) => {
    const candidate = normalizedRight[sheetIndex];
    if (!candidate) {
      return false;
    }
    if (
      sheet.name !== candidate.name ||
      sheet.index !== candidate.index ||
      sheet.totalRows !== candidate.totalRows ||
      sheet.totalColumns !== candidate.totalColumns ||
      sheet.truncated !== candidate.truncated ||
      sheet.hasHeaderRow !== candidate.hasHeaderRow ||
      sheet.columns.length !== candidate.columns.length ||
      sheet.rows.length !== candidate.rows.length ||
      cloneTablePreviewSheetImages(sheet.images).length !==
        cloneTablePreviewSheetImages(candidate.images).length
    ) {
      return false;
    }

    return (
      sheet.columns.every(
        (column, columnIndex) => column === candidate.columns[columnIndex],
      ) &&
      cloneTablePreviewSheetLinks(sheet.links, sheet.rows, sheet.columns).every(
        (row, rowIndex) =>
          row.length ===
            cloneTablePreviewSheetLinks(
              candidate.links,
              candidate.rows,
              candidate.columns,
            )[rowIndex]?.length &&
          row.every(
            (value, columnIndex) =>
              value ===
              cloneTablePreviewSheetLinks(
                candidate.links,
                candidate.rows,
                candidate.columns,
              )[rowIndex]?.[columnIndex],
          ),
      ) &&
      cloneTablePreviewSheetImages(sheet.images).every(
        (image, imageIndex) =>
          image.row === candidate.images?.[imageIndex]?.row &&
          image.column === candidate.images?.[imageIndex]?.column &&
          image.dataUrl === candidate.images?.[imageIndex]?.dataUrl &&
          image.widthPx === candidate.images?.[imageIndex]?.widthPx &&
          image.heightPx === candidate.images?.[imageIndex]?.heightPx &&
          image.alt === candidate.images?.[imageIndex]?.alt,
      ) &&
      sheet.rows.every(
        (row, rowIndex) =>
          row.length === candidate.rows[rowIndex]?.length &&
          row.every(
            (value, columnIndex) =>
              value === candidate.rows[rowIndex]?.[columnIndex],
          ),
      )
    );
  });
}

function nextSpreadsheetColumnName(columnCount: number) {
  return `Column ${columnCount + 1}`;
}

function updateSpreadsheetSheets(
  sheets: FilePreviewTableSheetPayload[],
  updateSheet: (
    sheet: FilePreviewTableSheetPayload,
  ) => FilePreviewTableSheetPayload,
  targetSheetIndex: number,
) {
  return sheets.map((sheet, sheetIndex) =>
    sheetIndex === targetSheetIndex ? updateSheet(sheet) : sheet,
  );
}

function spreadsheetPreviewCellImageKey(row: number, column: number) {
  return `${row}:${column}`;
}

function spreadsheetPreviewImagesByCell(
  images: FilePreviewTableImagePayload[] | null | undefined,
): Map<string, FilePreviewTableImagePayload[]> {
  const imagesByCell = new Map<string, FilePreviewTableImagePayload[]>();
  for (const image of images ?? []) {
    const key = spreadsheetPreviewCellImageKey(image.row, image.column);
    const cellImages = imagesByCell.get(key) ?? [];
    cellImages.push(image);
    imagesByCell.set(key, cellImages);
  }
  return imagesByCell;
}

export function SpreadsheetEditor({
  sheets,
  activeSheetIndex,
  onActiveSheetIndexChange,
  editable = false,
  readOnlyReason = null,
  onChange,
  onOpenLinkInBrowser,
}: SpreadsheetEditorProps) {
  const activeSheet =
    sheets[Math.min(activeSheetIndex, Math.max(sheets.length - 1, 0))] ?? null;
  const cellImages = spreadsheetPreviewImagesByCell(activeSheet?.images);

  const openSpreadsheetCellLink = (url: string) => {
    if (onOpenLinkInBrowser) {
      onOpenLinkInBrowser(url);
      return;
    }
    void window.electronAPI.ui.openExternalUrl(url);
  };

  const maybeOpenEditableSpreadsheetCellLink = (
    event: MouseEvent<HTMLInputElement>,
    url: string | null,
  ) => {
    if (!url || (!event.metaKey && !event.ctrlKey)) {
      return;
    }
    event.preventDefault();
    openSpreadsheetCellLink(url);
  };

  const renderSpreadsheetCellImages = (
    images: FilePreviewTableImagePayload[],
    rowIndex: number,
    columnIndex: number,
  ) => {
    if (images.length === 0) {
      return null;
    }

    return (
      <div className="flex flex-col gap-2">
        {images.map((image, imageIndex) => (
          <img
            key={`${image.row}-${image.column}-${imageIndex}`}
            src={image.dataUrl}
            alt={
              image.alt ??
              `Embedded image for row ${rowIndex + 1}, column ${columnIndex + 1}`
            }
            className="max-h-56 w-auto max-w-[240px] rounded-md border border-border bg-muted object-contain"
            style={{
              maxWidth: image.widthPx
                ? Math.min(image.widthPx, 240)
                : undefined,
              maxHeight: image.heightPx
                ? Math.min(image.heightPx, 224)
                : undefined,
            }}
          />
        ))}
      </div>
    );
  };

  const updateHeaderValue = (columnIndex: number, value: string) => {
    if (!editable || !onChange || !activeSheet) {
      return;
    }
    onChange(
      updateSpreadsheetSheets(
        sheets,
        (sheet) => {
          const nextColumns = [...sheet.columns];
          nextColumns[columnIndex] = value;
          return {
            ...sheet,
            columns: nextColumns,
          };
        },
        activeSheetIndex,
      ),
    );
  };

  const updateCellValue = (
    rowIndex: number,
    columnIndex: number,
    value: string,
  ) => {
    if (!editable || !onChange || !activeSheet) {
      return;
    }
    onChange(
      updateSpreadsheetSheets(
        sheets,
        (sheet) => {
          const nextRows = sheet.rows.map((row) => [...row]);
          const nextRow = [...(nextRows[rowIndex] ?? [])];
          nextRow[columnIndex] = value;
          while (nextRow.length < sheet.columns.length) {
            nextRow.push("");
          }
          nextRows[rowIndex] = nextRow;
          const nextLinks = cloneTablePreviewSheetLinks(
            sheet.links,
            nextRows,
            sheet.columns,
          );
          nextLinks[rowIndex] = [
            ...(nextLinks[rowIndex] ??
              Array.from({ length: sheet.columns.length }, () => null)),
          ];
          nextLinks[rowIndex][columnIndex] =
            normalizeSpreadsheetCellLinkTarget(value);
          return {
            ...sheet,
            rows: nextRows,
            links: nextLinks,
          };
        },
        activeSheetIndex,
      ),
    );
  };

  const addRow = () => {
    if (!editable || !onChange || !activeSheet) {
      return;
    }
    onChange(
      updateSpreadsheetSheets(
        sheets,
        (sheet) => ({
          ...sheet,
          rows: [
            ...sheet.rows,
            Array.from({ length: Math.max(sheet.columns.length, 1) }, () => ""),
          ],
          links: [
            ...cloneTablePreviewSheetLinks(
              sheet.links,
              sheet.rows,
              sheet.columns,
            ),
            Array.from(
              { length: Math.max(sheet.columns.length, 1) },
              () => null,
            ),
          ],
          totalRows: Math.max(sheet.totalRows + 1, sheet.rows.length + 1),
        }),
        activeSheetIndex,
      ),
    );
  };

  const addColumn = () => {
    if (!editable || !onChange || !activeSheet) {
      return;
    }
    onChange(
      updateSpreadsheetSheets(
        sheets,
        (sheet) => {
          const nextColumns = [
            ...sheet.columns,
            nextSpreadsheetColumnName(sheet.columns.length),
          ];
          const nextRows = sheet.rows.map((row) => [...row, ""]);
          const nextLinks = cloneTablePreviewSheetLinks(
            sheet.links,
            nextRows,
            nextColumns,
          );
          return {
            ...sheet,
            columns: nextColumns,
            rows: nextRows,
            links: nextLinks,
            totalColumns: Math.max(
              sheet.totalColumns + 1,
              sheet.columns.length + 1,
            ),
          };
        },
        activeSheetIndex,
      ),
    );
  };

  if (!activeSheet) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="text-xs text-muted-foreground">
          No sheet data is available for this preview.
        </div>
      </div>
    );
  }

  const metadataParts: string[] = [];
  metadataParts.push(`${activeSheet.rows.length} rows`);
  metadataParts.push(`${activeSheet.columns.length} columns`);
  if (activeSheet.truncated) {
    metadataParts.push("Preview trimmed");
  }
  if (!editable && readOnlyReason) {
    metadataParts.push(readOnlyReason);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
      <div className="min-h-0 flex-1 overflow-auto rounded-[inherit]">
        <table className="w-max min-w-full border-separate border-spacing-0 text-sm text-foreground">
          <thead className="sticky top-0 z-2">
            <tr>
              <th className="sticky left-0 z-3 w-11 rounded-tl-lg border-b border-r border-border bg-muted px-0 py-0 text-center text-xs font-normal uppercase text-muted-foreground">
                <div className="flex h-8 items-center justify-center">#</div>
              </th>
              {activeSheet.columns.map((column, columnIndex) => (
                <th
                  key={`${column}-${columnIndex}`}
                  className="min-w-[172px] border-b border-r border-border bg-muted px-0 py-0 text-left text-xs font-medium text-foreground last:rounded-tr-lg last:border-r-0"
                >
                  {activeSheet.hasHeaderRow && editable ? (
                    <input
                      value={column}
                      onChange={(event) =>
                        updateHeaderValue(columnIndex, event.target.value)
                      }
                      aria-label={`Column ${columnIndex + 1}`}
                      className="embedded-input h-8 w-full border-0 bg-transparent px-3 text-xs font-medium text-foreground outline-none"
                    />
                  ) : (
                    <div className="px-3 py-2 font-medium text-foreground">
                      {column}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeSheet.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={activeSheet.columns.length + 1}
                  className="px-3 py-10 text-center text-xs text-muted-foreground"
                >
                  {editable
                    ? "No rows yet. Add a row to start editing."
                    : "No rows in this sheet."}
                </td>
              </tr>
            ) : (
              activeSheet.rows.map((row, rowIndex) => {
                const isLastRow = rowIndex === activeSheet.rows.length - 1;
                return (
                  <tr key={`row-${rowIndex}`} className="group/row">
                    <td
                      className={`sticky left-0 z-[1] w-11 border-b border-r border-border bg-background px-0 py-0 text-center align-middle text-xs text-muted-foreground transition-colors group-hover/row:bg-accent/25 group-hover/row:text-muted-foreground ${isLastRow ? "rounded-bl-lg" : ""}`}
                    >
                      <div className="flex min-h-8 items-center justify-center">
                        {rowIndex + 1}
                      </div>
                    </td>
                    {activeSheet.columns.map((_column, columnIndex) => {
                      const value = row[columnIndex] ?? "";
                      const cellLink =
                        activeSheet.links?.[rowIndex]?.[columnIndex] ??
                        normalizeSpreadsheetCellLinkTarget(value);
                      const images =
                        cellImages.get(
                          spreadsheetPreviewCellImageKey(
                            rowIndex,
                            columnIndex,
                          ),
                        ) ?? [];
                      return (
                        <td
                          key={`cell-${rowIndex}-${columnIndex}`}
                          className="min-w-[172px] border-b border-r border-border px-0 py-0 align-top transition-colors last:border-r-0 group-hover/row:bg-accent/20"
                        >
                          {editable ? (
                            <div className="flex min-h-8 flex-col gap-2 px-2 py-2">
                              {renderSpreadsheetCellImages(
                                images,
                                rowIndex,
                                columnIndex,
                              )}
                              <div className="flex items-center gap-1">
                                <input
                                  value={value}
                                  onChange={(event) =>
                                    updateCellValue(
                                      rowIndex,
                                      columnIndex,
                                      event.target.value,
                                    )
                                  }
                                  onClick={(event) =>
                                    maybeOpenEditableSpreadsheetCellLink(
                                      event,
                                      cellLink,
                                    )
                                  }
                                  aria-label={`Row ${rowIndex + 1}, Column ${columnIndex + 1}`}
                                  className={`embedded-input h-6 min-w-0 flex-1 border-0 bg-transparent px-1 text-sm outline-none ${
                                    cellLink
                                      ? "text-primary underline underline-offset-2"
                                      : "text-foreground"
                                  }`}
                                />
                                {cellLink ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      openSpreadsheetCellLink(cellLink)
                                    }
                                    aria-label={`Open link from row ${rowIndex + 1}, column ${columnIndex + 1}`}
                                    title={cellLink}
                                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10 hover:text-primary"
                                  >
                                    <ArrowUpRight size={12} />
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ) : cellLink ? (
                            <div className="flex flex-col gap-2 px-3 py-2">
                              {renderSpreadsheetCellImages(
                                images,
                                rowIndex,
                                columnIndex,
                              )}
                              <button
                                type="button"
                                onClick={() => openSpreadsheetCellLink(cellLink)}
                                title={cellLink}
                                className="block w-full cursor-pointer bg-transparent text-left text-sm break-words whitespace-pre-wrap text-primary underline underline-offset-2 transition-colors hover:text-primary"
                              >
                                {value || cellLink}
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-2 px-3 py-2 text-sm break-words whitespace-pre-wrap">
                              {renderSpreadsheetCellImages(
                                images,
                                rowIndex,
                                columnIndex,
                              )}
                              {value ? <div>{value}</div> : images.length === 0 ? "\u00a0" : null}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-muted px-2.5 py-1.5">
        <div className="chat-scrollbar-hidden flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {sheets.length > 1 ? (
            sheets.map((sheet, index) => {
              const isActive = index === activeSheetIndex;
              return (
                <button
                  key={`${sheet.name}-${sheet.index}`}
                  type="button"
                  onClick={() => onActiveSheetIndexChange(index)}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors ${
                    isActive
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                >
                  {sheet.name}
                </button>
              );
            })
          ) : (
            <span className="truncate px-1 text-xs text-muted-foreground">
              {activeSheet.name}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {metadataParts.join(" · ")}
          </span>
          {editable ? (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={addColumn}
              >
                <Plus size={11} />
                Column
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={addRow}>
                <Plus size={11} />
                Row
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
