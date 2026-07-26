import test from "node:test";
import assert from "node:assert/strict";

import { slideDataFromPresentation } from "./presentationToSlideData.js";

type Slide = {
  index: number;
  boxes: Array<{
    xPct: number;
    yPct: number;
    widthPct: number;
    heightPct: number;
    paragraphs: string[];
    align: "left" | "center" | "right" | "justify";
    fontSizePx?: number;
    bold?: boolean;
  }>;
};

const oneSlide: Slide[] = [
  {
    index: 0,
    boxes: [
      {
        xPct: 10,
        yPct: 20,
        widthPct: 50,
        heightPct: 15,
        paragraphs: ["Hello", "World"],
        align: "center",
        fontSizePx: 32,
        bold: true,
      },
    ],
  },
];

test("emits one page per slide in pageOrder", () => {
  const slides: Slide[] = [
    { index: 0, boxes: [] },
    { index: 1, boxes: [] },
  ];
  const data = slideDataFromPresentation(slides, {});
  assert.equal(data.body?.pageOrder.length, 2);
  for (const pageId of data.body?.pageOrder ?? []) {
    assert.ok(data.body?.pages[pageId]);
    assert.equal(data.body?.pages[pageId]?.pageType, 0); // SLIDE
  }
});

test("derives page size aspect from presentation dimensions", () => {
  const data = slideDataFromPresentation([{ index: 0, boxes: [] }], {
    width: 12_192_000,
    height: 6_858_000,
  });
  const ratio = data.pageSize.width! / data.pageSize.height!;
  assert.ok(Math.abs(ratio - 16 / 9) < 0.01);
});

test("maps a text box to a positioned TEXT element", () => {
  // EMU dimensions that resolve to a 960x540 px page (× 9525 EMU/px).
  const data = slideDataFromPresentation(oneSlide, {
    width: 960 * 9525,
    height: 540 * 9525,
  });
  const page = data.body?.pages[data.body.pageOrder[0]];
  const elements = Object.values(page?.pageElements ?? {});
  assert.equal(elements.length, 1);
  const el = elements[0];
  assert.equal(el.type, 2); // TEXT
  // 10% of a 960px-wide page.
  assert.ok(Math.abs((el.left ?? 0) - 96) < 1);
  assert.ok(Math.abs((el.top ?? 0) - 108) < 1);
  assert.ok(Math.abs((el.width ?? 0) - 480) < 1);
});

test("always sets an explicit font size (never inherits Univer's default)", () => {
  const data = slideDataFromPresentation(
    [
      {
        index: 0,
        boxes: [
          {
            xPct: 5,
            yPct: 5,
            widthPct: 80,
            heightPct: 20,
            paragraphs: ["Inherited-size title"],
            align: "left",
            // no fontSizePx — size would be inherited from the master
          },
        ],
      },
    ],
    { width: 960 * 9525, height: 540 * 9525 },
  );
  const page = data.body?.pages[data.body.pageOrder[0]];
  const el = Object.values(page?.pageElements ?? {})[0];
  assert.equal(typeof el.richText?.fs, "number");
  assert.ok((el.richText?.fs ?? 0) >= 12 && (el.richText?.fs ?? 0) <= 40);
});

test("carries the box text into richText", () => {
  const data = slideDataFromPresentation(oneSlide, {});
  const page = data.body?.pages[data.body.pageOrder[0]];
  const el = Object.values(page?.pageElements ?? {})[0];
  const text = el.richText?.text ?? "";
  assert.ok(text.includes("Hello"));
  assert.ok(text.includes("World"));
});

test("produces a valid empty deck for no slides", () => {
  const data = slideDataFromPresentation([], {});
  assert.equal(data.body?.pageOrder.length, 0);
  assert.ok(data.pageSize.width! > 0 && data.pageSize.height! > 0);
});
