# Discord module connect-flow fix — 2026-05-18

When a user asked the desktop agent to build a brand-new Discord
module, three independent bugs surfaced in sequence:

1. **No Connect button rendered** in the chat after the agent reported
   the app was ready.
2. **First `/api/composio/connect` call always failed** with a 502;
   retrying always worked.
3. **After the user finally authorized**, the Discord app already
   running in the sandbox kept behaving as if no integration was
   bound, until a manual restart.

The three bugs are independent — fixing only one of them leaves the
flow broken at the next step — so the work is split into three stages
that need to land together for the end-to-end Discord build to work.
Each stage is locally verifiable on its own (see each stage doc's
"Verification" section).

| Stage | Bug | Layer | Deploys via |
|---|---|---|---|
| [1](stage-1-broaden-pending-integrations-emit.md) | Connect button | holaOS runtime | rebuild + `npm run desktop:prepare-runtime:local` |
| [2](stage-2-restart-app-after-bind.md) | Stale grant after bind | holaOS desktop (electron main + preload + renderer) | `npm run desktop:dev` |
| [3](stage-3-hono-remove-toolkit-mapping-and-upsert.md) | First-time 502 + non-extensible toolkit map | Hono (frontend/apps/server) | `bun run deploy:staging` |
| [4](stage-4-account-display.md) | Account labels show as hex hash for any toolkit not in `PROVIDER_WHOAMI` | UI fallback (Tier 1) + per-yaml whoami passthrough across runtime/desktop/Hono (Tier 2) | desktop rebuild + `bun run deploy:staging` |
| [5](stage-5-toolkit-slug-fix.md) | `not_connected` / 401 on send-message after a clean OAuth (identity probe works) | `provider.ts` + yaml use the **actual Composio toolkit slug** (`discordbot`, not `discord`); skill rewritten to enforce one-value-everywhere; `composioToolkit` deprecated | edit-in-workspace + `bun run desktop:prepare-runtime:local` (skill ships in runtime bundle) |
| [6](stage-6-app-surface-bind-button.md) | App Surface "Connect" button only rendered for ~12 hardcoded toolkits; new agent-built apps had no in-app bind UI | `/api/v1/apps` returns yaml-declared `integrations[]` per app; `AppSurfacePane` resolves provider from yaml (not from a hardcoded map); `handleConnectAccount` runs full OAuth+bind+restart inline | desktop rebuild |
| [7](stage-7-deduplicate-bind-state-and-drop-app-catalog.md) | Two parallel bind-state machines (chat card + App Surface) drifted; `APP_CATALOG` hardcoded display labels for 7 apps — agent-built apps got `labelFromAppId` fallbacks | Shared `useIntegrationBinding` hook; both consumers refactored; yaml `name:` surfaced on `/api/v1/apps`; `APP_CATALOG` / `summary` / `accentClassName` deleted | desktop rebuild + `npm run desktop:prepare-runtime:local` |
| [8](stage-8-cancel-stuck-connect.md) | Rejecting / closing the OAuth window left the Connect button spinning for the full 5-min poll timeout | Hook exposes `cancel()` + per-call AbortController; consumers swap Connect → Cancel button while `busy === "connecting"`; unmount aborts in-flight controller | desktop rebuild |

The legacy module-app source is **not** touched — the desktop agent now
generates app modules dynamically, the legacy marketplace path is no
longer the source of truth for these bugs.

## End-to-end verification (after all three stages ship)

```text
1. Open desktop → start a new workspace → tell the agent "build a
   Discord bot module for me".
2. Once the agent reports the app is ready, a "Connect Discord" card
   MUST render inline in the assistant turn (Stage 1).
3. Click Connect Discord → OAuth window opens → user grants access in
   their browser (Stage 3, no 502 on the first attempt).
4. Card transitions to "Bound to discordbot-module …" within seconds
   of the user clicking through OAuth (Stage 2 has restarted the app
   in the background so HOLABOSS_APP_GRANT is freshly injected).
5. Ask the agent "list my Discord guilds" — it must succeed on the
   first call without any restart hint or manual intervention.
```

## Why the bugs presented together

All three bugs sit on the same chain — the agent's "I just built a new
toolkit-backed app" path. Existing apps (gmail, github, etc.) had at
least one of:

- a marketplace catalog entry hardcoding `provider_id`, working around
  Stage 1's narrow emit set;
- an entry in `PROVIDER_TO_TOOLKIT`, working around Stage 3's missing
  mapping;
- a user who had connected the toolkit before any app was running,
  side-stepping Stage 2's boot-time env capture.

A truly fresh Discord install bypassed all three workarounds at once,
which is why this is the first toolkit to expose the whole chain.
