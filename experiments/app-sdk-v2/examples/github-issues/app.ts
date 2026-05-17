// GitHub Issues — workflow lifecycle + side-effect actions.

import { createApp, z } from "../../src/index.ts"
import { GITHUB } from "../../src/providers/github.ts"

export function buildGithubIssuesApp() {
  const app = createApp({
    id: "github",
    provider: GITHUB,
    description: "GitHub issue triage & lifecycle",
  })

  app.connection()

  const repo = app.resource("repo", {
    schema: z.object({ id: z.string(), full_name: z.string() }),
    states: ["cached"] as const,
    initialState: "cached",
    emit: { surface: "none" },
    refreshEvery: "6h",
    fetch: async ({ bridge }) => {
      const r = await bridge.call<{ id: number; full_name: string }[]>("GET", "/user/repos")
      if (r.kind === "error") throw r
      return r.data.map(x => ({ id: String(x.id), full_name: x.full_name }))
    },
  })

  const issue = app.resource("issue", {
    schema: z.object({
      repo_full_name: repo.ref(),
      title: z.string().max(256),
      body: z.string().optional(),
    }),
    states: ["draft", "open", "in_progress", "closed", "reopened", "failed"] as const,
    initialState: "draft",
    failedState: "failed",
    emit: {
      surface: "ops_log",
      summary: r => r.title,
      deepLink: r => r.external_id && r.repo_full_name
        ? `https://github.com/${r.repo_full_name}/issues/${r.external_id}`
        : null,
    },
  })

  app.action(issue, "create", {
    fromStates: ["draft"],
    toState: "open",
    run: async ({ row, bridge }) => {
      if (row.external_id) return { ok: true, externalId: row.external_id }   // idempotent
      const r = await bridge.call<{ number: number; html_url: string }>(
        "POST", `/repos/${row.repo_full_name}/issues`,
        { title: row.title, body: row.body },
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true, externalId: String(r.data.number) }
    },
  })

  app.action(issue, "start_work", {
    fromStates: ["open", "reopened"],
    toState: "in_progress",
    run: async ({ row, bridge }) => {
      const r = await bridge.call(
        "POST", `/repos/${row.repo_full_name}/issues/${row.external_id}/labels`,
        { labels: ["in-progress"] },
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true }
    },
  })

  app.action(issue, "close", {
    fromStates: ["open", "in_progress", "reopened"],
    toState: "closed",
    reversible: {
      toState: "reopened",
      run: async ({ row, bridge }) => {
        const r = await bridge.call(
          "PATCH", `/repos/${row.repo_full_name}/issues/${row.external_id}`,
          { state: "open" },
        )
        if (r.kind === "error") return { fail: r }
        return { ok: true }
      },
    },
    run: async ({ row, bridge }) => {
      const r = await bridge.call(
        "PATCH", `/repos/${row.repo_full_name}/issues/${row.external_id}`,
        { state: "closed" },
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true }
    },
  })

  app.action(issue, "reopen", {
    fromStates: ["closed"],
    toState: "reopened",
    run: async ({ row, bridge }) => {
      const r = await bridge.call(
        "PATCH", `/repos/${row.repo_full_name}/issues/${row.external_id}`,
        { state: "open" },
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true }
    },
  })

  app.action(issue, "comment", {
    fromStates: ["open", "in_progress", "closed", "reopened"],
    toState: null,
    toolName: "github_comment_on_issue",
    schema: z.object({ body: z.string().min(1) }),
    run: async ({ row, input, bridge }) => {
      const r = await bridge.call(
        "POST", `/repos/${row.repo_full_name}/issues/${row.external_id}/comments`,
        { body: input.body },
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true }
    },
  })

  app.action(issue, "assign", {
    fromStates: ["open", "in_progress", "reopened"],
    toState: null,
    schema: z.object({ assignees: z.array(z.string()).min(1) }),
    run: async ({ row, input, bridge }) => {
      const r = await bridge.call(
        "POST", `/repos/${row.repo_full_name}/issues/${row.external_id}/assignees`,
        { assignees: input.assignees },
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true }
    },
  })

  app.sync("issue_activity", {
    schedule: "*/15 * * * *",
    attachTo: issue,
    fetch: async ({ bridge, db }) => {
      const open = db.query(issue).where({ status: "open" }).all()
      const active: { issue_id: string; raw: { reactions?: { total_count?: number }; comments?: number } }[] = []
      for (const i of open) {
        if (!i.external_id) continue
        const r = await bridge.call<{ reactions?: { total_count?: number }; comments?: number }>(
          "GET", `/repos/${i.repo_full_name}/issues/${i.external_id}`,
        )
        if (r.kind === "error") return { ok: false, error: r }
        active.push({ issue_id: i.id, raw: r.data })
      }
      return { ok: true, items: active }
    },
    upsert: { key: "issue_id" },
    normalize: raw => ({
      reach: raw.raw.reactions?.total_count ?? 0,
      engagement: raw.raw.comments ?? 0,
      clicks: 0,
    }),
  })

  return { app, issue, repo }
}
