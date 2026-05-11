import { ChevronRight, Loader2, RotateCw, Server } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";

interface RuntimeStatusIndicatorProps {
  status: RuntimeStatusPayload | null;
}

interface StatusVisual {
  /** StatusDot variant + pulse — driven by runtime state. */
  dotVariant: "success" | "destructive" | "warning" | "muted";
  dotPulse: boolean;
  label: string;
  /** One-line plain-English description shown in the popover body. */
  description: string;
  /** True when restarting from this state is a sensible recovery. */
  recoverable: boolean;
}

export function runtimeStatusVisual(status: RuntimeStatus | undefined): StatusVisual {
  switch (status) {
    case "running":
      return {
        dotVariant: "success",
        dotPulse: false,
        label: "Runtime running",
        description: "Everything's running smoothly.",
        recoverable: false,
      };
    case "starting":
      return {
        dotVariant: "warning",
        dotPulse: true,
        label: "Runtime starting",
        description: "Just a moment — the local runtime is coming online.",
        recoverable: false,
      };
    case "error":
      return {
        dotVariant: "destructive",
        dotPulse: false,
        label: "Runtime error",
        description: "Holaboss couldn't reach the local runtime.",
        recoverable: true,
      };
    case "missing":
      return {
        dotVariant: "destructive",
        dotPulse: false,
        label: "Runtime missing",
        description:
          "Some files Holaboss needs aren't in place. Try restarting; reinstall if it keeps failing.",
        recoverable: true,
      };
    case "stopped":
      return {
        dotVariant: "muted",
        dotPulse: false,
        label: "Runtime stopped",
        description: "The local runtime isn't running right now.",
        recoverable: true,
      };
    case "disabled":
      return {
        dotVariant: "muted",
        dotPulse: false,
        label: "Runtime disabled",
        description: "Local runtime is turned off in your settings.",
        recoverable: false,
      };
    default:
      return {
        dotVariant: "muted",
        dotPulse: false,
        label: "Runtime unknown",
        description: "Runtime state isn't reporting yet.",
        recoverable: false,
      };
  }
}

export function RuntimeStatusIndicator({
  status,
}: RuntimeStatusIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  if (!status) {
    return null;
  }
  // Hide the bar button entirely when the runtime is healthy. The avatar
  // dropdown footer always carries a quieter copy of the same info, so users
  // who specifically want to confirm "all green" can still find it there.
  if (status.status === "running") {
    return null;
  }

  const visual = runtimeStatusVisual(status.status);
  const detail = status.lastError.trim();

  // Engineer-facing rows — hidden behind the disclosure so a normal user
  // doesn't see "PID 99601" floating on its own with no context.
  const techRows: Array<[string, string]> = [];
  if (typeof status.pid === "number") {
    techRows.push(["PID", String(status.pid)]);
  }
  techRows.push(["Browser", status.desktopBrowserReady ? "ready" : "pending"]);

  const detailsDefaultOpen = Boolean(import.meta.env.DEV);

  async function handleRestart() {
    if (isRestarting) {
      return;
    }
    setIsRestarting(true);
    try {
      await window.electronAPI.runtime.restart();
    } catch {
      // Status feed will repaint with the fresh error message; nothing to do.
    } finally {
      setIsRestarting(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            aria-label={visual.label}
            className="relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-fg-6 px-2 text-xs tracking-tight transition"
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <Server className="size-3.5" strokeWidth={1.8} />
            <StatusDot
              variant={visual.dotVariant}
              pulse={visual.dotPulse}
              className="absolute -right-0.5 -top-0.5 ring-2 ring-background"
            />
          </Button>
        }
      />
      <PopoverContent
        align="end"
        className="w-72 rounded-lg p-0 shadow-xs ring-0"
        side="bottom"
        sideOffset={8}
      >
        <div className="space-y-2 px-3.5 pt-3.5 pb-3">
          <div className="flex items-center gap-2">
            <StatusDot
              variant={visual.dotVariant}
              pulse={visual.dotPulse}
              size="md"
            />
            <span className="text-sm font-medium text-foreground">
              {visual.label}
            </span>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {visual.description}
          </p>
        </div>

        {visual.recoverable ? (
          <div className="px-3.5 pb-3">
            <Button
              className="w-full"
              disabled={isRestarting}
              onClick={() => void handleRestart()}
              size="sm"
              type="button"
            >
              {isRestarting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RotateCw />
              )}
              Restart runtime
            </Button>
          </div>
        ) : null}

        {detail || techRows.length > 0 ? (
          <details
            className="group border-t border-border px-3.5 py-2.5"
            open={detailsDefaultOpen}
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="size-3 transition-transform group-open:rotate-90"
              />
              Show technical details
            </summary>
            <div className="mt-2 space-y-2">
              {techRows.length > 0 ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {techRows.map(([key, value]) => (
                    <div className="contents" key={key}>
                      <dt className="text-muted-foreground">{key}</dt>
                      <dd className="truncate font-medium tabular-nums">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {detail ? (
                <pre className="overflow-auto rounded-md bg-fg-2 px-2 py-1.5 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-foreground/85">
                  {detail}
                </pre>
              ) : null}
            </div>
          </details>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
