interface PresentationPreviewProps {
  name: string;
  slides: FilePreviewPresentationSlidePayload[];
  slideWidth?: number | null;
  slideHeight?: number | null;
}

function slideAspectRatio(
  slideWidth?: number | null,
  slideHeight?: number | null,
) {
  if (
    Number.isFinite(slideWidth) &&
    Number.isFinite(slideHeight) &&
    (slideWidth ?? 0) > 0 &&
    (slideHeight ?? 0) > 0
  ) {
    return `${slideWidth} / ${slideHeight}`;
  }
  return "16 / 9";
}

export function PresentationPreview({
  name,
  slides,
  slideWidth,
  slideHeight,
}: PresentationPreviewProps) {
  const aspectRatio = slideAspectRatio(slideWidth, slideHeight);

  return (
    <div className="h-full overflow-auto bg-muted px-6 py-5">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        {slides.map((slide) => (
          <section key={`${name}-slide-${slide.index}`} className="space-y-2">
            <div className="flex items-center justify-between px-1 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              <span>{name}</span>
              <span>Slide {slide.index}</span>
            </div>
            <div
              className="relative w-full overflow-hidden rounded-2xl border border-border/80 bg-white shadow-sm"
              style={{ aspectRatio }}
            >
              {slide.boxes.length > 0 ? (
                slide.boxes.map((box, boxIndex) => (
                  <div
                    key={`${slide.index}-${boxIndex}`}
                    className="absolute overflow-hidden text-slate-900"
                    style={{
                      left: `${box.xPct}%`,
                      top: `${box.yPct}%`,
                      width: `${box.widthPct}%`,
                      height: `${box.heightPct}%`,
                      textAlign: box.align,
                      fontSize: box.fontSizePx ? `${box.fontSizePx}px` : "16px",
                      fontWeight: box.bold ? 600 : 400,
                      lineHeight: 1.28,
                    }}
                  >
                    {box.paragraphs.map((paragraph, paragraphIndex) => (
                      <p
                        key={`${slide.index}-${boxIndex}-${paragraphIndex}`}
                        className={paragraphIndex === 0 ? "" : "mt-1.5"}
                        style={{ whiteSpace: "pre-wrap" }}
                      >
                        {paragraph}
                      </p>
                    ))}
                  </div>
                ))
              ) : (
                <div className="grid h-full place-items-center px-6 text-center text-xs text-muted-foreground">
                  No text content detected on this slide.
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
