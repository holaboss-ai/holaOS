// Reference: dashboard provider — minimal stub.
//
// In a real dashboard-shape module this is where you'd wire the Composio
// toolkit fetch + sync handlers. The actual provider plumbing for a list
// view is the same as integration-only modules; see slack-messaging or
// github-workflow for full examples.

export const provider = {
  id: "github",
} as const;
