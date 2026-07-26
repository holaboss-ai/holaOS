import { useEffect, useState } from "react";

import { ArrowUp } from "@/components/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { appUpdateReady } from "@/lib/appUpdateReady";
import { cn } from "@/lib/utils";

// The Electron main process owns update checks and background downloads, so
// this button only observes status and triggers install — mounting/unmounting
// never changes updater behavior.
export function UpdateReadyButton({ className }: { className?: string }) {
  const [status, setStatus] = useState<AppUpdateStatusPayload | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const api = window.electronAPI?.appUpdate;
    if (!api) {
      return;
    }
    let cancelled = false;
    void api.getStatus().then((next) => {
      if (!cancelled) {
        setStatus(next);
      }
    });
    const unsubscribe = api.onStateChange((next) => {
      if (!cancelled) {
        setStatus(next);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const ready = appUpdateReady(status);
  if (!ready) {
    return null;
  }

  const install = () => {
    if (installing) {
      return;
    }
    setInstalling(true);
    void window.electronAPI.appUpdate.installNow().catch(() => {
      setInstalling(false);
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={ready.tooltip}
            disabled={installing}
            onClick={install}
            className={cn(
              "window-no-drag grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary transition-colors hover:bg-primary/15 disabled:opacity-60",
              className,
            )}
          />
        }
      >
        <ArrowUp className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="py-1">
        {ready.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
