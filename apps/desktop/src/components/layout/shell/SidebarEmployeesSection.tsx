// Sidebar section: the active-org HolaEmployee roster. Each employee has ONE session —
// clicking a row opens that single (per-user, private) conversation directly in the
// dedicated streaming chat pane (selectedEmployeeAtom → AppShell mounts EmployeeChatPane).
// There's no thread list and no way to start additional sessions. Separate from the runtime
// "Sessions" list — these are server-side employees reached over the gateway.

import { useAtomValue, useSetAtom } from "jotai";
import { type ReactNode, useCallback, useEffect } from "react";

import { EmployeeAvatar } from "@/features/employees/EmployeeAvatar";
import { useHolaEmployees } from "@/features/employees/useEmployees";
import { Skeleton } from "@/components/ui/skeleton";
import { type SelectedEmployee, selectedEmployeeAtom } from "./state/employees";
import {
  activeWebAppSurfaceAtom,
  projectViewAtom,
  workspaceOverlayAtom,
} from "./state/ui";

// Short relative time for a roster row ("now" / "5m" / "2h" / "3d").
function relativeTimeShort(value?: string | null): string {
  if (!value) {
    return "";
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 60) {
    return "now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Selecting an employee is a primary destination — it must take over the whole
 * main area. The other primary surfaces (a workspace overlay like HolaHub/Home,
 * a project view, an open HolaApp surface) early-return in ShellMainArea BEFORE
 * the employee chat mounts, so clear them here. ShellMainArea then symmetrically
 * clears the selected employee when one of those surfaces re-opens.
 */
function useSelectEmployee() {
  const setSelected = useSetAtom(selectedEmployeeAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  return useCallback(
    (sel: SelectedEmployee) => {
      setWorkspaceOverlay(null);
      setProjectView(null);
      setActiveWebAppSurface(null);
      setSelected(sel);
    },
    [setSelected, setWorkspaceOverlay, setProjectView, setActiveWebAppSurface],
  );
}

// A labeled roster group ("Employees" / "Shared with you") wrapping its rows.
function EmployeeGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="truncate px-2 pb-0.5 font-medium text-[11px] text-foreground-tertiary uppercase tracking-wide">
        {label}
      </div>
      {children}
    </div>
  );
}

// One roster row: avatar + name + last-activity time + last-message preview.
function EmployeeRow({
  emp,
  selected,
  onOpen,
}: {
  emp: HolaEmployeeSummaryPayload;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      className={`flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
        selected ? "bg-foreground/[0.07]" : "hover:bg-muted"
      }`}
      onClick={onOpen}
      type="button"
    >
      <EmployeeAvatar
        avatar={emp.avatar}
        className="size-9 rounded-full text-base"
        name={emp.name}
        preset={emp.preset}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-sm ${
              selected ? "font-medium text-foreground" : "text-foreground"
            }`}
          >
            {emp.name}
          </span>
          {emp.lastActivityAt ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {relativeTimeShort(emp.lastActivityAt)}
            </span>
          ) : null}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {emp.lastMessagePreview ?? "No messages yet"}
        </span>
      </span>
    </button>
  );
}

export function SidebarEmployeesSection() {
  const { data: employees = [], isLoading } = useHolaEmployees();
  const selected = useAtomValue(selectedEmployeeAtom);
  const setSelected = useSetAtom(selectedEmployeeAtom);
  const selectEmployee = useSelectEmployee();

  // Open an employee's single session. Fast path: the roster carries the caller's
  // latest thread (`lastThreadId`), so we open it directly with no per-click
  // listThreads round-trip. If they've never chatted, open the one fresh session on
  // a stable id keyed to the employee. Fallback: an older backend serves
  // `lastActivityAt` but not `lastThreadId` (prod, mid-rollout) — the employee HAS
  // history but we don't know its thread id, so resolve it with listThreads rather
  // than strand that history behind an empty new session.
  const openEmployee = useCallback(
    async (emp: HolaEmployeeSummaryPayload) => {
      if (emp.lastThreadId) {
        selectEmployee({
          employeeId: emp.employeeId,
          name: emp.name,
          threadId: emp.lastThreadId,
          isNew: false,
        });
        return;
      }
      if (!emp.lastActivityAt) {
        selectEmployee({
          employeeId: emp.employeeId,
          name: emp.name,
          threadId: emp.employeeId,
          isNew: true,
        });
        return;
      }
      try {
        const threads = await window.electronAPI.holaemployee.listThreads(
          emp.employeeId,
        );
        const latest =
          threads.length > 0
            ? threads.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
            : null;
        selectEmployee({
          employeeId: emp.employeeId,
          name: emp.name,
          threadId: latest?.threadId ?? emp.employeeId,
          isNew: !latest,
        });
      } catch {
        selectEmployee({
          employeeId: emp.employeeId,
          name: emp.name,
          threadId: emp.employeeId,
          isNew: true,
        });
      }
    },
    [selectEmployee],
  );

  // If the open employee is no longer in the (org-scoped) roster — e.g. after an
  // org switch or a deletion — drop the chat so a stale employee doesn't linger.
  useEffect(() => {
    if (
      selected &&
      !isLoading &&
      !employees.some((e) => e.employeeId === selected.employeeId)
    ) {
      setSelected(null);
    }
  }, [selected, employees, isLoading, setSelected]);

  // While the roster is fetching (cold cache), show a skeleton so switching to
  // Employee mode never flashes a blank column. Once loaded, an empty roster
  // renders nothing — the Home nav above is the create-employees entry point.
  if (isLoading) {
    return (
      <div className="mt-3 flex flex-col gap-0.5 px-2">
        <div className="truncate px-2 pb-0.5 font-medium text-[11px] text-foreground-tertiary uppercase tracking-wide">
          Employees
        </div>
        {["w-20", "w-16", "w-24"].map((w) => (
          <div className="flex items-center gap-2.5 px-2 py-1.5" key={w}>
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className={`h-3 ${w}`} />
              <Skeleton className="h-2.5 w-full max-w-[8rem]" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (employees.length === 0) {
    return null;
  }

  // Split the caller's OWN employees from ones added via the shared-employee
  // catalogue (the backend tags those `shared: true`). Mirrors the web roster's
  // "Employees" / "Shared with you" split so a shared employee reads distinctly.
  const owned = employees.filter((emp) => emp.shared !== true);
  const shared = employees.filter((emp) => emp.shared === true);

  return (
    <div className="mt-2 flex flex-col gap-3 px-2">
      {owned.length > 0 ? (
        <EmployeeGroup label="Employees">
          {owned.map((emp) => (
            <EmployeeRow
              emp={emp}
              key={emp.employeeId}
              onOpen={() => void openEmployee(emp)}
              selected={selected?.employeeId === emp.employeeId}
            />
          ))}
        </EmployeeGroup>
      ) : null}
      {shared.length > 0 ? (
        <EmployeeGroup label="Shared with you">
          {shared.map((emp) => (
            <EmployeeRow
              emp={emp}
              key={emp.employeeId}
              onOpen={() => void openEmployee(emp)}
              selected={selected?.employeeId === emp.employeeId}
            />
          ))}
        </EmployeeGroup>
      ) : null}
    </div>
  );
}
