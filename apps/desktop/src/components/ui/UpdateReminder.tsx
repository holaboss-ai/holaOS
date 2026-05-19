import {
  Download,
  EyeOff,
  ExternalLink,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface UpdateReminderProps {
  status: AppUpdateStatusPayload;
  onDismiss: () => void;
  onInstallNow: () => void;
  onOpenChangelog: () => void;
}

function releaseVersionLabel(status: AppUpdateStatusPayload) {
  const releaseLabel = status.latestVersion || status.releaseName || "latest";
  const normalized = releaseLabel.trim().replace(/^Holaboss\s+/i, "");
  return normalized || "latest";
}

function conciseErrorHint(error: string) {
  const normalized = error.trim();
  if (!normalized) {
    return null;
  }

  if (
    /code signature at url/i.test(normalized) &&
    /code failed to satisfy specified code requirements/i.test(normalized)
  ) {
    return "This install is unsigned, so macOS blocked the signed update.";
  }

  return normalized;
}

function progressLabel(
  status: AppUpdateStatusPayload,
  progressPercent: number | null,
  hasError: boolean,
) {
  if (hasError) {
    return "Install blocked";
  }
  if (status.downloaded) {
    return "Ready to install";
  }
  if (progressPercent === null) {
    return "Preparing download";
  }
  return `${progressPercent}% downloaded`;
}

export function UpdateReminder({
  status,
  onDismiss,
  onInstallNow,
  onOpenChangelog,
}: UpdateReminderProps) {
  const releaseLabel = releaseVersionLabel(status);
  const hasError = Boolean(status.error.trim());
  const progressPercent =
    typeof status.downloadProgressPercent === "number"
      ? Math.round(status.downloadProgressPercent)
      : null;
  const progressWidth = `${Math.max(progressPercent ?? 8, 8)}%`;
  const toneClassName = hasError
    ? "bg-warning/15 text-warning ring-warning/30"
    : status.downloaded
      ? "bg-success/15 text-success ring-success/30"
      : "bg-info/15 text-info ring-info/30";
  const title = hasError
    ? `Couldn’t install ${releaseLabel}`
    : status.downloaded
      ? `${releaseLabel} ready to install`
      : `Downloading ${releaseLabel}`;
  const errorHint = conciseErrorHint(status.error);
  const shouldShowDismissIcon = status.downloaded || hasError;
  const shouldShowBackgroundAction = !status.downloaded && !hasError;

  return (
    <div className="pointer-events-auto overflow-hidden rounded-3xl border border-border bg-popover/95 shadow-2xl ring-1 ring-border backdrop-blur-xl animate-in fade-in-0 slide-in-from-top-2">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <div
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-2xl ring-1",
            toneClassName,
          )}
        >
          {hasError ? (
            <TriangleAlert size={18} />
          ) : status.downloaded ? (
            <RotateCcw size={18} />
          ) : (
            <Download size={18} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs uppercase text-muted-foreground">
              <span>Desktop update</span>
            </div>
            {shouldShowDismissIcon ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss desktop update"
                onClick={onDismiss}
                className="-mr-1 -mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X size={14} />
              </Button>
            ) : null}
          </div>

          <div className="mt-0.5 text-base font-semibold leading-tight text-foreground">
            {title}
          </div>

          {!status.downloaded ? (
            <div className="mt-2.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-border/45">
                <div
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    hasError ? "bg-warning" : "bg-primary",
                  )}
                  style={{ width: progressWidth }}
                />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {progressLabel(status, progressPercent, hasError)}
              </div>
            </div>
          ) : null}

          {errorHint ? (
            <div className="mt-2.5 rounded-2xl border border-warning/20 bg-warning/8 px-3 py-2 text-xs leading-5 text-warning">
              {errorHint}
            </div>
          ) : null}

          <div className="mt-2.5 flex flex-wrap gap-2">
            {status.downloaded && !hasError ? (
              <Button type="button" size="sm" onClick={onInstallNow}>
                <RotateCcw size={14} />
                Restart
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenChangelog}
            >
              <ExternalLink size={14} />
              Changelog
            </Button>
            {shouldShowBackgroundAction ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onDismiss}
              >
                <EyeOff size={14} />
                Run in background
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
