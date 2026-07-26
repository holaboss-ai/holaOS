import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "@/components/ui/icons";
import {
  ExecutionTimelineThinkingEntry,
  TraceTimelineStepEntry,
} from "./status";
import type { ChatExecutionTimelineItem } from "../types";

function traceStepsFromExecutionItems(items: ChatExecutionTimelineItem[]) {
  return items
    .filter(
      (
        item,
      ): item is Extract<ChatExecutionTimelineItem, { kind: "trace_step" }> =>
        item.kind === "trace_step",
    )
    .map((item) => item.step);
}

export function TraceStepGroup({
  items,
  collapsedByStepId,
  onToggleStep,
  live = false,
  liveOutputStarted = false,
  onLinkClick,
  onLocalLinkClick,
  forceExpandToken = 0,
}: {
  items: ChatExecutionTimelineItem[];
  collapsedByStepId: Record<string, boolean>;
  onToggleStep: (stepId: string) => void;
  live?: boolean;
  liveOutputStarted?: boolean;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
  forceExpandToken?: number;
}) {
  const steps = traceStepsFromExecutionItems(items);
  // Default collapsed — even live — so an in-progress turn stays compact.
  // The summary line still reflects live status; users expand to follow.
  const [groupExpanded, setGroupExpanded] = useState(false);
  const previousLiveRef = useRef(live);
  const previousLiveOutputStartedRef = useRef(liveOutputStarted);
  const previousForceExpandTokenRef = useRef(forceExpandToken);
  // Once the user has clicked the chevron during a live session, stop
  // auto-snapping the group on liveOutputStarted transitions. Their
  // explicit toggle wins — the worst feel is collapsing the trace out
  // from under someone who just decided they wanted to follow it.
  // A `forceExpand` action from the assistant footer menu counts as a
  // fresh system request and resets the override.
  const userOverrodeRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Set when the user collapses via the bottom control so we can bring the
  // (now collapsed) summary back into view — otherwise the viewport is left
  // staring at whatever followed the long block.
  const scrollToSummaryRef = useRef(false);

  const handleToggleExpanded = () => {
    userOverrodeRef.current = true;
    setGroupExpanded((v) => !v);
  };

  const handleCollapseFromBottom = () => {
    userOverrodeRef.current = true;
    scrollToSummaryRef.current = true;
    setGroupExpanded(false);
  };

  useLayoutEffect(() => {
    if (!groupExpanded && scrollToSummaryRef.current) {
      scrollToSummaryRef.current = false;
      rootRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [groupExpanded]);

  useEffect(() => {
    if (forceExpandToken !== previousForceExpandTokenRef.current) {
      previousForceExpandTokenRef.current = forceExpandToken;
      if (forceExpandToken > 0) {
        userOverrodeRef.current = false;
        setGroupExpanded(true);
      }
    }
  }, [forceExpandToken]);

  useEffect(() => {
    if (userOverrodeRef.current) {
      previousLiveRef.current = live;
      previousLiveOutputStartedRef.current = liveOutputStarted;
      return;
    }
    if (live && !previousLiveRef.current) {
      setGroupExpanded(false);
    }
    if (live && liveOutputStarted && !previousLiveOutputStartedRef.current) {
      setGroupExpanded(false);
    }
    previousLiveRef.current = live;
    previousLiveOutputStartedRef.current = liveOutputStarted;
  }, [live, liveOutputStarted]);

  // The turn-level anchor owns liveness, duration, and the "Run failed" label;
  // a trace group summarizes only its own steps so those facts never repeat once
  // per phase.
  const stepCount = steps.length;
  const stepLabel = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
  const summaryLabel = stepCount > 0 ? stepLabel : "Details";

  return (
    <div ref={rootRef} className="mt-3 first:mt-0 min-w-0">
      <button
        type="button"
        onClick={handleToggleExpanded}
        className="-ml-2.5 flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground"
      >
        <span className="min-w-0 truncate leading-5 text-muted-foreground">
          {summaryLabel}
        </span>
        <ChevronDown
          className={`size-3 shrink-0 transition-transform ${groupExpanded ? "rotate-180" : ""}`}
        />
      </button>

      <div
        className={`grid transition-[grid-template-rows] duration-snappy ease-out-expo motion-reduce:transition-none ${
          groupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div
          inert={!groupExpanded}
          className={`min-w-0 overflow-hidden transition-opacity duration-snappy ease-out-expo motion-reduce:transition-none ${
            groupExpanded ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="ml-1.5 mt-1.5 space-y-0.5 border-l border-border/60 pl-3.5">
            {items.map((item) =>
              item.kind === "thinking" ? (
                <ExecutionTimelineThinkingEntry
                  key={item.id}
                  text={item.text}
                  onLinkClick={onLinkClick}
                  onLocalLinkClick={onLocalLinkClick}
                />
              ) : (
                <TraceTimelineStepEntry
                  key={item.id}
                  step={item.step}
                  collapsedByStepId={collapsedByStepId}
                  onToggleStep={onToggleStep}
                />
              ),
            )}
          </div>
          <button
            type="button"
            onClick={handleCollapseFromBottom}
            className="mt-1.5 ml-5 flex cursor-pointer items-center gap-1 py-0.5 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <ChevronUp className="size-3 shrink-0" />
            Collapse
          </button>
        </div>
      </div>
    </div>
  );
}
