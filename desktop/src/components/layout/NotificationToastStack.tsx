import { useState } from "react";
import {
  ArrowUpRight,
  Bell,
  CircleCheck,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NotificationToastStackProps {
  leadingToast?: React.ReactNode;
  notifications: RuntimeNotificationRecordPayload[];
  onCloseToast: (notificationId: string) => void;
  onActivateNotification: (notificationId: string) => void;
  className?: string;
  style?: React.CSSProperties;
}

const COLLAPSED_TOAST_OFFSET_PX = 4;
const COLLAPSED_TOAST_MAX_HEIGHT_PX = 76;
const COLLAPSED_TOAST_PEEK_PX = 10;
const EXPANDED_TOAST_GAP_PX = 12;

function toastAccentClassName(level: RuntimeNotificationLevel): string {
  if (level === "success") {
    return "bg-success/10 text-success ring-success/30";
  }
  if (level === "warning") {
    return "bg-warning/10 text-warning ring-warning/30";
  }
  if (level === "error") {
    return "bg-destructive/10 text-destructive ring-destructive/30";
  }
  return "bg-info/15 text-info ring-info/30";
}

function toastIcon(level: RuntimeNotificationLevel): React.ReactNode {
  if (level === "success") {
    return <CircleCheck size={16} />;
  }
  if (level === "warning") {
    return <TriangleAlert size={16} />;
  }
  if (level === "error") {
    return <XCircle size={16} />;
  }
  return <Bell size={16} />;
}

function notificationTargetSessionId(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  const raw = notification.metadata.session_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function toastCardStyle(
  index: number,
  total: number,
  isExpanded: boolean,
): React.CSSProperties {
  const collapsedScale = Math.max(0.97, 1 - index * 0.01);
  const collapsedOpacity = Math.max(0.78, 1 - index * 0.08);
  return {
    marginTop:
      index === 0
        ? 0
        : isExpanded
          ? EXPANDED_TOAST_GAP_PX
          : -(COLLAPSED_TOAST_MAX_HEIGHT_PX - COLLAPSED_TOAST_PEEK_PX),
    transform: isExpanded
      ? "translateY(0px) scale(1)"
      : `translateY(${index * COLLAPSED_TOAST_OFFSET_PX}px) scale(${collapsedScale})`,
    opacity: isExpanded ? 1 : collapsedOpacity,
    maxHeight:
      isExpanded || index === 0 ? "320px" : `${COLLAPSED_TOAST_MAX_HEIGHT_PX}px`,
    zIndex: total - index,
  };
}

export function NotificationToastStack({
  leadingToast = null,
  notifications,
  onCloseToast,
  onActivateNotification,
  className,
  style,
}: NotificationToastStackProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!leadingToast && notifications.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "pointer-events-none fixed right-4 top-4 z-[90] flex w-[min(320px,calc(100vw-2rem))] flex-col gap-3 sm:right-6 sm:top-6",
        className,
      )}
      style={style}
    >
      {leadingToast}
      {notifications.length > 0 ? (
        <div
          aria-expanded={isExpanded}
          className="pointer-events-auto flex flex-col"
          onMouseEnter={() => setIsExpanded(true)}
          onMouseLeave={() => setIsExpanded(false)}
          onFocusCapture={() => setIsExpanded(true)}
          onBlurCapture={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            ) {
              return;
            }
            setIsExpanded(false);
          }}
        >
          {notifications.map((notification, index) => {
            const targetSessionId = notificationTargetSessionId(notification);
            const isSessionTarget = Boolean(targetSessionId);
            const isCollapsedBackgroundToast = !isExpanded && index > 0;
            const content = (
              <>
                <div className="text-base font-semibold leading-tight text-foreground">
                  {notification.title}
                </div>
                <p className="mt-1 text-[13px] leading-[1.2rem] text-foreground">
                  {notification.message}
                </p>
              </>
            );

            return (
              <div
                key={notification.id}
                className={cn(
                  "overflow-hidden rounded-3xl border border-border bg-popover/95 ring-1 ring-border backdrop-blur-xl animate-in fade-in-0 slide-in-from-top-2 transition-[margin,transform,opacity,max-height] duration-200 ease-out",
                  isCollapsedBackgroundToast
                    ? "pointer-events-none shadow-lg"
                    : "shadow-2xl",
                )}
                style={toastCardStyle(index, notifications.length, isExpanded)}
              >
                {isCollapsedBackgroundToast ? (
                  <div aria-hidden="true" className="h-[76px]" />
                ) : (
                  <div className="flex items-start gap-2.5 p-3.5">
                    <div
                      className={cn(
                        "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl ring-1",
                        toastAccentClassName(notification.level),
                      )}
                    >
                      {toastIcon(notification.level)}
                    </div>
                    <div className="min-w-0 flex-1">
                      {isSessionTarget ? (
                        <div className="min-w-0 text-left">{content}</div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onActivateNotification(notification.id)}
                          className="min-w-0 text-left"
                        >
                          {content}
                        </button>
                      )}
                      {isSessionTarget ? (
                        <div className="mt-2.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => onActivateNotification(notification.id)}
                          >
                            <ArrowUpRight size={14} />
                            View session
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Dismiss notification ${notification.title}`}
                      onClick={() => onCloseToast(notification.id)}
                      className="mt-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X size={14} />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
