import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Loader2,
} from "lucide-react";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { IntegrationErrorBanner } from "../skeletons";
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

  return (
    <div>
      <button
        type="button"
        onClick={() => step.details.length > 0 && onToggleStep(step.id)}
        className={`flex w-full items-start gap-2 rounded-md px-2.5 -ml-2.5 py-1 text-left text-xs transition-colors ${step.details.length > 0 ? "hover:bg-muted cursor-pointer" : "cursor-default"}`}
      >
        <span className="mt-0.5 shrink-0">
          {step.status === "completed" ? (
            <Check className="size-3 text-success" />
          ) : step.status === "error" ? (
            <AlertTriangle className="size-3 text-destructive" />
          ) : step.status === "running" ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <Clock3 className="size-3 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-foreground">{step.title}</span>
          {step.details.length > 0 ? (
            <span className="ml-1.5 text-muted-foreground">
              {step.details[0]}
            </span>
          ) : null}
        </span>
        {step.details.length > 1 ? (
          <ChevronDown
            className={`size-3 mt-0.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        ) : null}
      </button>
      {expanded && step.details.length > 1 ? (
        <div className="ml-6 mt-0.5 mb-1 rounded-md border border-border bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
          {step.details.slice(1).join("\n")}
        </div>
      ) : null}
      {step.status === "error" ? (
        <IntegrationErrorBanner details={step.details} />
      ) : null}
    </div>
  );
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
  return (
    <div className="py-1">
      <div className="-ml-2.5 w-[calc(100%+0.625rem)] rounded-xl border border-border bg-muted px-3.5 py-3">
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
