# Cutting per-turn init latency (TTFT) — warm harness / collapse the double spawn

**Date:** 2026-08-13
**Revised:** 2026-08-18 — see [What changed in the revision](#what-changed-in-the-revision)
**Status:** spec — **Phase 2 SHELVED on measured evidence; Phase 1 is the only live lever**
**Owner:** runtime / api-server

## Problem

Every desktop turn pays a fixed ~2.6–3.2 s of init *before the model is even
called*, independent of model speed. A CLI pi harness on the same model backend
is snappy because it runs `runPi()` **in-process** and pays startup once, not
per turn.

### MEASURED 2026-08-18 — the table below is superseded

A fresh 13-turn sample is checked in at
[`data/2026-08-18-ttft-sample.log`](data/2026-08-18-ttft-sample.log). The
composio cross-turn cache landed between turn 4 and turn 5 of it, so the same
file contains a before and an after:

| | turns 1–4 (pre-cache) | turns 5–13 (post-cache) |
|---|---:|---:|
| `ts_runner_load` | 458 ms | 268 ms |
| `bootstrap` | 1,161 ms | 836 ms |
| **`harness_load`** | 974 ms | **1,084 ms** |
| **`session_setup`** | **692 ms** | **62 ms** |
| **fixed init** | **3,284 ms** | **2,250 ms** |
| of which `composio_inline` | 653 ms | **1.4 ms** |

**This settles the three open questions:**

1. **The cache hits.** `composio_inline` 653 ms → 1.4 ms, `session_setup`
   692 ms → 62 ms. Lever 0's static trace was right; the old table's ~715 ms
   `session_setup` was measured on turns 1–4.
2. **Phase 2 is dead, confirmed by measurement.** Its budget was
   `harness_load` + `session_setup`. That is now 1,084 + 62 ms, so it buys
   **~62 ms more than Phase 1**, for a warm process pool, a serve loop, a cancel
   channel and per-turn header re-resolution. Not close.
3. **Phase 1 is the whole remaining prize.** `harness_load` at 1,084 ms is the
   single largest component of fixed init, and nothing else targets it.

**A prediction worth checking:** `bootstrap` fell 1,161 → 836 ms, only ~325 ms of
the ~653 ms the cache could save there, because the bootstrap fetch was still
missing on turns spaced more than the old 120 s TTL apart. Lever 0b (#505) raised
that to 15 minutes, so a sample taken after it should show `bootstrap` closer to
~500 ms. If it does not, the cache is missing for some other reason and that is
worth chasing before Phase 1.

### Original evidence — `[ttft]` telemetry, 16 real desktop turns (`runtime.log`, not checked in)

`total_ttft = ts_runner_load + bootstrap + harness_load + session_setup + model_ttft` (verified, sums exactly).

| Phase | Typical | What it is |
|---|---|---|
| `ts_runner_load` | ~270 ms | api-server spawns a **fresh `node dist/ts-runner.mjs`**, cold-loads ~1.1 MB bundle + parses request |
| `bootstrap` | ~960 ms | in-process request build in ts-runner (compile plan, memory recall, resource reload; MCP sidecar already **reused** → `mcp_connect` ~1 ms) |
| `harness_load` | ~1,100 ms (spikes 2.3 s) | ts-runner spawns a **second fresh `node harness-host/dist/index.mjs run-pi`**, cold-loads another ~1.1 MB bundle |
| `session_setup` | ~715 ms | harness `createSession`; ~95% was `composio_inline` (~675 ms) — **STALE, see below** |
| **fixed init** | **~2.6–3.2 s** | everything above, before the model call |
| `model_ttft` | 3.2 s … 54 s | pure Ark-side latency (separate problem) |

> ### ⚠ The `session_setup` row is dead — resolved by code review, 2026-08-18
>
> This sample was taken on 2026-08-13. On **2026-08-15**, commit `2f6d97f`
> ("perf(composio): cache the inline tool listing across turns and processes")
> added `runtime/harnesses/src/composio-inline-cache.ts` — a file-backed,
> cross-process cache with a 120 s TTL (`DEFAULT_TTL_MS`, `:35`; overridable via
> `HB_COMPOSIO_CACHE_TTL_MS`), enabled unless `HB_COMPOSIO_CACHE` is explicitly
> `0`/`false`/`off` (`composioInlineCacheEnabled`, `:47` — nothing in the repo
> sets it).
>
> **Traced end-to-end; the two fetches have different fates.** The listing is hit
> twice per turn from two processes, and the cache kills exactly one of them
> unconditionally:
>
> | Fetch | Cost in the table above | Status now |
> |---|---|---|
> | ts-runner bootstrap (`fetchComposioInlineToolRefs`, `ts-runner.ts:959`) | ~773 ms, inside `bootstrap` | **TTL-dependent** — hits only when the previous turn was <120 s ago |
> | harness-host session setup (`resolveComposioInlineTools`, `pi.ts:3030`) | **~675 ms, = 95% of `session_setup`** | **Gone on every turn, including turn 1** |
>
> The second one is structural, not probabilistic. Bootstrap's prefetch writes
> the cache (`ts-runner.ts:995`), is awaited at `:2408`
> (`await_composio_inline_tools`), and only *then* is harness-host spawned with
> `workspace_dir: bootstrap.workspaceDir` (`:2432`) — the **same value** the
> prefetch keyed on (`:2366`). Same path, same workspace id, written milliseconds
> earlier in the same turn. The TTL cannot expire in that window.
>
> **⇒ `session_setup` is now ~62 ms, not ~715 ms — and Phase 2's headline
> "~1.8 s, turns 2+" is really ~1.15 s.** (Both figures since measured; see the
> MEASURED block above.) That residual is `harness_load`, which
> **Phase 1 targets directly at a fraction of the risk**. See the levers table:
> this is why Phase 2 is shelved rather than merely deferred.
>
> Confirmed empirically: a real cache file exists on a dev root
> (`…/workspace/root/.holaboss/state/composio-inline-tool-cache.json`, 64 tools,
> 113 KB, written the day the feature shipped), and the unit suite
> (`composio-inline-cache.test.ts`, 7 tests) covers round-trip, TTL boundary,
> cross-workspace isolation, corruption and the kill switch.
>
> **Captured 2026-08-18** — see the MEASURED block at the top of this section.
> `session_setup` is 62 ms; `composio_inline` is 1.4 ms. Confirmed.

**Root cause: two cold Node subprocess spawns per turn**, each cold-loading a
1.1 MB bundle (`ts_runner_load` + `harness_load`), plus a fresh `bootstrap`. The
MCP sidecar is *already* pooled across turns (`workspace_mcp_sidecar_reused`,
`workspace-mcp-sidecar.ts`) — the harness process is not.

## Topology today

```
api-server (long-lived)
  └─ runner-worker.spawn( node ts-runner.mjs --request-file )   [PER TURN]   ← ts_runner_load
       └─ ts-runner: compile + memory + sidecar(reused) + composio prep       ← bootstrap
            └─ ts-runner.spawn( node harness-host run-pi --request-stdin )  [PER TURN]  ← harness_load
                 └─ harness-host: runPi → createSession(...) → sendUserMessage → NDJSON on stdout → process.exit()  ← session_setup
```

Key facts the design leans on:
- `deps.runHarnessHost` is an **injection seam** (`runtime/api-server/src/ts-runner.ts:274`,
  default `defaultRunHarnessHost:1903`, wired at `:2066`). `scripts/hola.mts:544`
  already swaps it for an **in-process `runPi()`**
  (`runtime/harness-host/src/pi.ts:3906`) with an `emitEvent` adapter — faithful
  for *function* (MCP, skills, tools, model_client, injected context identical to
  a desktop run). **Not faithful for lifecycle** — see Phase 1 blockers.
- harness-host `index.ts` is **one-shot**: read one request → `plugin.run()`
  (`:185`) → flush → `exit()` (`:191`). No serve loop.
- In `runPi`, **all** `session_setup_timings_ms` steps (`composio_inline`,
  `browser_tools`, `runtime_tools`, `web_search`, `mcp_connect`,
  `create_agent_session`, `resource_reload`) run inside `defaultCreateSession`
  (`pi.ts:2890`) — they are **per-session**, not per-turn. Only `sendUserMessage`
  + event relay are per-turn.
- The pi session is durable on disk as JSONL (resume by path). What is *lost* on
  each cold spawn and rebuilt: MCP stdio transports, tool schemas, model client,
  the loaded in-memory session.

> **Note on file paths.** There are two `pi.ts` in this repo — the 142-line
> `runtime/harnesses/src/pi.ts` (plugin shim) and the 4,455-line
> `runtime/harness-host/src/pi.ts` (the brain). **Every `pi.ts` anchor in this
> document means the harness-host one** and is written out in full on first use
> per section. Anchors were re-verified against `main` at `1be12c5` on
> 2026-08-18; the pre-revision draft's anchors had drifted 4–207 lines.

### Serialization is weaker than "strictly serial"

The pre-revision draft claimed turns for one session are strictly serial, so a
per-session warm worker has no re-entrancy risk. That is the *intent*, not a
guarantee. `store.claimInputs` excludes a queued input only while a sibling row
for the same `session_id` is CLAIMED **and** `claimed_until > now`
(`runtime/state-store/src/store.ts:5023`). The lease is
kept alive by `renewInputClaim` on a tick (`queue-worker.ts:303`), whose own
design treats a missed renewal as harmless because stale-claim recovery is the
safety net. A stalled worker, a laptop sleeping mid-turn, or a second api-server
on the same root can therefore admit turn 2 while turn 1 is still running.

Today that is survivable — two cold harness processes, two independent pi
handles. **With a retained handle it is not**: two overlapping `sendUserMessage`
calls on one session and one detached `_agentEventQueue` interleave into the
JSONL. **Phase 2 needs its own per-session mutex** and must not lean on the
queue's lease as an invariant.

## Goal / non-goals

**Goal:** remove as much of the ~3 s fixed per-turn init as possible without
regressing crash isolation or correctness.

**Non-goals:** the model-side `model_ttft` variance (Ark caching/latency —
tracked separately); changing the pi brain or the event contract.

## Levers, ranked by leverage ÷ risk

| # | Change | Removes | Per-turn saving (**unmeasured — see caveat**) | Risk |
|---|---|---|---|---|
| ~~0~~ | ~~Verify the composio cache is hitting~~ | ~~`session_setup`~~ | **DONE 2026-08-18** — it hits; ~675 ms already gone every turn | — |
| **0b** | **Wire `clearComposioInlineCache` into the connect/install flows, then raise the TTL** | bootstrap's composio fetch | ~773 ms on most turns (see below) | **Low** — a few lines; the hook already exists and is tested |
| **1** | Run pi **in-process** of ts-runner (collapse the double spawn) | 2nd Node boot | ~0.8–1.1 s target, **every turn** | **Med** — the seam is proven, the *lifecycle* is not; 6 blockers below, all fixable |
| ~~2~~ | ~~**Warm harness pool**~~ — **SHELVED**, see below | `harness_load` + residual `session_setup` | ~1.1 s, and Phase 1 already claims that | **High**, for a win Phase 1 gets more cheaply |
| 3 | Lift warm lookup into api-server (skip per-turn ts-runner spawn too) | `ts_runner_load` + most `bootstrap` | ~1.2 s more, turns 2+ | High — bootstrap/compile currently lives in ts-runner |

**Lever 0b is now the best leverage÷risk on the board**, and it did not exist in
the original plan. `clearComposioInlineCache` (`composio-inline-cache.ts:119`) is
exported, unit-tested, and documented as "the connect/install hook" — but
**nothing in the repo calls it**. The 120 s TTL is therefore the *only*
invalidation, which forces two bad outcomes at once: a newly connected
integration stays invisible for up to two minutes, *and* the TTL has to stay
short, so bootstrap's ~773 ms fetch misses on any turn a user takes longer than
two minutes to send. Wire the hook into the connect / disconnect / install paths
and the TTL can go up by orders of magnitude — buying most of that 773 ms on
nearly every turn, with better freshness than today, for a few lines of code and
no new process topology.

**Why Phase 2 is shelved, not deferred.** Its budget was `harness_load` +
`session_setup` ≈ 1.8 s. Measured, `session_setup` is 62 ms, so the real budget
is the 1,084 ms of `harness_load` — *the same thing Phase 1 removes*, at a fraction of the
risk and without retained sessions, a serve loop, a process pool, a cancel
channel, or per-turn header re-resolution. Phase 2 is kept below for the record
and because its blocker analysis stays useful if the topology is ever revisited,
but on current numbers it does not clear its own bar. Revisit only if Phase 1
measures badly *and* a fresh `[ttft]` sample shows a large residual
`session_setup`.

> **Caveat on the savings column:** the per-phase medians come from a 16-line
> `[ttft]` sample that is **not checked into the repo**, and the `session_setup`
> term is now known-stale (see the Evidence box). Treat every number here as
> directional at best. Note the `total = Σphases` identity in the Evidence table
> is *tautological* — the phase terms are back-computed from the same timestamps
> (`runner-worker.ts:887-898`), so it can't not sum; it is not independent
> corroboration.

**Revised ordering: 0b → 1 → re-measure → stop.**

The pre-revision draft said "ship 1, then 2, 3 optional". That ordering no
longer holds, for two independent reasons:

1. **Lever 0 removed most of Phase 2's justification** — `session_setup` is
   already paid down, so Phase 2 and Phase 1 now chase the same ~1.1 s.
2. **Phase 2 as drafted cannot be built at Phase 2's topology.** Its registry is
   specified as a "module singleton in the long-lived owner", but in Phase 2 the
   owner is ts-runner — a *per-turn process*. Two ts-runner processes have two
   heaps, so the in-flight-promise dedupe cannot dedupe and the idle-TTL/LRU
   timer has no process to live in. (This is exactly why the sidecar being copied
   holds no module map and is purely file-backed state.) That machinery only
   becomes implementable once api-server owns the lookup — i.e. **Phase 3 is a
   prerequisite for a correct Phase 2, not an optional follow-on.**

---

## Phase 1 — in-process pi in ts-runner

**Idea:** provide an in-process `runHarnessHost` implementation and select it in
the desktop runner path behind a flag, instead of `defaultRunHarnessHost`
cold-spawning `harness-host`.

**Why it works:** the harness/pi code has to load either way; doing it in
ts-runner's already-running V8 avoids a whole second process boot (fork + V8 init
+ node bootstrap + module resolution) — that boot is the bulk of the ~1.1 s.

### Blocker 0 — packaging. Resolve this before writing any of the below.

`@holaboss/runtime-api-server` **does not depend on `@holaboss/runtime-harness-host`**,
and `runPi` lives in `runtime/harness-host/src/pi.ts`. ts-runner today reaches
sibling code only via relative imports into `runtime/harnesses/src/*`, a package
whose deps api-server carries.

harness-host's `package.json` adds `mcporter`, `@anthropic-ai/claude-agent-sdk`,
`@earendil-works/pi-ai`, `web-tree-sitter`, `tree-sitter-wasms`, `@napi-rs/canvas`
and `openai` — **none** in api-server's dependencies, and tsup's `noExternal` lists
only `@holaboss/runtime-channel-gateway`. So a naive import emits bare specifiers
into `dist/ts-runner.mjs` that will not resolve at runtime.

Worse for the plan's central premise: harness-host has
`postinstall: node scripts/apply-pi-patches.mjs`, applied to **its own**
`node_modules`. A copy of pi resolved from api-server runs **unpatched** — so
"fidelity proven by the CLI" does not transfer, because the CLI runs inside
harness-host's install.

**Options, in preference order:**
1. **Invert it** — put the in-process entry point in harness-host (which already
   has the deps and the patches) and have api-server call it across a package
   boundary it declares. Keeps one pi install, one patch set.
2. Add `@holaboss/runtime-harness-host` as an api-server dependency **and** make
   the pi patches a build artifact rather than a `node_modules` mutation.
3. Bundle harness-host into ts-runner via `noExternal` — largest bundle, and
   `@napi-rs/canvas` / `web-tree-sitter` are native/wasm, so this likely fails.

Until one is chosen, the rest of Phase 1 is not implementable.

### Changes (once Blocker 0 is resolved)
- Add `inProcessRunHarnessHost({ requestPayload, emitEvent })` that calls
  `runPi(requestPayload as HarnessHostPiRequest, { ...defaultPiDeps(), emitEvent: adapter })`,
  mapping pi's `(req, sequence, event_type, payload)` → the `RunnerEvent` shape
  `emitEvent` expects.
- Select it in `executeTsRunnerRequest` deps (`ts-runner.ts:2066`) when
  `HB_HARNESS_IN_PROCESS=1` (default off for first rollout), else keep
  `defaultRunHarnessHost`.
- **Do NOT route via the generic `plugin.run`.** See blocker 3.

### Blockers 1–6 — what the subprocess is silently providing today

The draft called crash isolation "the one real tradeoff". It is not. Each of
these is a guarantee that exists *only* because pi runs in a child process, and
each fails silently rather than loudly.

**1. `hola.mts`'s adapter lies about termination — do not copy it.**
`scripts/hola.mts:560-566` returns hardcoded `sawEvent: true, terminalEmitted: true`,
because it never inspects events. `defaultRunHarnessHost` computes
`terminalEmitted` honestly by watching `TERMINAL_EVENT_TYPES` (`ts-runner.ts:2026`,
returned `:2047`), and ts-runner keys failure synthesis off it:
`ts-runner.ts:2803` is `if (harnessResult.terminalEmitted) { return; }`, guarding
the `buildTsRunnerFailureEvent` relay at `:2814`. Copy the hola return verbatim
and **every non-terminating pi run** (OOM, unhandled rejection inside a tool,
native abort) reports clean, runner-worker sees no terminal event, and the run
hangs to the 30-minute hard timeout instead of failing in seconds.
→ The in-process impl **must** compute `sawEvent` / `terminalEmitted` / `lastSequence`
from the events it actually relays, exactly as `defaultRunHarnessHost` does.

**2. The proposed crash mitigation destroys the resume pointer.**
The draft said: wrap `runPi` in try/catch → emit `run_failed`. But
`relayTsRunnerEvent` treats `run_failed` as the signal to
`clearWorkspaceHarnessSessionId` (`ts-runner.ts:2216`), against
`persistWorkspaceHarnessSessionId` at `:2227`. pi emits `run_completed` and *then*
runs `maybeCompactSessionOverThreshold()` (`pi.ts:4200`) and `handle.dispose()`
(`:4253`) in its finally. In-process, a throw from compaction or dispose **after a
green turn** propagates into ts-runner's outer catch, which relays `run_failed` —
wiping the persisted `harness_session_id`, so the next turn starts a brand-new pi
session and the user loses their conversation despite the turn having succeeded.
Today that exception dies inside the harness-host child and never reaches here.
→ The try/catch must distinguish *pre-terminal* failure (relay `run_failed`) from
*post-terminal* failure (log; **never** clear the session id).

**3. `plugin.run` has no event seam — routing through it sends pi's NDJSON to the wrong stdout.**
`HarnessHostPlugin.run` is declared `(request: unknown) => Promise<number>`
(`runtime/harnesses/src/types.ts:312`) and the pi impl is
`run: async (request) => await runPi(request as ...)`
(`runtime/harness-host/src/harness-registry.ts:14`) — **no deps argument, so there
is nowhere to pass `emitEvent`**. `runPi` then falls back:
`const emitEvent = deps.emitEvent ?? emitRunnerEvent` (`pi.ts:3914`), and
`defaultPiDeps()` supplies only `createSession` (`pi.ts:3900-3904`), so
`emitRunnerEvent` wins — and it does `process.stdout.write(JSON.stringify(event))`
(`pi.ts:884`). In-process that **is ts-runner's own stdout**, which runner-worker
parses as its event stream. Those events bypass `relayTsRunnerEvent` entirely: no
`persistWorkspaceHarnessSessionId` (resume breaks), no relay normalization — and
ts-runner, having seen nothing through its own `emitEvent`, reports
`terminalEmitted: false` and relays a spurious `run_failed` on top, which then
clears the session id (blocker 2 again).
→ Either widen `HarnessHostPlugin.run` to accept deps, or call `runPi` directly
for pi and leave every other harness on cold spawn. **Do not** use the generic
path in-process until the seam exists.

**4. End-of-turn compaction dies to SIGTERM.**
`runner-worker.ts:834` calls `killChildProcess(child, "SIGTERM")` the instant any
terminal event arrives. `killChildProcess` (`runtime-shell.ts:98-105`) tries
`process.kill(-pid)` first, but runner-worker spawns ts-runner **without
`detached`** (`:682`), so ts-runner is not a process-group leader → ESRCH → it
falls back to `child.kill()`, signalling only ts-runner. Today pi's post-terminal
`maybeCompactSessionOverThreshold()` — explicitly documented as running *after*
the terminal event — completes in the surviving grandchild. In-process,
`await runPi(...)` has not returned when SIGTERM lands and ts-runner installs no
SIGTERM handler, so **compaction is killed on every turn** and long sessions stop
shrinking until they blow the context window. (Windows already differs:
`taskkill /t` kills the tree.)
→ Install a SIGTERM handler in ts-runner that defers exit until the in-process
turn's finally has run, or move compaction ahead of the terminal event. Either
way this must be decided before the flag ships, not after.

**5. The 60 s first-event watchdog disappears.**
`HARNESS_HOST_FIRST_EVENT_TIMEOUT_MS = 60_000` (`ts-runner.ts:111`) is armed
inside `defaultRunHarnessHost` (`:1989`) and SIGKILLs a child that emits nothing —
its comment names exactly the case that matters, a bootstrap step (mcporter
transport open, app lifecycle probe) blocking indefinitely. In-process there is no
child to kill, so the same hung transport blocks to runner-worker's 30-minute
timeout.
→ Port the watchdog to an `AbortController` the in-process path honors, or accept
and **document** the regression explicitly. Silently dropping it is not an option.

**6. Hard-crash isolation (the tradeoff the draft did name).**
Today a pi crash kills the harness-host child; ts-runner survives, synthesizes
`run_failed`, and still runs its post-turn relay/persistence. In-process, a hard
crash (e.g. a native better-sqlite3 segfault) takes ts-runner down too — but
ts-runner is *itself* a disposable per-turn subprocess of api-server, so
**api-server stays isolated** and runner-worker reports the failed run on child
close. The residual regression is that a mid-turn hard crash skips ts-runner's
post-turn event relay for that turn. Keep the flag off by default and A/B before
flipping. Recoverable-error behavior is unchanged.

**Expected result:** `harness_load` ≈ 0; `ts_runner_load` grows (pi + mcporter +
SDK now cold-load into ts-runner's own V8, still per-turn) — the net could be
materially less than `harness_load`. This is a **measurement-gated** change, not a
proven win: the CLI proves *functional* fidelity but runs pi from `.ts`/tsx (never
the prod `dist` bundle, and inside harness-host's patched install) and returns
`undefined` for the harness timing fields, so it has **never measured this latency**.

**Gate before flipping the default:** A/B the *authoritative* `[ttft]` line
(`runner-worker.ts:928`, which keeps working because it derives from event arrival
+ `run_started`) on the **bundled** path, comparing `ts_runner_load + harness_load`
before/after. The in-process impl **must populate**
`harnessSpawnToFirst{Event,Token}Ms` in its `TsRunnerHarnessRelayResult`, or the
ts-runner-local `[ttft]` line logs `harness_load_ms=n/a` / `model_ttft_ms=n/a`.

**Abort/cancel (P1):** unchanged and fine — caller abort still SIGKILLs the
ts-runner child (`runner-worker.ts` timeout path), taking in-process pi with it.

**Rollback:** unset `HB_HARNESS_IN_PROCESS` (falls back to `defaultRunHarnessHost`).

---

## Phase 2 — warm harness-host session pool (mirror the MCP sidecar)

> **SHELVED (2026-08-18).** Lever 0 established that `session_setup` is already
> 62 ms (measured), so this phase and Phase 1 chase the same ~1,084 ms of `harness_load` —
> and Phase 1 gets it without retained sessions, a serve loop, a process pool, a
> cancel channel, or per-turn header re-resolution. Kept below for the record:
> the blocker analysis stays valid if the topology is ever revisited, and two of
> the blockers (per-turn identity welded into per-session structures; the
> unwired invalidation hook) are real bugs independent of this phase.
>
> **If it is ever revived, both gates still apply:** (a) a fresh `[ttft]` sample
> must show a residual `session_setup` large enough to matter, and (b) Phase 3's
> ownership move must land first, since the registry cannot live in a per-turn
> process.

**Idea:** keep a long-lived `harness-host serve` process **per active session**
that retains the loaded pi session in memory, so turns 2+ skip both the process
boot *and* `createSession`, doing only `sendUserMessage`.

> **Prerequisite spike.** Two premises are unproven and, if false, kill the saving:
> 1. **pi can serve a second `sendUserMessage` on a retained handle.** Every path
>    today disposes after one turn (`pi.ts:4253`, `:4451`) and end-of-turn
>    compaction is coupled to process exit. Prove a warm 2nd turn works
>    end-to-end — including compaction and pi's detached `_agentEventQueue` —
>    with no cross-turn leakage.
> 2. **Tool headers are re-resolvable per turn** (blocker 1 below). If not,
>    Phase 2 is a correctness bug, not an optimization.

### The fingerprint, corrected

**The draft's `config_fingerprint` could never hit.** It hashed `mcp_servers`,
but `buildHolabossRuntimeToolsMcpServerEntry` (`runtime/harnesses/src/harness-mcp.ts:47`)
bakes the **per-turn `x-holaboss-input-id`** into the server headers at
request-build time (`:67`, alongside `x-holaboss-session-id` at `:63`), and
`buildHarnessMcpServers` (`:28`) returns that as element 0. `input_id` is fresh
every turn, so `hash(mcp_servers)` differs on turn 2 → the 4-part reuse gate
fails → `terminatePid` + cold start. Phase 2 as drafted ships a **100% miss rate
and a net loss** (an extra terminate/respawn per turn), while passing any test
that reuses one `input_id`.

This is the *same* root cause as blocker 1 below — per-turn identity is welded
into per-session structures — so both are fixed by one change:

- **Split per-turn identity out of the session surface.** The fingerprint must
  hash the *shape* of the MCP/tool surface (server ids, urls, transports, tool
  refs) with `x-holaboss-input-id` — and any other per-turn header — **excluded**.
- **Reuse what exists.** `turnRequestSnapshotFingerprint` (`ts-runner.ts:366`) over
  `turnRequestSnapshotPayload` (`:425`) already hashes `system_prompt`, `tools`,
  `workspace_skill_ids`, prompt layers, `workspace_config_checksum` (`:456`) and
  the mcp payload, and is already computed every turn (`:2681`). Extend it with a
  per-turn-field exclusion list rather than inventing a second fingerprinter that
  will drift from it.
- Also include `model_client` (provider/base_url/model) so a rotated key forces a
  fresh host.

### Registry — extract from `workspace-mcp-sidecar.ts`, don't fork it

- File-backed state `harness-host-pool-state.json`, keyed by **`session_id`**.
- Entry: `{ session_id, url, pid, config_fingerprint, updated_at }`.
- **Reuse gate (4-part AND)**, same shape as the sidecar
  (`workspace-mcp-sidecar.ts:312-328`):
  `url present` ∧ `config_fingerprint match` ∧ `pidAlive(pid)` ∧ `healthProbe(url) < 500`.
  Any miss → `terminatePid` + evict + cold-start.
- **Extract, don't copy.** `nextLocalPort` (`:248`), `waitForWorkspaceMcpReady`
  (`:232`), the injectable `pidAlive` / `terminatePid` pair (`:25-26`, defaulting
  to `workspaceMcpPidAlive` / `terminateWorkspaceMcpPid` at `:312-313`) and the
  state read-write should move to a shared module. The draft said "copy
  `workspace-mcp-sidecar.ts`", which forks all of it — including the
  missing-teardown gap this plan wants to fix, so it would have to be fixed twice.
- **In-memory dedupe requires a resident owner.** The in-flight-promise dedupe and
  the idle-TTL/LRU timer are only implementable once api-server owns the lookup
  (see the revised ordering). Under a per-turn owner they are inert.
- **Per-session mutex, not the queue's lease** — see "Serialization is weaker
  than strictly serial" above.

### Serve protocol
- New `harness-host serve` mode: **remove the one-shot exit** (`index.ts:191`);
  instead listen on `127.0.0.1:<port>` (detached + `child.unref()` + stdio→file fds,
  exactly like the sidecar).
- Per request: `{ requestPayload }` → stream the **same NDJSON events** back over
  the HTTP response body that are emitted on stdout today
  (`parseHarnessHostRunnerEvent` is reused verbatim; only the transport changes).
- ts-runner's `runHarnessHost` becomes: `getOrStartWarmHarness(session_id, fingerprint)`
  → POST the turn → pipe the NDJSON stream through the existing relay.
- **Fallback must be gated on having emitted zero events.** The draft said "falls
  back to Phase-1 in-process if the warm path errors". The warm host owns the
  session: the moment it accepts the POST it appends the user message to the JSONL
  and starts streaming. If the stream then breaks (host OOM-killed, socket reset,
  LRU eviction racing the turn), re-running the same `input_id` in-process resumes
  from a JSONL that **already contains that user turn** — duplicated message, and
  a second event stream restarting at sequence 1 while the relay has already
  emitted higher sequences (it tracks `lastSequence = Math.max(...)`). "Warm is an
  optimization, never a hard dependency" only holds if the fallback checks that
  nothing was emitted; past the first event the turn must fail, not retry.

### Session retention in pi
- Refactor `defaultCreateSession` (`pi.ts:2890`) → `createOrReuseSession(session_id, fingerprint)`:
  - First turn: `createSession` as today, keep the handle in a module map.
  - Turn 2+ same `session_id` + fingerprint: reuse the handle, **skip** the
    expensive `session_setup` steps — BUT re-resolve per-turn tool headers first
    (blocker 1) and re-run `resource_reload` (blocker 5).
  - `session_id` change, fingerprint mismatch, or evict: `handle.dispose()` then
    create fresh.
- **Blockers to retaining the session (NOT just the one-shot exit):**
  1. **Per-turn tool-header staleness — primary correctness blocker.**
     `createSession` freezes the turn's `input_id`/`session_id` into the composio +
     runtime tool HTTP-header closures, and into the MCP server entry
     (`harness-mcp.ts:63-67`). `input_id` changes each turn, so a verbatim-reused
     session sends **turn-1's ids** on every later turn's tool call → wrong-turn
     metering/attribution. Fix: thread a *mutable* per-turn context into the header
     builders. Same fix as the fingerprint correction above.
  2. **One-shot exit** (`index.ts:191`) — replace with the serve loop.
  3. **Leaked process-global env:** `PI_CACHE_RETENTION` is mutated per-session
     (`pi.ts:2773-2782`) and restored only on dispose — warm skips dispose, so it
     persists; reset per turn or scope it off the global.
  4. **Retained mcporter stdio child processes:** keeping the session warm means
     *not* calling `runtime.close()`, so each warm host holds **N live MCP child
     processes** on top of the session — a process tree, not "a session in memory".
  5. **Stale skills and resources — new, and of the same class as blocker 1.**
     `await timedSetup("resource_reload", () => resourceLoader.reload())`
     (`pi.ts:2996`) is *inside* `createSession`, so it re-reads workspace
     resources and skills every turn today. Skipping `session_setup` on warm turns
     skips it. Note `workspace_skill_dirs` **is** a real request field
     (`claimed-input-executor.ts:1251`) — but it carries directory *paths*, and
     `workspace_config_checksum` covers `workspace.yaml`, so **neither hashes skill
     file bodies**. A user edits a `SKILL.md` mid-conversation, sends the next
     message, and the agent keeps running the old text with no cache-bust and no
     way to force one. Either re-run `resource_reload` on every warm turn (cheap —
     it is not the expensive step) or hash resource content into the fingerprint.
- Benign for reuse (confirmed): the two module memoizers
  (`cachedPrepareCompactionFnPromise`, `openAiApiErrorGeneratePatched`) are
  idempotent; no `process.chdir`.

### Lifecycle / RAM (the cost to manage)
- **Idle TTL** + **LRU cap** on warm hosts. **Size the cap independently of
  `DEFAULT_MAX_CONCURRENCY`** (`queue-worker.ts:23`). The draft read "max
  concurrency 5 → up to 5 warm process trees"; that number caps *concurrent runs*,
  and warm hosts by definition outlive their run. With a 5-minute idle TTL and a
  user moving between ten chats, ten hosts (each with N MCP children) are resident
  while at most one run is active. The pool is bounded by **distinct sessions
  touched per TTL**, so the cap must be an explicit number.
- **Orphan reaping needs a sweep, not a lookup gate.** "Reap via the `pidAlive`
  gate on next lookup" never fires for an *abandoned* session: a user sends two
  messages and closes the chat, nobody requests that `session_id` again, and the
  detached host plus every mcporter child survives until reboot. Needs a periodic
  sweep over the state file plus kill-on-workspace-close and kill-on-shutdown —
  all of which live in api-server, reinforcing that Phase 3 comes first. Eviction
  must `dispose()` to reap the MCP children.
- **Credential lifetime (security):** a warm host retains `model_client.api_key`
  in memory and `authStorage` on disk (`pi.ts:2906-2910`) across turns. Evict +
  dispose on logout / auth change; `model_client` is in the fingerprint.
- Add a `warm_hit=true|false` field to the `[ttft]` line to measure hit rate and
  the actual turns-2+ saving.

**Expected result:** unknown until lever 0 re-measures. Turn 1 unchanged.

---

## Phase 3 — move the warm lookup into api-server

**Still optional, and now independent of Phase 2.** With Phase 2 shelved this is
no longer a prerequisite for anything — but the reasoning that made it one is
worth keeping: a warm pool needs a resident owner for its in-flight dedupe, its
idle-TTL/LRU timer and its orphan sweep, and ts-runner is per-turn and cannot
host any of them. So *if* a pool is ever built, this comes first.

On its own merits it targets `ts_runner_load` (~270 ms) plus whatever of
`bootstrap` (~960 ms) can be hoisted — a bigger prize than it looks, especially
once lever 0b removes the composio fetch from that bucket. Requires
caching/hoisting the compile+memory step out of ts-runner. Worth reconsidering
after Phase 1 and 0b are measured.

## Risks / open questions
- ~~**Is the composio cache actually hitting?**~~ **Answered 2026-08-18: yes**,
  unconditionally for the session-setup fetch, TTL-dependent for bootstrap's.
- **How often does bootstrap's fetch actually hit?** Unknown — it depends on the
  distribution of inter-turn gaps against a 120 s TTL. Lever 0b makes the
  question moot by letting the TTL rise; until then, worth a line in the sample.
- **Net of Phase 1** — does the fatter ts-runner bundle eat the `harness_load`
  win? Measure before flipping the default. With Phase 2 shelved, **Phase 1 is
  now the only lever aimed at `harness_load`**, so this measurement decides
  whether that ~1.1 s is reachable at all.
- ~~**Is `clearComposioInlineCache` safe to wire?**~~ **Checked: yes.** It takes a
  `workspaceDir`, and `RuntimeAgentToolsService` resolves one from any
  `workspaceId` via `this.store.workspaceDir(...)` (used at
  `runtime-agent-tools.ts:6472`, `:6684`, `:7616` among others). Every
  connect / disconnect / install path already carries the workspace id, so
  lever 0b really is a call per site. Remaining care: pick **every** mutation
  site, not just the happy-path connect — a missed disconnect leaves a
  connected-looking tool in the listing for the whole (now longer) TTL.
- **Phase 1 is not "reused verbatim" by Phase 2.** Both call `runPi` in-process
  and share the `emitEvent` adapter, but Phase 2's hard part —
  `createOrReuseSession` with per-turn header re-resolution, retained MCP runtime,
  serve loop, cancel channel — is *not* touched by Phase 1. Phase 1 de-risks the
  in-process path; it does not pre-build Phase 2's session-retention correctness.
- **RAM** — warm sessions amplify memory-tree bloat; the TTL/LRU cap is
  load-bearing, not optional, and must be sized on its own terms.
- **Cancel/abort over a persistent connection** — today abort = kill the child;
  Phase 2 needs an explicit cancel channel (POST `/cancel?session_id`) since the
  host must survive the turn.
- **Fingerprint completeness** — err toward including fields; a false-negative
  just costs a cold start. But **exclude per-turn identity**, or the gate can
  never pass.
- **Non-pi harnesses** — Claude Code / ACP stay on cold spawn until ported.

## Measurement
Existing `[ttft]` line is the scoreboard. **Check the sample into the repo this
time.** Add `warm_hit` (Phase 2). Success = median `harness_load`→~0 (P1) and
turns-2+ `session_setup`→~0 (P2), with `total_ttft` minus `model_ttft` dropping
from ~3 s toward <1 s.

---

## What changed in the revision

Reviewed against `main` at `1be12c5` on 2026-08-18. Fourteen issues, then lever 0
was resolved the same day by tracing the code. The four things that change what
gets built:

1. **`session_setup` was stale, and is now dead.** The composio cross-turn cache
   landed two days after this doc was written. Tracing it end-to-end showed the
   session-setup fetch — 95% of `session_setup` — hits the cache on **every**
   turn including turn 1, because bootstrap writes it and is awaited before
   harness-host is spawned with the same `workspace_dir`. `session_setup` is
   62 ms, not ~715 ms (measured 2026-08-18).
2. **Phase 2 is therefore shelved, not merely re-ordered.** Its budget was
   `harness_load` + `session_setup` ≈ 1.8 s; the real figure is ~1.1 s of
   `harness_load`, which is exactly what Phase 1 removes at far lower risk.
3. **New lever 0b, the best leverage÷risk on the board.**
   `clearComposioInlineCache` is exported, tested and documented as the
   connect/install invalidation hook — and **never called**. Wiring it lets the
   120 s TTL rise, buying bootstrap's ~773 ms fetch on most turns *and* fixing a
   freshness bug (a newly connected integration is currently invisible for up to
   two minutes).
4. **Phase 2's fingerprint could never match**, because it hashed `mcp_servers`,
   which embeds the per-turn `x-holaboss-input-id` — so as drafted it was a net
   loss. Corrected (and kept, since the same root cause is a live bug in blocker
   1). Its registry also cannot live in ts-runner, a per-turn process.

Also added: Phase 1's packaging blocker (api-server does not depend on
harness-host, and the pi patches live in harness-host's install); five Phase 1
lifecycle regressions that the subprocess is silently providing today
(`terminalEmitted` honesty, post-terminal failure clobbering the resume pointer,
`plugin.run` having no event seam, SIGTERM killing compaction, the lost 60 s
watchdog); Phase 2's `resource_reload` skip staling skills; the retry-after-partial-
stream double-append; orphan reaping needing a sweep; LRU sizing decoupled from
`DEFAULT_MAX_CONCURRENCY`; and a correction to the "strictly serial" claim.

Corrected from the review: `workspace_skill_dirs` **does** exist
(`claimed-input-executor.ts:1251`) — the finding that flagged it as fictional was
wrong, though the staleness problem it pointed at is real for a different reason
(it holds paths, not content).

All file:line anchors were re-verified; the pre-revision draft's had drifted 4–207
lines, and `pi.ts` was ambiguous between two files.
