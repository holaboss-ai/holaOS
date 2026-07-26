# Verification and Testing

Use this reference when verifying a newly built app, updating a running app, or adding provider-backed behavior that can fail in multiple ways.

## Managed Runtime Verification Order
When managed lifecycle tools are surfaced, verify in this order:
1. `workspace_apps_build`
2. `workspace_apps_ensure_running` or `workspace_apps_restart_and_wait_ready`
3. `workspace_apps_wait_until_ready` if you did not already use the compound restart-and-wait tool
4. `workspace_apps_probe_endpoints`
5. any app-specific functional checks that the user actually asked for

Do not replace this with a foreground `npm start`, `npm run dev`, or another long-lived shell server.

## Focused Test Coverage
When changing shared behavior, provider clients, or connection-status logic, add focused tests that match the risk.

For integration-backed apps, cover at least these cases when the app exposes tools or status-dependent UI:
1. MCP health or equivalent runtime health endpoint is live
2. current connection status succeeds and returns usable identity fields
3. no bound integration maps to `not_connected`
4. pending or unfinished managed auth maps to `pending_authorization` when detectable
5. a representative provider-backed action succeeds on the happy path
6. rate limit or validation failures map to stable app-level states when the user will see them

## Status Verification Rules
- After the user finishes a connect flow, re-run the live connection-status helper.
- If the app persists the last provider result, treat it as diagnostic output only.
- Verify one cheap live provider probe before claiming the app is connected.
- If the provider is still pending upstream, say that explicitly instead of saying disconnected.

## High-Signal Failure Modes
Watch for these when a run appears to succeed but the app is still wrong:
- the app reports connected or disconnected from cached local state rather than a fresh probe
- the provider id in the manifest, bridge client, and binding metadata do not match exactly
- the app builds and serves locally, but the managed runtime never owns the process
- the connection-status path works, but the real provider action path maps errors differently
- the run held a foreground server open and timed out before the managed verification steps finished
