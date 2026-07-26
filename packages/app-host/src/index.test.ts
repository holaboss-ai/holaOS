import { afterEach, describe, expect, it } from "bun:test";

import { host, HostUnavailableError } from "./index.ts";
import { BRIDGE_VERSION, HOST_GLOBAL_KEY, HOST_OPS } from "./protocol.ts";

// biome-ignore lint/suspicious/noExplicitAny: test harness pokes the global
const g = globalThis as any;

function setHost(impl: unknown): void {
  g.window = g.window ?? {};
  g.window[HOST_GLOBAL_KEY] = impl;
}
function clearHost(): void {
  if (g.window) {
    g.window[HOST_GLOBAL_KEY] = undefined;
  }
}

afterEach(clearHost);

describe("host — no desktop", () => {
  it("isAvailable() is false without the bridge", () => {
    clearHost();
    expect(host.isAvailable()).toBe(false);
  });

  it("capabilities() returns [] without the bridge", async () => {
    expect(await host.capabilities()).toEqual([]);
  });

  it("chat.start rejects with HostUnavailableError without the bridge", async () => {
    await expect(host.chat.start({ prompt: "hi" })).rejects.toBeInstanceOf(
      HostUnavailableError,
    );
  });

  it("ignores an incompatible (older) bridge version", () => {
    setHost({
      version: BRIDGE_VERSION - 1,
      capabilities: () => Promise.resolve([]),
      invoke: () => Promise.resolve({ ok: true, data: {} }),
    });
    expect(host.isAvailable()).toBe(false);
  });

  it("employees.changed is a silent no-op without the bridge", async () => {
    clearHost();
    await expect(host.employees.changed()).resolves.toBeUndefined();
  });
});

describe("host — desktop present", () => {
  it("detects the bridge and forwards chat.start", async () => {
    let sawOp = "";
    let sawPayload: unknown = null;
    setHost({
      version: BRIDGE_VERSION,
      capabilities: () => Promise.resolve([HOST_OPS.chatStart]),
      invoke: (op: string, payload: unknown) => {
        sawOp = op;
        sawPayload = payload;
        return Promise.resolve({ ok: true, data: { sessionId: "s1" } });
      },
    });
    expect(host.isAvailable()).toBe(true);
    expect(await host.capabilities()).toEqual(["chat.start"]);
    expect(await host.chat.start({ prompt: "hi" })).toEqual({ sessionId: "s1" });
    expect(sawOp).toBe("chat.start");
    expect(sawPayload).toEqual({ prompt: "hi" });
  });

  it("chat.start throws the op's error on ok:false", async () => {
    setHost({
      version: BRIDGE_VERSION,
      capabilities: () => Promise.resolve([]),
      invoke: () =>
        Promise.resolve({ ok: false, error: "nope", code: "unsupported_op" }),
    });
    await expect(host.chat.start({ prompt: "hi" })).rejects.toThrow("nope");
  });

  it("employees.changed forwards the op with its reason", async () => {
    let sawOp = "";
    let sawPayload: unknown = null;
    setHost({
      version: BRIDGE_VERSION,
      capabilities: () => Promise.resolve([HOST_OPS.employeesChanged]),
      invoke: (op: string, payload: unknown) => {
        sawOp = op;
        sawPayload = payload;
        return Promise.resolve({ ok: true, data: {} });
      },
    });
    await host.employees.changed({ reason: "created" });
    expect(sawOp).toBe("employees.changed");
    expect(sawPayload).toEqual({ reason: "created" });
  });

  it("employees.changed swallows a host error (never rejects)", async () => {
    setHost({
      version: BRIDGE_VERSION,
      capabilities: () => Promise.resolve([]),
      invoke: () => Promise.reject(new Error("boom")),
    });
    await expect(host.employees.changed()).resolves.toBeUndefined();
  });
});
