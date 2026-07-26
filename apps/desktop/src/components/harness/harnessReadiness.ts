import { atom, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useCallback } from "react";

/**
 * Persisted per-harness "readiness" — the missing dimension between "installed"
 * (binary on PATH → the runtime's `available` flag) and "actually usable"
 * (authenticated + a model configured).
 *
 * The runtime only reports PATH detection; it can't tell whether e.g. `codex` is
 * logged in. We derive readiness from real outcomes — a connection test today,
 * and (future) live-run results — and persist it locally so the picker and
 * Settings can badge "Ready" vs "Needs setup" without re-probing every render.
 *
 * Keyed by harness id and stored at the machine level (NOT per workspace): CLI
 * auth is a user/machine property, identical across workspaces.
 */
export type HarnessReadinessStatus = "ready" | "needs_setup";

export interface HarnessReadinessRecord {
  status: HarnessReadinessStatus;
  /** Short reason/snippet from the outcome that set this (for tooltips). */
  detail?: string;
  /** ISO timestamp of the outcome that set this. */
  at: string;
}

const harnessReadinessAtom = atomWithStorage<Record<string, HarnessReadinessRecord>>(
  "holaboss.harnessReadiness.v1",
  {},
);

export interface HarnessReadinessApi {
  /** Readiness for a harness, or null if never verified. */
  get: (id: string | null | undefined) => HarnessReadinessRecord | null;
  /** Record the outcome of a connection test / real run. */
  record: (id: string, status: HarnessReadinessStatus, detail?: string) => void;
}

/**
 * Sort key shared by every agent list (Settings, composer picker, automation
 * selector) so ordering is identical everywhere: usable agents first —
 * Built-in → Ready → Installed → Needs setup → Unavailable.
 */
export function harnessStatusRank(
  entry: HarnessAvailabilityEntryPayload,
  readiness: HarnessReadinessRecord | null,
): number {
  if (entry.detection === "in-process") return 0; // built-in (Hola)
  if (!entry.available) return 4; // not installed
  if (readiness?.status === "ready") return 1;
  if (readiness?.status === "needs_setup") return 3;
  return 2; // installed, untested
}

/**
 * Status-sorted copy of a harness list. Stable (Array.sort) so agents in the
 * same status keep their incoming/registry order.
 */
export function sortHarnessesByStatus<T extends HarnessAvailabilityEntryPayload>(
  harnesses: readonly T[],
  getReadiness: (id: string | null | undefined) => HarnessReadinessRecord | null,
): T[] {
  return [...harnesses].sort(
    (a, b) =>
      harnessStatusRank(a, getReadiness(a.id)) -
      harnessStatusRank(b, getReadiness(b.id)),
  );
}

/**
 * Session-scoped "a connection test is currently running" flags, keyed by
 * harness id. Deliberately NOT persisted (`atom`, not `atomWithStorage`): a
 * test's in-flight IPC promise can't survive an app restart, so a stale "true"
 * would strand the button on "Testing…" forever.
 *
 * It IS atom-backed rather than component-local so the "Testing…" spinner
 * survives navigating away from Settings and back while the test runs. The
 * runtime test isn't tied to the renderer — the IPC await keeps resolving after
 * the button unmounts — so the run's `finally` clears this flag (and `onResult`
 * records the outcome) even for an orphaned promise; this just keeps the UI in
 * sync when the button remounts.
 */
const harnessTestingAtom = atom<Record<string, true>>({});

export interface HarnessTestingApi {
  /** Whether a connection test is currently running for this harness. */
  isTesting: (id: string | null | undefined) => boolean;
  /** Mark a harness's connection test as started/finished. */
  setTesting: (id: string, testing: boolean) => void;
}

export function useHarnessTesting(): HarnessTestingApi {
  const [byId, setById] = useAtom(harnessTestingAtom);

  const isTesting = useCallback(
    (id: string | null | undefined): boolean =>
      typeof id === "string" ? Boolean(byId[id]) : false,
    [byId],
  );

  const setTesting = useCallback(
    (id: string, testing: boolean) => {
      const key = id.trim();
      if (!key) return;
      setById((prev) => {
        if (testing) {
          return prev[key] ? prev : { ...prev, [key]: true };
        }
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [setById],
  );

  return { isTesting, setTesting };
}

export function useHarnessReadiness(): HarnessReadinessApi {
  const [byId, setById] = useAtom(harnessReadinessAtom);

  const get = useCallback(
    (id: string | null | undefined): HarnessReadinessRecord | null => {
      const key = typeof id === "string" ? id : "";
      return key ? (byId[key] ?? null) : null;
    },
    [byId],
  );

  const record = useCallback(
    (id: string, status: HarnessReadinessStatus, detail?: string) => {
      const key = id.trim();
      if (!key) return;
      setById((prev) => ({
        ...prev,
        [key]: {
          status,
          ...(detail ? { detail: detail.slice(0, 300) } : {}),
          at: new Date().toISOString(),
        },
      }));
    },
    [setById],
  );

  return { get, record };
}
