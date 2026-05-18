import { describe, test, expect } from "bun:test"
import { createBridge, type TransportFn } from "../src/bridge.ts"
import { GITHUB } from "../reference/github-workflow/provider.ts"
import { buildGithubIssuesApp } from "../reference/github-workflow/app.ts"
import type { AppHandleInternal } from "../src/app.ts"

let calls: Array<{ method: string; url: string; body?: any }> = []
let scriptedResponses: Array<{ status: number; body: unknown }> = []
const transport: TransportFn = async (req) => {
  calls.push({ method: req.method, url: req.url, body: req.body })
  const next = scriptedResponses.shift()
  if (!next) throw new Error(`no scripted response for ${req.method} ${req.url}`)
  return next
}
function bridge() {
  return createBridge({ provider: GITHUB, transport })
}
function setup() {
  calls = []
  scriptedResponses = []
  const built = buildGithubIssuesApp() as unknown as { app: AppHandleInternal; issue: any; repo: any }
  built.app._setTurn({ turnId: "turn_1", sessionId: "sess_1" })
  return built
}

describe("GitHub Issues — full workflow lifecycle", () => {
  test("full issue lifecycle: draft → open → in_progress → closed → reopened", async () => {
    const { app } = setup()
    const row = app._state.insertRow("issue", {
      repo_full_name: "holaboss/holaboss", title: "Bug X", body: "details",
    }, "draft")

    // 1. create: draft → open
    scriptedResponses.push({ status: 201, body: { number: 42, html_url: "..." } })
    const r1 = await app._invokeAction({ actionName: "create", rowId: row.id, bridge: bridge() })
    expect((r1 as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("open")
    expect(app._state.getRow(row.id)!.externalId).toBe("42")

    // 2. start_work: open → in_progress
    scriptedResponses.push({ status: 200, body: [] })
    const r2 = await app._invokeAction({ actionName: "start_work", rowId: row.id, bridge: bridge() })
    expect((r2 as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("in_progress")

    // 3. close: in_progress → closed
    scriptedResponses.push({ status: 200, body: {} })
    const r3 = await app._invokeAction({ actionName: "close", rowId: row.id, bridge: bridge() })
    expect((r3 as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("closed")

    // 4. reopen: closed → reopened
    scriptedResponses.push({ status: 200, body: {} })
    const r4 = await app._invokeAction({ actionName: "reopen", rowId: row.id, bridge: bridge() })
    expect((r4 as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("reopened")

    // Dashboard card should reflect latest state
    const card = app.state().outputs.find(o => o.rowId === row.id)
    expect(card!.surface).toBe("ops_log")
    expect(card!.status).toBe("reopened")
    expect(card!.summary).toBe("Bug X")
    expect(card!.deepLink).toBe("https://github.com/holaboss/holaboss/issues/42")
  })

  test("close is reversible (back to 'reopened')", async () => {
    const { app } = setup()
    const row = app._state.insertRow("issue", {
      repo_full_name: "holaboss/holaboss", title: "x", external_id: "42",
    }, "open")
    app._state.updateRow(row.id, { externalId: "42" })

    scriptedResponses.push({ status: 200, body: {} })
    await app._invokeAction({ actionName: "close", rowId: row.id, bridge: bridge() })
    expect(app._state.getRow(row.id)!.status).toBe("closed")

    scriptedResponses.push({ status: 200, body: {} })
    const rev = await app._invokeReverse({ actionName: "close", rowId: row.id, bridge: bridge() })
    expect((rev as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("reopened")
  })

  test("comment: side effect, does NOT change issue status", async () => {
    const { app } = setup()
    const row = app._state.insertRow("issue", {
      repo_full_name: "holaboss/holaboss", title: "x", external_id: "42",
    }, "open")
    app._state.updateRow(row.id, { externalId: "42" })
    app._state.upsertOutput({
      resourceName: "issue", rowId: row.id, surface: "ops_log",
      status: "open", summary: "x", deepLink: null,
    })

    scriptedResponses.push({ status: 201, body: { id: 999 } })
    const r = await app._invokeAction({
      actionName: "comment",
      rowId: row.id,
      input: { body: "looks good" },
      bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("open")    // unchanged
    const card = app.state().outputs.find(o => o.rowId === row.id)!
    expect(card.status).toBe("open")                          // dashboard not disturbed
  })

  test("assign: side effect, custom toolName check", async () => {
    const { app } = setup()
    const names = app.derivedTools().map(t => t.name)
    expect(names).toContain("github_assign_issue")
    expect(names).toContain("github_comment_on_issue")        // ← agent's override
    expect(names).not.toContain("github_comment_issue")
  })

  test("invalid transition: start_work on closed issue rejected", async () => {
    const { app } = setup()
    const row = app._state.insertRow("issue", {
      repo_full_name: "holaboss/holaboss", title: "x", external_id: "42",
    }, "closed")
    const r = await app._invokeAction({ actionName: "start_work", rowId: row.id, bridge: bridge() })
    expect((r as any).fail.code).toBe("invalid_state")
    expect((r as any).fail.message).toContain("from state 'closed'")
  })

  test("derived tools contain all action + reverse + sync tools", async () => {
    const { app } = setup()
    const names = app.derivedTools().map(t => t.name).sort()
    expect(names).toContain("github_create_issue")
    expect(names).toContain("github_start_work_issue")
    expect(names).toContain("github_close_issue")
    expect(names).toContain("github_cancel_close_issue")    // reversible
    expect(names).toContain("github_reopen_issue")
    expect(names).toContain("github_comment_on_issue")      // toolName override
    expect(names).toContain("github_assign_issue")
    expect(names).toContain("github_list_issues")
    expect(names).toContain("github_list_repos")
    expect(names).toContain("github_issue_activity_sync_status")
    expect(names).toContain("github_snapshot")
  })

  test("failure: bad token surfaces with reauth hint", async () => {
    const { app } = setup()
    const row = app._state.insertRow("issue", {
      repo_full_name: "holaboss/holaboss", title: "x",
    }, "draft")
    scriptedResponses.push({ status: 401, body: { message: "Bad credentials" } })
    const r = await app._invokeAction({ actionName: "create", rowId: row.id, bridge: bridge() })
    expect((r as any).fail.code).toBe("not_connected")
    expect(app._state.getRow(row.id)!.status).toBe("failed")
    expect(app.state().notifications[0].agentHint).toContain("reconnect")
  })
})
