import { useState } from "react";
import { ChevronRight, CircleAlert } from "@/components/ui/icons";
import { humanizeAgentError } from "@/lib/humanizeAgentError";
import { cn } from "@/lib/utils";

interface ErrorSegmentProps {
  /** Raw failure text as persisted on the message. */
  text: string;
  className?: string;
}

/** A failed run, told to a human: a calm one-line explanation with the raw
 *  runtime error tucked behind a collapsed "Show details" disclosure. */
export function ErrorSegment({ text, className }: ErrorSegmentProps) {
  const [expanded, setExpanded] = useState(false);
  const { headline, details } = humanizeAgentError(text);

  return (
    <div
      className={cn(
        "mt-2 first:mt-0 rounded-xl border border-destructive/25 bg-destructive/[0.04] px-3 py-2.5",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <CircleAlert
          className="mt-0.5 size-4 shrink-0 text-destructive"
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground leading-relaxed">{headline}</p>
          {details ? (
            <>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    "size-3 transition-transform",
                    expanded && "rotate-90",
                  )}
                  strokeWidth={2}
                />
                {expanded ? "Hide details" : "Show details"}
              </button>
              {expanded ? (
                <pre className="mt-1.5 overflow-x-auto rounded-lg bg-fg-4 px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                  {text}
                </pre>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
