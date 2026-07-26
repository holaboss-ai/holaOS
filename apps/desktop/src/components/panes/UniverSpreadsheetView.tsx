import { useEffect, useRef } from "react";
import type { FUniver, IWorkbookData } from "@univerjs/presets";
import {
  CommandType,
  createUniver,
  defaultTheme,
  LocaleType,
  mergeLocales,
} from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import UniverPresetSheetsCoreZhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { UniverSheetsConditionalFormattingPreset } from "@univerjs/preset-sheets-conditional-formatting";
import UniverPresetSheetsConditionalFormattingEnUS from "@univerjs/preset-sheets-conditional-formatting/locales/en-US";
import UniverPresetSheetsConditionalFormattingZhCN from "@univerjs/preset-sheets-conditional-formatting/locales/zh-CN";
import { UniverSheetsFilterPreset } from "@univerjs/preset-sheets-filter";
import UniverPresetSheetsFilterEnUS from "@univerjs/preset-sheets-filter/locales/en-US";
import UniverPresetSheetsFilterZhCN from "@univerjs/preset-sheets-filter/locales/zh-CN";

import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-sheets-conditional-formatting/lib/index.css";
import "@univerjs/preset-sheets-filter/lib/index.css";

interface UniverSpreadsheetViewProps {
  snapshot: IWorkbookData;
  editable: boolean;
  darkMode: boolean;
  onReady?: (api: FUniver) => void;
  onEdited?: () => void;
  onDispose?: () => void;
}

const LOCALES = {
  [LocaleType.ZH_CN]: mergeLocales(
    UniverPresetSheetsCoreZhCN,
    UniverPresetSheetsConditionalFormattingZhCN,
    UniverPresetSheetsFilterZhCN,
  ),
  [LocaleType.EN_US]: mergeLocales(
    UniverPresetSheetsCoreEnUS,
    UniverPresetSheetsConditionalFormattingEnUS,
    UniverPresetSheetsFilterEnUS,
  ),
};

export function UniverSpreadsheetView({
  snapshot,
  editable,
  darkMode,
  onReady,
  onEdited,
  onDispose,
}: UniverSpreadsheetViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  const onEditedRef = useRef(onEdited);
  const onDisposeRef = useRef(onDispose);
  onReadyRef.current = onReady;
  onEditedRef.current = onEdited;
  onDisposeRef.current = onDispose;

  // Recreate the Univer instance whenever the workbook data or edit mode
  // changes. Univer owns the DOM inside the container, so React must never
  // render children into it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const { univer, univerAPI } = createUniver({
      locale: LocaleType.ZH_CN,
      locales: LOCALES,
      theme: defaultTheme,
      darkMode,
      presets: [
        UniverSheetsCorePreset({ container, toolbar: false }),
        UniverSheetsConditionalFormattingPreset(),
        UniverSheetsFilterPreset(),
      ],
    });

    const workbook = univerAPI.createWorkbook(snapshot);
    if (!editable) {
      workbook.setEditable(false);
    }

    onReadyRef.current?.(univerAPI);

    // A MUTATION is a data change persisted to the snapshot; OPERATION commands
    // (scroll, selection) are not, so filtering to mutations gives a clean
    // dirty signal without false positives from navigation.
    const editListener = editable
      ? univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
          if (event.type === CommandType.MUTATION) {
            onEditedRef.current?.();
          }
        })
      : null;

    return () => {
      editListener?.dispose();
      onDisposeRef.current?.();
      univer.dispose();
    };
  }, [snapshot, editable, darkMode]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
