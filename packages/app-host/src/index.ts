// @holaboss/app-host — the web-facing client a HolaApp page imports to request
// native desktop operations from the holaOS host.
//
// Safe to import anywhere: when the page is NOT running inside the desktop the
// bridge is absent, `host.isAvailable()` is false, and the ops throw
// HostUnavailableError — gate on isAvailable() and keep a web fallback.
//
// See docs/plans/2026-06-23-holaapp-desktop-host-bridge.md.

import {
  BRIDGE_VERSION,
  type ChatStartInput,
  type ChatStartResult,
  type EmployeesChangedInput,
  type HolabossHost,
  HOST_GLOBAL_KEY,
  HOST_OPS,
  type HostOp,
  type HostResult,
} from "./protocol.ts";

export * from "./protocol.ts";

/** Thrown by a host op when the page is not running inside the desktop host. */
export class HostUnavailableError extends Error {
  constructor() {
    super(
      "Holaboss desktop host is not available — this page is not running inside the holaOS desktop app.",
    );
    this.name = "HostUnavailableError";
  }
}

/** Resolve the injected bridge, or null if absent / version-incompatible. */
function bridge(): HolabossHost | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (window as unknown as Record<string, unknown>)[
    HOST_GLOBAL_KEY
  ];
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as { version?: unknown }).version === "number" &&
    (candidate as { version: number }).version >= BRIDGE_VERSION
  ) {
    return candidate as HolabossHost;
  }
  return null;
}

/** Unwrap a HostResult into a value, throwing a coded Error on `ok:false`. */
async function unwrap<T>(p: Promise<HostResult<T>>): Promise<T> {
  const res = await p;
  if (res.ok) {
    return res.data;
  }
  const err = new Error(res.error) as Error & { code?: string };
  if (res.code !== undefined) {
    err.code = res.code;
  }
  throw err;
}

export const host = {
  /** True when running inside the desktop host (bridge present + compatible). */
  isAvailable(): boolean {
    return bridge() !== null;
  },

  /** Ops this host supports; `[]` when unavailable. Lets apps feature-detect. */
  async capabilities(): Promise<HostOp[]> {
    const b = bridge();
    if (!b) {
      return [];
    }
    try {
      return await b.capabilities();
    } catch {
      return [];
    }
  },

  chat: {
    /** Open/create a desktop chat session, optionally pre-filled with a prompt
     *  and `AppContext` attachments. Throws HostUnavailableError outside the
     *  desktop — gate with `host.isAvailable()` and keep a web fallback. */
    start(input: ChatStartInput): Promise<ChatStartResult> {
      const b = bridge();
      if (!b) {
        return Promise.reject(new HostUnavailableError());
      }
      return unwrap(b.invoke(HOST_OPS.chatStart, input));
    },
  },

  employees: {
    /** Nudge the desktop shell to refetch its HolaEmployee roster after the
     *  `/employees` surface creates / renames / archives an employee. Unlike the
     *  other ops this is a safe fire-and-forget no-op off the desktop (and
     *  swallows host errors), so callers can invoke it unconditionally after a
     *  successful mutation without gating on `host.isAvailable()`. */
    async changed(input: EmployeesChangedInput = {}): Promise<void> {
      const b = bridge();
      if (!b) {
        return;
      }
      try {
        await b.invoke(HOST_OPS.employeesChanged, input);
      } catch {
        // fire-and-forget: a host/transport error must never surface here
      }
    },
  },
};
