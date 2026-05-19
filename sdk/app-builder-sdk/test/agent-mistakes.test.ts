// This file proves the agent-error-prevention story is real, on TWO levels:
// - Compile-time: each @ts-expect-error block proves tsc catches the wrong code.
//   If tsc finds no error to suppress, the file fails to compile.
// - Runtime: even if untyped JS slips through, app.action validators throw.
// Both fire together for these tests.

import { describe, test, expect } from "bun:test"
import { createApp, z } from "../src/index.ts"
import { SLACK } from "../reference/slack-messaging/provider.ts"

function freshApp() {
  const app = createApp({ id: "slack", provider: SLACK })
  app.connection()
  const message = app.resource("message", {
    schema: z.object({ text: z.string() }),
    states: ["draft", "sent", "edited", "deleted"] as const,
    initialState: "draft",
  })
  return { app, message }
}

describe("Type system catches agent mistakes at compile time", () => {
  test("correct usage compiles AND runs", () => {
    const { app, message } = freshApp()
    expect(() => {
      app.action(message, "send", {
        fromStates: ["draft"],
        toState: "sent",
        run: async () => ({ ok: true }),
      })
    }).not.toThrow()
  })

  test("toState outside resource alphabet — caught at compile + runtime", () => {
    const { app, message } = freshApp()
    expect(() => {
      app.action(message, "bad1", {
        fromStates: ["draft"],
        // @ts-expect-error 'published' is not in message.states
        toState: "published",
        run: async () => ({ ok: true }),
      })
    }).toThrow(/toState.*not in/)
  })

  test("fromStates typo — caught at compile + runtime", () => {
    const { app, message } = freshApp()
    expect(() => {
      app.action(message, "bad2", {
        // @ts-expect-error 'darft' is a typo
        fromStates: ["darft"],
        toState: "sent",
        run: async () => ({ ok: true }),
      })
    }).toThrow(/fromStates.*not in/)
  })

  test("reversible.toState outside alphabet — caught at compile + runtime", () => {
    const { app, message } = freshApp()
    expect(() => {
      app.action(message, "bad3", {
        fromStates: ["draft"],
        toState: "sent",
        reversible: {
          // @ts-expect-error 'cancelled' not declared
          toState: "cancelled",
          run: async () => ({ ok: true }),
        },
        run: async () => ({ ok: true }),
      })
    }).toThrow(/reversible.*not in/)
  })

  test("reversible: true (boolean) — caught at compile + runtime", () => {
    const { app, message } = freshApp()
    expect(() => {
      app.action(message, "bad4", {
        fromStates: ["draft"],
        toState: "sent",
        // @ts-expect-error reversible must be a ReversibleDef object, not boolean
        reversible: true,
        run: async () => ({ ok: true }),
      })
    }).toThrow()
  })

  test("invalid initialState — caught at runtime (and compile, if literal)", () => {
    const app = createApp({ id: "x", provider: SLACK })
    app.connection()
    expect(() => {
      app.resource("foo", {
        schema: z.object({}),
        states: ["a", "b"] as const,
        // @ts-expect-error 'z' not in states
        initialState: "z",
      })
    }).toThrow(/initialState/)
  })

  test("ResourceHandle.ref() — usable as zod string schema", () => {
    const { message } = freshApp()
    const channelLike = message.ref()
    expect(channelLike.parse("C123")).toBe("C123")
  })

  test("start() requires connection() first — runtime guard", async () => {
    const bare = createApp({ id: "y", provider: SLACK })
    await expect(bare.start()).rejects.toThrow(/connection/)
  })
})
