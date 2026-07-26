import { useEffect, useRef } from "react";
import type { ISlideData } from "@univerjs/slides";
import {
  defaultTheme,
  LocaleType,
  mergeLocales,
  Univer,
  UniverInstanceType,
} from "@univerjs/presets";
import {
  UniverDocsPlugin,
  UniverDocsUIPlugin,
  UniverRenderEnginePlugin,
  UniverUIPlugin,
} from "@univerjs/preset-docs-core";
import UniverPresetDocsCoreEnUS from "@univerjs/preset-docs-core/locales/en-US";
import UniverPresetDocsCoreZhCN from "@univerjs/preset-docs-core/locales/zh-CN";
import { UniverSlidesPlugin } from "@univerjs/slides";
import { UniverSlidesUIPlugin } from "@univerjs/slides-ui";
import UniverSlidesUIEnUS from "@univerjs/slides-ui/locale/en-US";
import UniverSlidesUIZhCN from "@univerjs/slides-ui/locale/zh-CN";

import "@univerjs/preset-docs-core/lib/index.css";
import "@univerjs/slides-ui/lib/index.css";

interface UniverSlideViewProps {
  slideData: ISlideData;
  darkMode: boolean;
}

const LOCALES = {
  [LocaleType.ZH_CN]: mergeLocales(
    UniverPresetDocsCoreZhCN,
    UniverSlidesUIZhCN,
  ),
  [LocaleType.EN_US]: mergeLocales(
    UniverPresetDocsCoreEnUS,
    UniverSlidesUIEnUS,
  ),
};

// Univer Slides has no preset/facade, so the plugin stack is wired by hand.
// Order mirrors the sheets/docs presets: render engine + UI shell first, then
// the doc engine (slide text elements render through it), then slides.
export function UniverSlideView({ slideData, darkMode }: UniverSlideViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const univer = new Univer({
      theme: defaultTheme,
      darkMode,
      locale: LocaleType.ZH_CN,
      locales: LOCALES,
    });

    univer.registerPlugin(UniverRenderEnginePlugin);
    univer.registerPlugin(UniverUIPlugin, { container });
    univer.registerPlugin(UniverDocsPlugin);
    univer.registerPlugin(UniverDocsUIPlugin);
    univer.registerPlugin(UniverSlidesPlugin);
    univer.registerPlugin(UniverSlidesUIPlugin);

    univer.createUnit(UniverInstanceType.UNIVER_SLIDE, slideData);

    return () => {
      univer.dispose();
    };
  }, [slideData, darkMode]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
