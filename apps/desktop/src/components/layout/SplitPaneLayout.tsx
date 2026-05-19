import { ReactNode, useEffect, useMemo, useRef, useState } from "react";

interface SplitPaneLayoutProps {
  sizes: [number, number, number];
  onSizesChange: (sizes: [number, number, number]) => void;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}

const MIN_LEFT = 14;
const MIN_CENTER = 14;
const MIN_RIGHT = 14;

export function SplitPaneLayout({ sizes, onSizesChange, left, center, right }: SplitPaneLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragHandle, setDragHandle] = useState<1 | 2 | null>(null);

  const templateColumns = useMemo(
    () => `${sizes[0]}fr 0px ${sizes[1]}fr 0px ${sizes[2]}fr`,
    [sizes]
  );

  useEffect(() => {
    if (!dragHandle) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const xPct = ((event.clientX - rect.left) / rect.width) * 100;

      if (dragHandle === 1) {
        const right = sizes[2];
        const maxLeft = 100 - right - MIN_CENTER;
        const nextLeft = Math.min(Math.max(xPct, MIN_LEFT), maxLeft);
        const nextCenter = 100 - right - nextLeft;

        onSizesChange([nextLeft, nextCenter, right]);
      } else {
        const leftSize = sizes[0];
        const maxCenter = 100 - leftSize - MIN_RIGHT;
        const minCenter = MIN_CENTER;
        const nextCenter = Math.min(Math.max(xPct - leftSize, minCenter), maxCenter);
        const nextRight = 100 - leftSize - nextCenter;

        onSizesChange([leftSize, nextCenter, nextRight]);
      }
    };

    const onPointerUp = () => setDragHandle(null);

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragHandle, onSizesChange, sizes]);

  return (
    <div
      ref={containerRef}
      className="grid h-full min-h-0 w-full grid-rows-[minmax(0,1fr)]"
      style={{ gridTemplateColumns: templateColumns }}
    >
      <div className="h-full min-h-0 min-w-0">{left}</div>
      <Handle onPointerDown={() => setDragHandle(1)} active={dragHandle === 1} />
      <div className="h-full min-h-0 min-w-0">{center}</div>
      <Handle onPointerDown={() => setDragHandle(2)} active={dragHandle === 2} />
      <div className="h-full min-h-0 min-w-0">{right}</div>
    </div>
  );
}

function Handle({ onPointerDown, active }: { onPointerDown: () => void; active: boolean }) {
  return (
    <div
      role="separator"
      aria-label="Resize pane"
      onPointerDown={onPointerDown}
      className="relative z-10 h-full w-0 cursor-col-resize"
    >
      <div className="absolute inset-y-0 -left-[3px] w-[6px]" />
    </div>
  );
}
