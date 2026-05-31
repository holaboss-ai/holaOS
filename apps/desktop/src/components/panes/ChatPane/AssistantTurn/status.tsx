import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Loader2,
} from "lucide-react";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { TraceStepErrorPresentation } from "../skeletons";
import type { ChatTraceStep } from "../types";

export function LiveStatusEllipsis() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center text-muted-foreground"
    >
      <DotmSquare3 dotSize={1} size={10} />
    </span>
  );
}

export function LiveStatusLine({
  label,
  className = "",
}: {
  label: string;
  className?: string;
}) {
  const normalizedLabel = label.replace(/\.+$/, "").trim();
  if (!normalizedLabel) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      key={normalizedLabel}
      className={`flex w-fit items-center gap-1.5 text-xs leading-none text-muted-foreground animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200 ease-out ${className}`.trim()}
    >
      <LiveStatusEllipsis />
      <span>{normalizedLabel}</span>
    </div>
  );
}

export function TraceTimelineStepEntry({
  step,
  collapsedByStepId,
  onToggleStep,
}: {
  step: ChatTraceStep;
  collapsedByStepId: Record<string, boolean>;
  onToggleStep: (stepId: string) => void;
}) {
  const expanded = !(collapsedByStepId[step.id] ?? true);
  const hasDetails = step.details.length > 0;
  const expandable = step.details.length > 1;

  return (
    <div>
      <button
        type="button"
        onClick={() => expandable && onToggleStep(step.id)}
        className={`group/step -ml-2 flex w-full items-center gap-2.5 rounded-md py-1 pl-2 pr-2 text-left text-xs transition-colors ${
          expandable
            ? "cursor-pointer hover:bg-fg-4"
            : hasDetails
              ? "cursor-default"
              : "cursor-default"
        }`}
      >
        <span className="grid size-4 shrink-0 place-items-center">
          {step.status === "completed" ? (
            <Check
              className="size-3 text-success motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-75 motion-safe:duration-200 motion-safe:ease-out"
              key={`completed-${step.id}`}
            />
          ) : step.status === "error" ? (
            <AlertTriangle className="size-3 text-destructive motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150" />
          ) : step.status === "running" ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none" />
          ) : (
            <Clock3 className="size-3 text-muted-foreground" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 font-medium text-foreground">
            {step.title}
          </span>
          {hasDetails ? (
            <span className="min-w-0 truncate text-muted-foreground">
              {step.details[0]}
            </span>
          ) : null}
        </span>
        {expandable ? (
          <ChevronDown
            className={`size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        ) : null}
      </button>
      {expanded && expandable && !suppressLegacyDetails(step) ? (
        <div className="ml-6 mb-1 mt-1 overflow-hidden rounded-lg bg-fg-2 px-3.5 py-2.5 text-xs leading-5 text-muted-foreground">
          <pre className="whitespace-pre-wrap font-sans">
            {step.details.slice(1).join("\n")}
          </pre>
        </div>
      ) : null}
      {step.status === "error" ? (
        <TraceStepErrorPresentation details={step.details} />
      ) : null}
    </div>
  );
}

// For error steps, TraceStepErrorPresentation surfaces the raw text under
// its own "Show technical details" disclosure (GenericToolFailureBanner) or
// hides it entirely when the integration banner takes over — skip the
// legacy collapsed box either way so users don't see two copies of the
// same dump.
function suppressLegacyDetails(step: ChatTraceStep): boolean {
  return step.status === "error";
}

export function ExecutionTimelineThinkingEntry({
  text,
  onLinkClick,
  onLocalLinkClick,
}: {
  text: string;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
}) {
  // Soft tinted surface (no border) so thinking reads as a quoted
  // "this is the agent's inner voice" block rather than a boxed card.
  // Mirrors the Mac-chat reference: rounded pillow + generous padding,
  // structure carried by spacing instead of borders.
  return (
    <div className="py-1.5">
      <div className="rounded-2xl bg-fg-2 px-4 py-3.5">
        <SimpleMarkdown
          className="chat-markdown chat-thinking-markdown max-w-full text-foreground"
          onLinkClick={onLinkClick}
          onLocalLinkClick={onLocalLinkClick}
        >
          {text}
        </SimpleMarkdown>
      </div>
    </div>
  );
}
