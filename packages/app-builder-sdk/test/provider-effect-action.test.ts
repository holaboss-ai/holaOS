import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  createApp,
  providerEffectAction,
  z,
  type BridgeClient,
} from "../src/index.ts"

const provider = {
  id: "gmail",
  baseUrl: "https://example.invalid",
  allowedHosts: [],
} as const

describe("providerEffectAction", () => {
  beforeEach(() => {
    mock.restore()
  })

  afterEach(() => {
    mock.restore()
  })

  test("executes a ready deterministic provider effect and persists success state", async () => {
    const sendMock = mock(async () => ({
      kind: "ok" as const,
      data: { id: "msg-1" },
      status: 200,
    }))
    const bridge: BridgeClient = {
      call: sendMock,
    }

    const app = createApp({ id: "outbound", provider })
    app.connection()
    const draft = app.resource("draft", {
      schema: z.object({
        email: z.string().email(),
        subject: z.string(),
        body: z.string(),
        provider_message_id: z.string().optional(),
        blocker_code: z.string().optional(),
        blocker_message: z.string().optional(),
        failure_code: z.string().optional(),
      }),
      states: ["approved", "send_blocked", "send_failed", "sent"] as const,
      initialState: "approved",
    })

    app.action(draft, "send", providerEffectAction({
      provider: "gmail",
      fromStates: ["approved"],
      toState: "sent",
      blockedState: "send_blocked",
      failedState: "send_failed",
      getStatus: async () => ({ ready: true, issues: [] }),
      buildRequest: ({ row }) => ({
        to: row.email,
        subject: row.subject,
        body: row.body,
      }),
      execute: async ({ bridge, request }) => bridge.call("POST", "/messages/send", request),
      persistSuccess: ({ result }) => ({
        provider_message_id: result.id,
        blocker_code: undefined,
        blocker_message: undefined,
      }),
      deriveExternalId: ({ result }) => result.id,
    }))

    const row = app.createRow(draft, {
      email: "jane@example.com",
      subject: "Hello",
      body: "World",
    })

    const result = await app.runAction({
      actionName: "send",
      rowId: row.id,
      input: {},
      bridge,
    })

    expect(result).toEqual({
      ok: true,
      externalId: "msg-1",
      data: {
        blocked: false,
        provider: "gmail",
        request: {
          to: "jane@example.com",
          subject: "Hello",
          body: "World",
        },
        result: { id: "msg-1" },
        status: 200,
      },
    })
    expect(sendMock).toHaveBeenCalledTimes(1)

    const persisted = app.getRow(draft, row.id)
    expect(persisted?.status).toBe("sent")
    expect(persisted?.provider_message_id).toBe("msg-1")
    expect(persisted?.external_id).toBe("msg-1")
  })

  test("moves to the blocked state instead of delegating when readiness is not ready", async () => {
    const execute = mock(async () => ({
      kind: "ok" as const,
      data: { id: "msg-should-not-send" },
      status: 200,
    }))
    const bridge: BridgeClient = {
      call: execute,
    }

    const app = createApp({ id: "outbound", provider })
    app.connection()
    const draft = app.resource("draft", {
      schema: z.object({
        email: z.string().email(),
        subject: z.string(),
        body: z.string(),
        blocker_code: z.string().optional(),
        blocker_message: z.string().optional(),
      }),
      states: ["approved", "send_blocked", "send_failed", "sent"] as const,
      initialState: "approved",
    })

    app.action(draft, "send", providerEffectAction({
      provider: "gmail",
      fromStates: ["approved"],
      toState: "sent",
      blockedState: "send_blocked",
      failedState: "send_failed",
      getStatus: async () => ({
        ready: false,
        issues: [{
          provider: "gmail",
          integrationKey: "gmail",
          code: "integration_not_connected",
          message: "Connect Gmail to continue.",
        }],
      }),
      buildRequest: ({ row }) => ({
        to: row.email,
        subject: row.subject,
        body: row.body,
      }),
      execute: async ({ bridge, request }) => bridge.call("POST", "/messages/send", request),
      persistBlocked: (blocked) => ({
        blocker_code: blocked.code,
        blocker_message: blocked.message,
      }),
    }))

    const row = app.createRow(draft, {
      email: "jane@example.com",
      subject: "Hello",
      body: "World",
    })

    const result = await app.runAction({
      actionName: "send",
      rowId: row.id,
      input: {},
      bridge,
    })

    expect(result).toEqual({
      ok: true,
      data: {
        blocked: true,
        provider: "gmail",
        blocker: {
          provider: "gmail",
          integrationKey: "gmail",
          code: "integration_not_connected",
          message: "Connect Gmail to continue.",
          source: "readiness",
        },
      },
    })
    expect(execute).not.toHaveBeenCalled()

    const persisted = app.getRow(draft, row.id)
    expect(persisted?.status).toBe("send_blocked")
    expect(persisted?.blocker_code).toBe("integration_not_connected")
    expect(persisted?.blocker_message).toBe("Connect Gmail to continue.")
  })

  test("treats bridge-level auth failures as blocked connection states", async () => {
    const sendMock = mock(async () => ({
      kind: "error" as const,
      code: "not_connected" as const,
      message: "Gmail binding expired.",
      upstreamStatus: 401,
      upstreamBody: { message: "auth failed" },
      reauthUrl: "/integrations/gmail/connect",
    }))
    const bridge: BridgeClient = {
      call: sendMock,
    }

    const app = createApp({ id: "outbound", provider })
    app.connection()
    const draft = app.resource("draft", {
      schema: z.object({
        email: z.string().email(),
        subject: z.string(),
        body: z.string(),
        blocker_code: z.string().optional(),
        blocker_message: z.string().optional(),
      }),
      states: ["approved", "send_blocked", "send_failed", "sent"] as const,
      initialState: "approved",
    })

    app.action(draft, "send", providerEffectAction({
      provider: "gmail",
      fromStates: ["approved"],
      toState: "sent",
      blockedState: "send_blocked",
      failedState: "send_failed",
      getStatus: async () => ({ ready: true, issues: [] }),
      buildRequest: ({ row }) => ({
        to: row.email,
        subject: row.subject,
        body: row.body,
      }),
      execute: async ({ bridge, request }) => bridge.call("POST", "/messages/send", request),
      persistBlocked: (blocked) => ({
        blocker_code: blocked.code,
        blocker_message: blocked.message,
      }),
    }))

    const row = app.createRow(draft, {
      email: "jane@example.com",
      subject: "Hello",
      body: "World",
    })

    const result = await app.runAction({
      actionName: "send",
      rowId: row.id,
      input: {},
      bridge,
    })

    expect(result).toEqual({
      ok: true,
      data: {
        blocked: true,
        provider: "gmail",
        request: {
          to: "jane@example.com",
          subject: "Hello",
          body: "World",
        },
        blocker: {
          provider: "gmail",
          integrationKey: "gmail",
          code: "integration_not_connected",
          message: "Gmail binding expired.",
          source: "bridge",
        },
      },
    })
    expect(sendMock).toHaveBeenCalledTimes(1)

    const persisted = app.getRow(draft, row.id)
    expect(persisted?.status).toBe("send_blocked")
    expect(persisted?.blocker_code).toBe("integration_not_connected")
    expect(persisted?.blocker_message).toBe("Gmail binding expired.")
  })

  test("uses the action-scoped failed state for provider-side failures", async () => {
    const sendMock = mock(async () => ({
      kind: "error" as const,
      code: "validation_failed" as const,
      message: "Recipient rejected.",
      upstreamStatus: 422,
      upstreamBody: { message: "invalid recipient" },
    }))
    const bridge: BridgeClient = {
      call: sendMock,
    }

    const app = createApp({ id: "outbound", provider })
    app.connection()
    const draft = app.resource("draft", {
      schema: z.object({
        email: z.string().email(),
        subject: z.string(),
        body: z.string(),
        failure_code: z.string().optional(),
      }),
      states: ["approved", "send_blocked", "send_failed", "sent"] as const,
      initialState: "approved",
    })

    app.action(draft, "send", providerEffectAction({
      provider: "gmail",
      fromStates: ["approved"],
      toState: "sent",
      blockedState: "send_blocked",
      failedState: "send_failed",
      getStatus: async () => ({ ready: true, issues: [] }),
      buildRequest: ({ row }) => ({
        to: row.email,
        subject: row.subject,
        body: row.body,
      }),
      execute: async ({ bridge, request }) => bridge.call("POST", "/messages/send", request),
      persistFailure: (failure) => ({
        failure_code: failure.code,
      }),
    }))

    const row = app.createRow(draft, {
      email: "jane@example.com",
      subject: "Hello",
      body: "World",
    })

    const result = await app.runAction({
      actionName: "send",
      rowId: row.id,
      input: {},
      bridge,
    })

    expect(result).toEqual({
      fail: {
        code: "validation_failed",
        message: "Recipient rejected.",
      },
    })
    expect(sendMock).toHaveBeenCalledTimes(1)

    const persisted = app.getRow(draft, row.id)
    expect(persisted?.status).toBe("send_failed")
    expect(persisted?.failure_code).toBe("validation_failed")
  })

  test("uses the action-scoped failed state when readiness probing itself fails", async () => {
    const sendMock = mock(async () => ({
      kind: "ok" as const,
      data: { id: "msg-should-not-send" },
      status: 200,
    }))
    const bridge: BridgeClient = {
      call: sendMock,
    }

    const app = createApp({ id: "outbound", provider })
    app.connection()
    const draft = app.resource("draft", {
      schema: z.object({
        email: z.string().email(),
        subject: z.string(),
        body: z.string(),
        failure_code: z.string().optional(),
      }),
      states: ["approved", "send_blocked", "send_failed", "sent"] as const,
      initialState: "approved",
    })

    app.action(draft, "send", providerEffectAction({
      provider: "gmail",
      fromStates: ["approved"],
      toState: "sent",
      blockedState: "send_blocked",
      failedState: "send_failed",
      getStatus: async () => {
        throw new Error("readiness endpoint unavailable")
      },
      buildRequest: ({ row }) => ({
        to: row.email,
        subject: row.subject,
        body: row.body,
      }),
      execute: async ({ bridge, request }) => bridge.call("POST", "/messages/send", request),
      persistFailure: (failure) => ({
        failure_code: failure.code,
      }),
    }))

    const row = app.createRow(draft, {
      email: "jane@example.com",
      subject: "Hello",
      body: "World",
    })

    const result = await app.runAction({
      actionName: "send",
      rowId: row.id,
      input: {},
      bridge,
    })

    expect(result).toEqual({
      fail: {
        code: "integration_readiness_failed",
        message: "readiness endpoint unavailable",
      },
    })
    expect(sendMock).not.toHaveBeenCalled()

    const persisted = app.getRow(draft, row.id)
    expect(persisted?.status).toBe("send_failed")
    expect(persisted?.failure_code).toBe("integration_readiness_failed")
  })
})
