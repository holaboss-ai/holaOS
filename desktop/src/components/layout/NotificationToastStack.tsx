import { useState, type CSSProperties } from "react";
import {
  ArrowUpRight,
  Bell,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
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

/** Map a runtime notification level onto the matching token name in our
 *  semantic palette. The notification level uses "error" while our token
 *  name is "destructive"; everything else lines up. */
function toneTokenName(
  level: RuntimeNotificationLevel,
): "destructive" | "info" | "success" | "warning" {
  if (level === "error") return "destructive";
  if (level === "success") return "success";
  if (level === "warning") return "warning";
  return "info";
}

/** Soft tone-tinted left → fading-to-card gradient, mirrors the design
 *  reference. color-mix in oklch keeps the tint perceptually consistent
 *  in both light and dark themes; goes opaque (no opacity hack on a
 *  semantic token). */
function toastGradientStyle(level: RuntimeNotificationLevel): CSSProperties {
  const tone = toneTokenName(level);
  return {
    backgroundImage: `linear-gradient(to right, color-mix(in oklch, var(--${tone}) 9%, var(--card)) 0%, var(--card) 65%)`,
  };
}

function toastIconClassName(level: RuntimeNotificationLevel): string {
  if (level === "success") return "text-success";
  if (level === "warning") return "text-warning";
  if (level === "error") return "text-destructive";
  return "text-info";
}

function toastIcon(level: RuntimeNotificationLevel): React.ReactNode {
  if (level === "success") return <CircleCheck className="size-4" />;
  if (level === "warning") return <TriangleAlert className="size-4" />;
  if (level === "error") return <TriangleAlert className="size-4" />;
  if (level === "info") return <Info className="size-4" />;
  return <Bell className="size-4" />;
}

/** Action-button colour per tone. Error / info get their tone colour;
 *  success / warning get the foreground/background swap because their
 *  hues are too soft to support text legibility on the bg as a CTA.
 *  Mirrors the design reference. */
function toastButtonClassName(level: RuntimeNotificationLevel): string {
  if (level === "error") {
    return "bg-destructive text-destructive-foreground hover:bg-destructive/90";
  }
  if (level === "info") {
    return "bg-info text-white hover:bg-info/90";
  }
  return "bg-foreground text-background hover:bg-foreground/90";
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
        "pointer-events-none fixed right-4 top-4 z-[90] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-3 sm:right-6 sm:top-6",
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
            const cardStyle = {
              ...toastCardStyle(index, notifications.length, isExpanded),
              ...toastGradientStyle(notification.level),
            };

            return (
              <div
                key={notification.id}
                className={cn(
                  "overflow-hidden rounded-2xl border border-border animate-in fade-in-0 slide-in-from-top-2 transition-[margin,transform,opacity,max-height] duration-200 ease-out",
                  isCollapsedBackgroundToast
                    ? "pointer-events-none shadow-md"
                    : "shadow-lg",
                )}
                style={cardStyle}
              >
                {isCollapsedBackgroundToast ? (
                  <div aria-hidden="true" className="h-[76px]" />
                ) : (
                  <div className="flex items-start gap-3 p-3.5">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 shrink-0",
                        toastIconClassName(notification.level),
                      )}
                    >
                      {toastIcon(notification.level)}
                    </span>
                    <div className="min-w-0 flex-1">
                      {isSessionTarget ? (
                        <div className="min-w-0 text-left">
                          <div className="text-sm font-semibold leading-tight text-foreground">
                            {notification.title}
                          </div>
                          <SimpleMarkdown className="hb-toast-message mt-1 text-xs leading-5 text-muted-foreground">
                            {notification.message}
                          </SimpleMarkdown>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onActivateNotification(notification.id)}
                          className="min-w-0 text-left"
                        >
                          <div className="text-sm font-semibold leading-tight text-foreground">
                            {notification.title}
                          </div>
                          <SimpleMarkdown className="hb-toast-message mt-1 text-xs leading-5 text-muted-foreground">
                            {notification.message}
                          </SimpleMarkdown>
                        </button>
                      )}
                      {isSessionTarget ? (
                        <div className="mt-2.5">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => onActivateNotification(notification.id)}
                            className={cn(
                              "h-7 rounded-md px-3 text-xs font-medium shadow-none",
                              toastButtonClassName(notification.level),
                            )}
                          >
                            <ArrowUpRight className="size-3.5" />
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
                      className="-mr-1 -mt-1 text-muted-foreground hover:text-foreground"
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
