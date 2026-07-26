import type {
  ChatAssistantSegment,
  ChatExecutionTimelineItem,
  ChatTraceStep,
} from "../types";

export function formatWorkedDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function summarizeThinking(text: string): string {
  const firstContentLine =
    text
      .split("\n")
      .map((line) => line.replace(/[*_`#>-]/g, "").trim())
      .find(Boolean) || "Reasoning available";
  return firstContentLine.length > 88
    ? `${firstContentLine.slice(0, 85).trimEnd()}...`
    : firstContentLine;
}

function collectExecutionItems(
  segments: ChatAssistantSegment[],
): ChatExecutionTimelineItem[] {
  const items: ChatExecutionTimelineItem[] = [];
  for (const segment of segments) {
    if (segment.kind === "execution") {
      items.push(...segment.items);
    }
  }
  return items;
}

function collectTraceSteps(
  items: ChatExecutionTimelineItem[],
): ChatTraceStep[] {
  return items
    .filter(
      (
        item,
      ): item is Extract<ChatExecutionTimelineItem, { kind: "trace_step" }> =>
        item.kind === "trace_step",
    )
    .map((item) => item.step);
}

export interface TurnStatus {
  label: string;
  spinning: boolean;
  tone: "default" | "error";
}

/**
 * The single turn-level status shown once at the top of an assistant turn.
 * A turn interleaves tool phases with narration, so per-phase "Working" /
 * "Worked for Ns" chrome repeats the same turn-wide fact; this collapses it to
 * one anchor. Inline trace groups keep only their own step-count summaries.
 */
export function resolveTurnStatus(
  segments: ChatAssistantSegment[],
  {
    live,
    workedMs,
    statusFallback = "",
  }: { live: boolean; workedMs?: number; statusFallback?: string },
): TurnStatus | null {
  const items = collectExecutionItems(segments);
  const steps = collectTraceSteps(items);
  const terminalErrorCount = steps.filter(
    (step) =>
      step.kind === "phase" && step.status === "error" && !step.recoverable,
  ).length;
  if (terminalErrorCount > 0) {
    return {
      label:
        terminalErrorCount > 1
          ? `Run failed (${terminalErrorCount} steps)`
          : "Run failed",
      spinning: false,
      tone: "error",
    };
  }

  const lastSegment =
    segments.length > 0 ? segments[segments.length - 1] : null;

  if (live) {
    // While the final answer streams, its text (with the live cursor) carries
    // the signal — a top spinner on top of it just double-states "still going".
    if (lastSegment?.kind === "output") {
      return null;
    }
    const activeStep = [...steps]
      .reverse()
      .find((step) => step.status === "running" || step.status === "waiting");
    if (activeStep) {
      return { label: activeStep.title, spinning: true, tone: "default" };
    }
    const latestThinking = [...items]
      .reverse()
      .find(
        (
          item,
        ): item is Extract<ChatExecutionTimelineItem, { kind: "thinking" }> =>
          item.kind === "thinking",
      );
    if (latestThinking) {
      return {
        label: summarizeThinking(latestThinking.text),
        spinning: true,
        tone: "default",
      };
    }
    const fallback = statusFallback.replace(/\.+$/, "").trim();
    return {
      label: fallback || (steps.length > 0 ? "Working" : "Thinking"),
      spinning: true,
      tone: "default",
    };
  }

  const endedWaitingPhase = [...steps]
    .reverse()
    .find((step) => step.kind === "phase" && step.status === "waiting");
  if (endedWaitingPhase) {
    return {
      label:
        endedWaitingPhase.id === "phase:awaiting-user"
          ? "Waiting for your input"
          : "Paused",
      spinning: false,
      tone: "default",
    };
  }
  // Only turns that actually ran tools get a "Worked for" anchor; a plain text
  // reply shouldn't sprout a duration line it never had.
  if (items.length === 0) {
    return null;
  }
  if (workedMs != null && workedMs > 0) {
    return {
      label: `Worked for ${formatWorkedDuration(workedMs)}`,
      spinning: false,
      tone: "default",
    };
  }
  return { label: "Worked", spinning: false, tone: "default" };
}
