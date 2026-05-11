import { Bell, Check, X } from "lucide-react";
import { useMemo } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { cn } from "@/lib/utils";

interface NotificationInboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notifications: RuntimeNotificationRecordPayload[];
  workspacesById: Map<string, WorkspaceRecordPayload>;
  onActivate: (notificationId: string) => void;
  onDismiss: (notificationId: string) => void;
  onMarkAllRead: () => void;
}

function formatNotificationRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  const diffMs = Date.now() - parsed;
  if (diffMs < 0) return "now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  return `${wk}w ago`;
}

function levelDotClass(level: RuntimeNotificationLevel): string {
  if (level === "error") return "bg-destructive";
  if (level === "warning") return "bg-warning";
  if (level === "success") return "bg-success";
  return "bg-info";
}

export function NotificationInbox({
  open,
  onOpenChange,
  notifications,
  workspacesById,
  onActivate,
  onDismiss,
  onMarkAllRead,
}: NotificationInboxProps) {
  const count = notifications.length;
  const sorted = useMemo(
    () =>
      [...notifications].sort((a, b) => {
        const ta = Date.parse(a.created_at ?? "") || 0;
        const tb = Date.parse(b.created_at ?? "") || 0;
        return tb - ta;
      }),
    [notifications],
  );

  // Cap badge at 99+ — past that the count itself stops being useful and the
  // pixel space matters more than the precise number.
  const badgeLabel = count > 99 ? "99+" : String(count);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    count > 0
                      ? `Notifications (${count} unread)`
                      : "Notifications"
                  }
                  className="relative"
                >
                  <Bell />
                  {count > 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-medium leading-none text-destructive-foreground tabular-nums"
                    >
                      {badgeLabel}
                    </span>
                  ) : null}
                </Button>
              }
            />
          }
        />
        <TooltipContent side="bottom">
          {count > 0 ? `${count} unread` : "Notifications"}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[380px] gap-0 p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              Notifications
            </span>
            {count > 0 ? (
              <span className="rounded-full bg-fg-6 px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
                {count}
              </span>
            ) : null}
          </div>
          {count > 0 ? (
            <button
              type="button"
              onClick={onMarkAllRead}
              className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <Check className="size-3" />
              Mark all read
            </button>
          ) : null}
        </div>

        {count === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-fg-6 text-muted-foreground">
              <Bell className="size-4" />
            </div>
            <div className="text-sm font-medium text-foreground">
              All caught up
            </div>
            <div className="text-xs text-muted-foreground">
              You'll see reminders and task updates here.
            </div>
          </div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto [overflow-anchor:none]">
            {sorted.map((item) => {
              const workspace = workspacesById.get(item.workspace_id.trim());
              const time = formatNotificationRelativeTime(item.created_at);
              return (
                <div
                  key={item.id}
                  className="group/notification-row relative flex gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0 transition-colors hover:bg-fg-2"
                >
                  <button
                    type="button"
                    onClick={() => onActivate(item.id)}
                    className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                  >
                    {workspace ? (
                      <WorkspaceIcon workspace={workspace} size="sm" />
                    ) : (
                      <div className="grid size-5 shrink-0 place-items-center rounded bg-fg-6 text-muted-foreground">
                        <Bell className="size-3" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className={cn(
                            "inline-block size-1.5 shrink-0 rounded-full",
                            levelDotClass(item.level),
                          )}
                        />
                        <span className="truncate text-xs font-medium text-foreground">
                          {item.title || workspace?.name || "Notification"}
                        </span>
                        {time ? (
                          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                            {time}
                          </span>
                        ) : null}
                      </div>
                      {workspace ? (
                        <div className="truncate text-[10px] text-muted-foreground/70">
                          {workspace.name}
                        </div>
                      ) : null}
                      <div className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
                        {item.message}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={`Dismiss notification ${item.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDismiss(item.id);
                    }}
                    className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-fg-6 hover:text-foreground group-hover/notification-row:opacity-100 focus-visible:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
