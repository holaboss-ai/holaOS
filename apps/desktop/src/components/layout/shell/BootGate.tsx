import { type ReactNode, useEffect, useState } from "react";

import { BootSplash } from "@/components/layout/BootSplash";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

const MAINTENANCE_POLL_MS = 1000;
// Fail-open: if the runtime never resolves a status (broken IPC), don't trap the
// user on the splash — hand off to the shell, which surfaces its own error UI.
const UNKNOWN_STATUS_GRACE_MS = 20_000;

/**
 * Holds the app on a full-screen loading screen until the runtime is actually
 * ready to use — through the blocking boot/migration phase AND a heavy first-run
 * retention sweep (shown with live progress). Without this, a first launch on a
 * bloated DB drops the user into a shell that just times out and looks broken.
 *
 * Fail-open by design: it blocks ONLY while the runtime is genuinely starting or
 * a heavy cleanup is draining. Errors, an unreachable maintenance endpoint, a
 * missing IPC, or an unknown status all resolve to "enter the shell", so a
 * glitch can never strand the user here. Entry is latched — once in, a later
 * runtime restart uses the in-shell status banner, not a re-blanked splash.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const { runtimeStatus } = useWorkspaceDesktop();
  const status = runtimeStatus?.status ?? null;

  const [entered, setEntered] = useState(false);
  const [maintenance, setMaintenance] =
    useState<DbMaintenanceStatusPayload | null>(null);
  const [maintenanceChecked, setMaintenanceChecked] = useState(false);
  const [graceElapsed, setGraceElapsed] = useState(false);

  // Fail-open timer for a status that never resolves.
  useEffect(() => {
    const id = window.setTimeout(
      () => setGraceElapsed(true),
      UNKNOWN_STATUS_GRACE_MS,
    );
    return () => window.clearTimeout(id);
  }, []);

  // Once the runtime is up (but before we let the user in), poll the retention
  // sweep so we know whether a heavy first-run cleanup is draining.
  useEffect(() => {
    if (entered || status !== "running") {
      return;
    }
    const getDbMaintenance = window.electronAPI?.runtime?.getDbMaintenance;
    if (!getDbMaintenance) {
      // No IPC (web/dev shell) → never block on maintenance.
      setMaintenanceChecked(true);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const next = await getDbMaintenance();
        if (alive) {
          setMaintenance(next);
        }
      } catch {
        if (alive) {
          setMaintenance(null);
        }
      } finally {
        if (alive) {
          setMaintenanceChecked(true);
        }
      }
    };
    void poll();
    const id = window.setInterval(poll, MAINTENANCE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [entered, status]);

  const maintenanceBlocking = Boolean(
    maintenance && maintenance.heavy && !maintenance.done,
  );

  // Latch entry: block only while genuinely booting or draining a heavy sweep.
  const shouldEnter =
    status === "error" ||
    status === "stopped" ||
    status === "disabled" ||
    status === "missing" ||
    (status === "running" && maintenanceChecked && !maintenanceBlocking) ||
    (status === null && graceElapsed);

  useEffect(() => {
    if (!entered && shouldEnter) {
      setEntered(true);
    }
  }, [entered, shouldEnter]);

  if (entered) {
    return <>{children}</>;
  }

  if (status === "running" && maintenanceBlocking && maintenance) {
    // Unified with the plain splash — same logo + "Holaboss" + dots, just with a
    // progress bar attached below (no distinct "Optimizing storage…" screen).
    return (
      <BootSplash
        progress={{
          done: maintenance.deletedRows,
          total: maintenance.estimatedRows,
        }}
      />
    );
  }

  return (
    <BootSplash
      message={runtimeStatus?.startupMessage?.trim() || ""}
    />
  );
}
