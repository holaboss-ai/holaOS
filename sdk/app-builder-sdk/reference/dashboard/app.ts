// Reference: dashboard-shape app.
//
// This is the canonical starting point for any module that needs a real
// workspace-pane UI (list / table / kanban / calendar / "let me see my X").
// Pair the backend declared here with the dashboard route in src/client/.
//
// Backend story is intentionally minimal — the interesting part is how the
// frontend at src/client/routes/index.tsx composes @holaboss/ui to render
// the rows this app's resource holds.

import { z } from "zod";

import { app, type AppHandle } from "@holaboss/app-builder-sdk";

// ---------------------------------------------------------------------
// Resource: a single `issues` table. Replace with whatever your module's
// canonical entity is (tasks, contacts, leads, events, posts, etc.).
// ---------------------------------------------------------------------
const Issue = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.enum(["open", "in_progress", "closed"]),
  assignee: z.string().nullable(),
  created_at: z.string(),
});

export function buildDashboardApp(): AppHandle {
  return app("dashboard", {
    provider: {
      id: "github", // replace with the real Composio toolkit slug
    },
    resources: {
      issues: {
        schema: Issue,
        externalIdField: "id",
        states: ["open", "in_progress", "closed"],
      },
    },
    // Actions are optional for a pure list/read dashboard. Add them when
    // the module needs to mutate upstream (close issue, assign, comment).
    actions: {},
  });
}
