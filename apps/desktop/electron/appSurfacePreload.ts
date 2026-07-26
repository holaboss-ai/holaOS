// Preload for the app-surface BrowserView (hosted HolaApp web pages).
//
// Exposes the versioned host bridge `window.__holabossHost`, which
// @holaboss/app-host wraps, so a hosted HolaApp page can request native
// desktop operations (e.g. open a chat with context).
//
// The hosted page is UNTRUSTED web content. This surface is intentionally
// small + allow-listed + versioned, and carries NO app/workspace identity —
// the main process derives that from the BrowserView that sent the message
// (it never trusts ids from the page). Channel/op names come from the shared
// protocol so the two sides cannot drift.
//
// See docs/plans/2026-06-23-holaapp-desktop-host-bridge.md.

import {
  BRIDGE_VERSION,
  HOST_GLOBAL_KEY,
  HOST_IPC,
  type HostOp,
} from "@holaboss/app-host/protocol";
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(HOST_GLOBAL_KEY, {
  version: BRIDGE_VERSION,
  capabilities: (): Promise<HostOp[]> =>
    ipcRenderer.invoke(HOST_IPC.capabilities),
  invoke: (op: string, payload: unknown): Promise<unknown> =>
    ipcRenderer.invoke(HOST_IPC.invoke, { op, payload }),
});

// Tell main the moment this page first paints content, so the surface is revealed
// at first-contentful-paint — like a browser — instead of staying hidden behind
// the "Opening…" spinner until did-finish-load (the whole page + every
// subresource). Re-runs per navigation (the preload re-executes on each document
// load); main scopes the signal to this BrowserView. Channel string is mirrored in
// main.ts (WEB_HOLAAPP_FIRST_PAINT_CHANNEL).
const FIRST_PAINT_CHANNEL = "appSurface:content-painted";
function reportFirstPaint(): void {
  try {
    ipcRenderer.send(FIRST_PAINT_CHANNEL);
  } catch {
    // Best-effort — main falls back to did-finish-load.
  }
}
try {
  const alreadyPainted = performance
    .getEntriesByType("paint")
    .some((entry) => entry.name === "first-contentful-paint");
  if (alreadyPainted) {
    reportFirstPaint();
  } else {
    const observer = new PerformanceObserver((list, obs) => {
      if (
        list.getEntries().some((e) => e.name === "first-contentful-paint")
      ) {
        obs.disconnect();
        reportFirstPaint();
      }
    });
    observer.observe({ type: "paint", buffered: true });
  }
} catch {
  // Paint-timing / PerformanceObserver unavailable in this context — main's
  // did-finish-load fallback still reveals the surface.
}
