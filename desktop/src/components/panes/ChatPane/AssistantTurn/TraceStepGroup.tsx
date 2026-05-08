import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Loader2,
} from "lucide-react";
import {
  ExecutionTimelineThinkingEntry,
  TraceTimelineStepEntry,
} from "./status";
import type {
  ChatExecutionTimelineItem,
  ChatTraceStepStatus,
} from "../types";

function traceStatusLabel(status: ChatTraceStepStatus) {
  if (status === "completed") {
    return "Completed";
  }
  if (status === "error") {
    return "Error";
  }
  if (status === "waiting") {
    return "Waiting";
  }
  return "In progress";
}

function summarizeThinking(text: string) {
  const firstContentLine =
    text
      .split("\n")
      .map((line) => line.replace(/[*_`#>-]/g, "").trim())
      .find(Boolean) || "Reasoning available";

  return firstContentLine.length > 88
    ? `${firstContentLine.slice(0, 85).trimEnd()}...`
    : firstContentLine;
}

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
  const [groupExpanded, setGroupExpanded] = useState(
    live && !liveOutputStarted,
  );
  const previousLiveRef = useRef(live);
  const previousLiveOutputStartedRef = useRef(liveOutputStarted);
  const previousForceExpandTokenRef = useRef(forceExpandToken);

  useEffect(() => {
    if (forceExpandToken !== previousForceExpandTokenRef.current) {
      previousForceExpandTokenRef.current = forceExpandToken;
      if (forceExpandToken > 0) {
        setGroupExpanded(true);
      }
    }
  }, [forceExpandToken]);

  useEffect(() => {
    if (live && !previousLiveRef.current) {
      setGroupExpanded(!liveOutputStarted);
    }
    if (live && liveOutputStarted && !previousLiveOutputStartedRef.current) {
      setGroupExpanded(false);
    }
    previousLiveRef.current = live;
    previousLiveOutputStartedRef.current = liveOutputStarted;
  }, [live, liveOutputStarted]);
  const runningCount = steps.filter((s) => s.status === "running").length;
  const terminalErrorCount = steps.filter(
    (step) => step.kind === "phase" && step.status === "error",
  ).length;
  const groupHasTerminalError = terminalErrorCount > 0;
  const stepCount = steps.length;
  const stepLabel = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
  const activeStep =
    [...steps]
      .reverse()
      .find((step) => step.status === "running" || step.status === "waiting") ??
    null;
  const groupIsLive = live && activeStep !== null && !groupHasTerminalError;
  const latestStep = steps.length > 0 ? steps[steps.length - 1] : null;
  const latestThinkingItem =
    [...items]
      .reverse()
      .find(
        (
          item,
        ): item is Extract<ChatExecutionTimelineItem, { kind: "thinking" }> =>
          item.kind === "thinking",
      ) ?? null;
  const summaryStep = activeStep ?? (groupIsLive ? latestStep : null);
  const summarySuffix = groupHasTerminalError
    ? ` (${terminalErrorCount} failed)`
    : "";
  const showLiveSummarySpinner =
    (groupIsLive || runningCount > 0) && !groupExpanded;
  const summaryLabel = summaryStep
    ? summaryStep === activeStep || summaryStep.status === "waiting"
      ? `${traceStatusLabel(summaryStep.status)}: ${summaryStep.title}`
      : groupIsLive
        ? summaryStep.title
        : `${traceStatusLabel(summaryStep.status)}: ${summaryStep.title}`
    : groupIsLive
      ? latestThinkingItem
        ? summarizeThinking(latestThinkingItem.text)
        : stepCount > 0
          ? `Working through ${stepLabel}...`
          : "Thinking..."
      : runningCount > 0
        ? `Running ${stepLabel}...`
        : latestThinkingItem
          ? summarizeThinking(latestThinkingItem.text)
          : stepCount > 0 && latestStep
            ? latestStep.title
            : "Execution trace";

  return (
    <div className="mt-3 first:mt-0">
      <button
        type="button"
        onClick={() => setGroupExpanded((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 -ml-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
      >
        {groupHasTerminalError ? (
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
        ) : showLiveSummarySpinner ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : groupIsLive || runningCount > 0 ? (
          <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Check className="size-3.5 shrink-0 text-success" />
        )}
        <span className="min-w-0 flex-1 truncate leading-5">
          {summaryLabel}
          {summarySuffix}
        </span>
        {stepCount > 0 && !groupIsLive && !groupHasTerminalError ? (
          <span
            aria-hidden
            className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] tabular-nums text-muted-foreground"
          >
            {stepCount}
          </span>
        ) : null}
        <ChevronDown
          className={`size-3 shrink-0 transition-transform ${groupExpanded ? "rotate-180" : ""}`}
        />
      </button>

      {groupExpanded ? (
        <div className="mt-1 ml-1 space-y-0.5">
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
      ) : null}
    </div>
  );
}
