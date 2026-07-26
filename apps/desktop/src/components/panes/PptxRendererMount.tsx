import { PptxViewer } from "@aiden0z/pptx-renderer";
import { useEffect, useRef } from "react";

// Heavy renderer (parser + ECharts) lives behind a React.lazy boundary so
// opening a non-pptx file never pulls this chunk. Mounts the viewer into a
// plain div and tears it down on unmount / byte change.
export default function PptxRendererMount({
  bytes,
  onReady,
  onError,
}: {
  bytes: Uint8Array;
  onReady?: (slideCount: number) => void;
  onError?: (error: unknown) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let viewer: PptxViewer | null = null;
    let cancelled = false;
    void (async () => {
      try {
        viewer = await PptxViewer.open(bytes, container, {
          fitMode: "contain",
          renderMode: "list",
          listOptions: { windowed: false, showSlideLabels: false },
        });
        if (cancelled) {
          viewer.destroy();
          viewer = null;
          return;
        }
        onReadyRef.current?.(viewer.slideCount);
      } catch (error) {
        if (!cancelled) {
          onErrorRef.current?.(error);
        }
      }
    })();
    return () => {
      cancelled = true;
      viewer?.destroy();
    };
  }, [bytes]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col items-center gap-5 [&>*]:overflow-hidden [&>*]:rounded-lg [&>*]:border [&>*]:border-border/70 [&>*]:bg-white [&>*]:shadow-sm"
    />
  );
}
