/**
 * presentationToSlideData — converts the main process's extracted presentation
 * text boxes (percent-positioned) into a Univer `ISlideData` snapshot. This is
 * the text-only first pass of pptx→Univer Slides; images/shapes/fills come
 * later. Pure — unit-testable without a DOM.
 */

import type {
  ISlideData,
  ISlidePage,
  ISlideRichTextProps,
  IPageElement,
} from "@univerjs/slides";

const PAGE_TYPE_SLIDE = 0;
const PAGE_ELEMENT_TYPE_TEXT = 2;
const H_ALIGN = { left: 1, center: 2, right: 3, justify: 4 } as const;

// Slide dimensions come in as EMU (PowerPoint's unit); 9525 EMU = 1px @ 96dpi.
// Rendering at the real pixel size keeps font sizes (also px @ 96dpi) and
// percent-positioned boxes proportional to what PowerPoint intended.
const EMU_PER_PX = 9525;
const DEFAULT_PAGE_WIDTH = 1280;
const DEFAULT_PAGE_HEIGHT = 720;
const MIN_FONT_PX = 12;
const MAX_FONT_PX = 40;

interface PresentationTextBox {
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  paragraphs: string[];
  align: "left" | "center" | "right" | "justify";
  fontSizePx?: number;
  bold?: boolean;
}

interface PresentationSlide {
  index: number;
  boxes: PresentationTextBox[];
}

export interface SlideDataOptions {
  width?: number;
  height?: number;
  title?: string;
}

export function slideDataFromPresentation(
  slides: PresentationSlide[],
  options: SlideDataOptions,
): ISlideData {
  const pageWidth = emuToPx(options.width, DEFAULT_PAGE_WIDTH);
  const pageHeight = emuToPx(options.height, DEFAULT_PAGE_HEIGHT);

  const pages: Record<string, ISlidePage> = {};
  const pageOrder: string[] = [];

  slides.forEach((slide, slideIndex) => {
    const pageId = `page-${slideIndex}`;
    const pageElements: Record<string, IPageElement> = {};

    slide.boxes.forEach((box, boxIndex) => {
      const elementId = `el-${slideIndex}-${boxIndex}`;
      pageElements[elementId] = buildTextElement(
        elementId,
        box,
        boxIndex,
        pageWidth,
        pageHeight,
      );
    });

    pages[pageId] = {
      id: pageId,
      pageType: PAGE_TYPE_SLIDE,
      zIndex: slideIndex,
      title: "",
      description: "",
      pageBackgroundFill: { rgb: "#FFFFFF" },
      pageElements,
    };
    pageOrder.push(pageId);
  });

  return {
    id: "univer-slide-preview",
    title: options.title ?? "Presentation",
    pageSize: { width: pageWidth, height: pageHeight },
    body: { pages, pageOrder },
  };
}

function buildTextElement(
  id: string,
  box: PresentationTextBox,
  zIndex: number,
  pageWidth: number,
  pageHeight: number,
): IPageElement {
  const width = (box.widthPct / 100) * pageWidth;
  const height = (box.heightPct / 100) * pageHeight;
  const fontSize = resolveFontSize(box, height);
  return {
    id,
    zIndex,
    title: "",
    description: "",
    type: PAGE_ELEMENT_TYPE_TEXT,
    left: (box.xPct / 100) * pageWidth,
    top: (box.yPct / 100) * pageHeight,
    width,
    height,
    richText: {
      text: box.paragraphs.join("\n"),
      rich: buildRichText(box, fontSize),
      fs: fontSize,
      bl: box.bold ? 1 : 0,
      ht: H_ALIGN[box.align],
    } as ISlideRichTextProps,
  };
}

// Always resolve an explicit font size. When the box carries none (its size is
// inherited from the slide master/layout, which we don't parse), Univer would
// otherwise render at its large default — so estimate a size that fits the box
// height instead of leaving it undefined.
function resolveFontSize(box: PresentationTextBox, boxHeight: number): number {
  if (box.fontSizePx) {
    return box.fontSizePx;
  }
  const lineCount = Math.max(box.paragraphs.length, 1);
  const estimated = Math.round(boxHeight / (lineCount * 1.6));
  return Math.max(MIN_FONT_PX, Math.min(estimated, MAX_FONT_PX));
}

function emuToPx(emu: number | undefined, fallback: number): number {
  return emu && emu > 0 ? Math.round(emu / EMU_PER_PX) : fallback;
}

// Build a minimal Univer document body for the text so the doc-based slide
// renderer has structured content (dataStream with \r paragraph marks).
function buildRichText(box: PresentationTextBox, fontSize: number) {
  const paragraphs = box.paragraphs.length > 0 ? box.paragraphs : [""];
  let dataStream = "";
  const paragraphMarks: Array<{ startIndex: number }> = [];
  for (const paragraph of paragraphs) {
    dataStream += paragraph;
    paragraphMarks.push({ startIndex: dataStream.length });
    dataStream += "\r";
  }
  dataStream += "\n";
  const textStyle = {
    fs: fontSize,
    ...(box.bold ? { bl: 1 as const } : {}),
  };
  return {
    id: `${box.paragraphs.join("|")}-doc`,
    body: {
      dataStream,
      paragraphs: paragraphMarks.map((mark) => ({
        startIndex: mark.startIndex,
        paragraphStyle: { horizontalAlign: H_ALIGN[box.align] },
      })),
      textRuns:
        dataStream.length > 1
          ? [{ st: 0, ed: dataStream.length - 1, ts: textStyle }]
          : [],
    },
    documentStyle: {},
  };
}
