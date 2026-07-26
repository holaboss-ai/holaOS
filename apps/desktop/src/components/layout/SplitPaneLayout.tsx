import {
  ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

interface SplitPaneLayoutProps {
  sizes: [number, number, number];
  onSizesChange: (sizes: [number, number, number]) => void;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  minSizes?: [number, number, number];
  handleLabel?: string;
}

const DEFAULT_MIN_SIZES: [number, number, number] = [14, 14, 14];

export function SplitPaneLayout({
  sizes,
  onSizesChange,
  left,
  center,
  right,
  minSizes = DEFAULT_MIN_SIZES,
  handleLabel = "Resize pane",
}: SplitPaneLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sizesRef = useRef(sizes);
  const dragStateRef = useRef<{
    handle: 1 | 2;
    pointerId: number;
  } | null>(null);
  const [dragHandle, setDragHandle] = useState<1 | 2 | null>(null);
  const [hoverHandle, setHoverHandle] = useState<1 | 2 | null>(null);

  const [minLeft, minCenter, minRight] = minSizes;

  const templateColumns = useMemo(
    () => `${sizes[0]}fr 0px ${sizes[1]}fr 0px ${sizes[2]}fr`,
    [sizes]
  );

  useEffect(() => {
    sizesRef.current = sizes;
  }, [sizes]);

  const stopDragging = () => {
    dragStateRef.current = null;
    setDragHandle(null);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const dragState = dragStateRef.current;
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const xPct = ((event.clientX - rect.left) / rect.width) * 100;
    const currentSizes = sizesRef.current;

    if (dragState.handle === 1) {
      const right = currentSizes[2];
      const maxLeft = 100 - right - minCenter;
      const nextLeft = Math.min(Math.max(xPct, minLeft), maxLeft);
      const nextCenter = 100 - right - nextLeft;

      onSizesChange([nextLeft, nextCenter, right]);
    } else {
      const leftSize = currentSizes[0];
      const maxCenter = 100 - leftSize - minRight;
      const nextCenter = Math.min(Math.max(xPct - leftSize, minCenter), maxCenter);
      const nextRight = 100 - leftSize - nextCenter;

      onSizesChange([leftSize, nextCenter, nextRight]);
    }
  };

  const handlePointerDown = (
    handle: 1 | 2,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      handle,
      pointerId: event.pointerId,
    };
    setDragHandle(handle);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopDragging();
  };

  useEffect(() => {
    window.addEventListener("blur", stopDragging);
    return () => {
      window.removeEventListener("blur", stopDragging);
      stopDragging();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="grid h-full min-h-0 w-full grid-rows-[minmax(0,1fr)]"
      style={{ gridTemplateColumns: templateColumns }}
    >
      <div className="h-full min-h-0 min-w-0">{left}</div>
      <Handle
        ariaLabel={handleLabel}
        onPointerDown={(event) => handlePointerDown(1, event)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={stopDragging}
        onPointerEnter={() => setHoverHandle(1)}
        onPointerLeave={() => setHoverHandle((current) => (current === 1 ? null : current))}
        active={dragHandle === 1}
        hovering={hoverHandle === 1}
      />
      <div className="h-full min-h-0 min-w-0">{center}</div>
      <Handle
        ariaLabel={handleLabel}
        onPointerDown={(event) => handlePointerDown(2, event)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={stopDragging}
        onPointerEnter={() => setHoverHandle(2)}
        onPointerLeave={() => setHoverHandle((current) => (current === 2 ? null : current))}
        active={dragHandle === 2}
        hovering={hoverHandle === 2}
      />
      <div className="h-full min-h-0 min-w-0">{right}</div>
    </div>
  );
}

function Handle({
  ariaLabel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onPointerEnter,
  onPointerLeave,
  active,
  hovering,
}: {
  ariaLabel: string;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onLostPointerCapture: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  active: boolean;
  hovering: boolean;
}) {
  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="relative z-10 h-full w-0 cursor-col-resize"
    >
      <div className="absolute inset-y-0 -left-[6px] w-3" />
      <div
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/8 transition-colors duration-150",
          (active || hovering) && "bg-sky-400/70",
        )}
      />
    </div>
  );
}
