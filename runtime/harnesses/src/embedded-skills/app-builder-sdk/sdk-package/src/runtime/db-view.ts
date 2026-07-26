// DbView implementation — backend-agnostic query over rows.

import type { DbView, ResourceHandle, RowOf, StateBackend, StateTuple } from "../types.ts"
import type { ZodTypeAny } from "zod"

export function createDbView(state: StateBackend): DbView {
  return {
    query<TSchema extends ZodTypeAny, States extends StateTuple>(
      resource: ResourceHandle<TSchema, States>,
    ) {
      const allRows = () =>
        state.rowsByResource(resource.name).map(r => ({
          ...r.data,
          id: r.id,
          status: r.status,
          external_id: r.externalId,
        }) as RowOf<TSchema>)

      function applyWhere(cond: Record<string, unknown>) {
        const rows = allRows().filter(r => {
          for (const [k, v] of Object.entries(cond)) {
            // Scalar equality only — DbView's where() type restricts callers
            // at compile time (ScalarFilter). This runtime check exists for
            // untyped JS callers that bypass the type.
            const got = (r as Record<string, unknown>)[k]
            if (got !== v) return false
          }
          return true
        })

        return {
          all: () => rows,
          recent: (window: string) => {
            const ms = parseWindow(window)
            const cutoff = Date.now() - ms
            // recency by createdAt — need original RowRecord, not the merged view
            const ids = new Set(rows.map(r => r.id))
            return state.rowsByResource(resource.name)
              .filter(rr => ids.has(rr.id) && Date.parse(rr.createdAt) >= cutoff)
              .map(rr => ({
                ...rr.data,
                id: rr.id,
                status: rr.status,
                external_id: rr.externalId,
              }) as RowOf<TSchema>)
          },
        }
      }

      return {
        where: applyWhere,
        all: allRows,
      }
    },
  }
}

function parseWindow(window: string): number {
  // "30d" / "6h" / "15m"
  const m = window.match(/^(\d+)([dhms])$/)
  if (!m) throw new Error(`bad window: ${window}`)
  const n = parseInt(m[1]!, 10)
  switch (m[2]) {
    case "d": return n * 86_400_000
    case "h": return n * 3_600_000
    case "m": return n * 60_000
    case "s": return n * 1000
    default:  return 0
  }
}
