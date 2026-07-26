import { describe, expect, test } from "bun:test"

import {
  LOCAL_APP_ACTION_API_PATH,
  LOCAL_APP_ACTION_HEALTH_PATH,
  createApp,
  createLocalAppActionApi,
  z,
  type BridgeClient,
} from "../src/index.ts"

const provider = {
  id: "internal",
  baseUrl: "https://example.invalid",
  allowedHosts: [],
} as const

const bridge: BridgeClient = {
  call: async () => ({
    kind: "ok",
    status: 200,
    data: {},
  }),
}

function buildApp() {
  const app = createApp({ id: "queue-demo", provider })
  app.connection()
  const job = app.resource("job", {
    schema: z.object({
      title: z.string(),
      notes: z.string().optional(),
      last_turn_id: z.string().optional(),
      last_session_id: z.string().optional(),
    }),
    states: ["draft", "queued"] as const,
    initialState: "draft",
  })

  app.action(job, "queue", {
    fromStates: ["draft"],
    toState: "queued",
    schema: z.object({
      note: z.string(),
    }),
    run: async ({ input, persist, turnContext }) => {
      await persist({
        notes: input.note,
        last_turn_id: turnContext?.turnId,
        last_session_id: turnContext?.sessionId,
      })
      return {
        ok: true,
        data: {
          received_turn_id: turnContext?.inputId ?? turnContext?.turnId ?? null,
        },
      }
    },
  })

  return { app, job }
}

describe("createLocalAppActionApi", () => {
  test("invoke creates a row and runs an action with explicit turn context", async () => {
    const { app } = buildApp()
    const api = createLocalAppActionApi({ app, bridge })

    const result = await api.invoke({
      actionName: "queue",
      resourceName: "job",
      rowData: { title: "Review release" },
      rowStatus: "draft",
      input: { note: "Ship it" },
      turnContext: {
        sessionId: "session-1",
        turnId: "turn-1",
        inputId: "input-1",
      },
    })

    expect(result.ok).toBe(true)
    expect(result.created_row).toBe(true)
    expect(result.row?.status).toBe("queued")
    expect(result.row?.created_in_turn).toBe("turn-1")
    expect(result.row?.session_id).toBe("session-1")
    expect(result.row?.data.notes).toBe("Ship it")
    expect(result.row?.data.last_turn_id).toBe("turn-1")
    expect(result.row?.data.last_session_id).toBe("session-1")
    expect(result.action).toEqual({
      ok: true,
      data: {
        received_turn_id: "input-1",
      },
    })
  })

  test("handleRequest supports health checks and header-derived turn context", async () => {
    const { app } = buildApp()
    const api = createLocalAppActionApi({ app, bridge })

    const health = await api.handleRequest(
      new Request(`http://127.0.0.1${LOCAL_APP_ACTION_HEALTH_PATH}`),
    )
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({
      ok: true,
      path: LOCAL_APP_ACTION_API_PATH,
    })

    const response = await api.handleRequest(new Request(
      `http://127.0.0.1${LOCAL_APP_ACTION_API_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-holaboss-session-id": "session-2",
          "x-holaboss-input-id": "input-2",
        },
        body: JSON.stringify({
          action_name: "queue",
          resource_name: "job",
          row_data: {
            title: "Verify smoke path",
          },
          input: {
            note: "From headers",
          },
        }),
      },
    ))

    expect(response.status).toBe(200)
    const body = await response.json() as {
      ok: boolean
      created_row: boolean
      row: {
        status: string
        created_in_turn: string | null
        session_id: string | null
        data: Record<string, unknown>
      }
      action: {
        ok: boolean
        data?: {
          received_turn_id: string | null
        }
      }
    }
    expect(body.ok).toBe(true)
    expect(body.created_row).toBe(true)
    expect(body.row.status).toBe("queued")
    expect(body.row.created_in_turn).toBe("input-2")
    expect(body.row.session_id).toBe("session-2")
    expect(body.row.data.last_turn_id).toBe("input-2")
    expect(body.row.data.last_session_id).toBe("session-2")
    expect(body.action).toEqual({
      ok: true,
      data: {
        received_turn_id: "input-2",
      },
    })
  })
})
