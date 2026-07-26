import { useEffect, useRef } from "react";
import type { FUniver } from "@univerjs/presets";
import {
  CommandType,
  createUniver,
  defaultTheme,
  LocaleType,
  mergeLocales,
} from "@univerjs/presets";
import {
  SetDocZoomRatioCommand,
  UniverDocsCorePreset,
} from "@univerjs/preset-docs-core";
import UniverPresetDocsCoreEnUS from "@univerjs/preset-docs-core/locales/en-US";
import UniverPresetDocsCoreZhCN from "@univerjs/preset-docs-core/locales/zh-CN";

import "@univerjs/preset-docs-core/lib/index.css";

import { htmlToUniverDocument } from "@/lib/htmlToUniverDoc";

interface UniverDocViewProps {
  html: string;
  darkMode: boolean;
  onReady?: (api: FUniver) => void;
  onEdited?: () => void;
  onDispose?: () => void;
}

const LOCALES = {
  [LocaleType.ZH_CN]: mergeLocales(UniverPresetDocsCoreZhCN),
  [LocaleType.EN_US]: mergeLocales(UniverPresetDocsCoreEnUS),
};

export function UniverDocView({
  html,
  darkMode,
  onReady,
  onEdited,
  onDispose,
}: UniverDocViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  const onEditedRef = useRef(onEdited);
  const onDisposeRef = useRef(onDispose);
  onReadyRef.current = onReady;
  onEditedRef.current = onEdited;
  onDisposeRef.current = onDispose;

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
      presets: [UniverDocsCorePreset({ container })],
    });

    const fDoc = univerAPI.createUniverDoc(htmlToUniverDocument(html));
    onReadyRef.current?.(univerAPI);

    // Default to 90% zoom; defer a frame so the doc render skeleton exists.
    const zoomHandle = requestAnimationFrame(() => {
      void univerAPI.executeCommand(SetDocZoomRatioCommand.id, {
        zoomRatio: 0.9,
        documentId: fDoc.getId(),
      });
    });

    // MUTATIONs are content changes persisted to the snapshot; ignore the
    // mutations Univer fires while first building the document.
    let ready = false;
    const readyHandle = requestAnimationFrame(() => {
      ready = true;
    });
    const editListener = univerAPI.addEvent(
      univerAPI.Event.CommandExecuted,
      (event) => {
        if (ready && event.type === CommandType.MUTATION) {
          onEditedRef.current?.();
        }
      },
    );

    return () => {
      cancelAnimationFrame(zoomHandle);
      cancelAnimationFrame(readyHandle);
      editListener.dispose();
      onDisposeRef.current?.();
      univer.dispose();
    };
  }, [html, darkMode]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
