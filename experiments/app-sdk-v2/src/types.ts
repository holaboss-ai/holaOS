import type { ZodSchema, ZodTypeAny, z } from "zod"

// ─── Bridge ────────────────────────────────────────────────────────────────

export type BridgeErrorCode =
  | "not_connected"
  | "rate_limited"
  | "not_found"
  | "validation_failed"
  | "upstream_error"

export interface BridgeError {
  kind: "error"
  code: BridgeErrorCode
  message: string
  upstreamStatus?: number
  upstreamBody?: unknown
  retryAfter?: number
  reauthUrl?: string
}

export type ProxyResult<T = unknown> =
  | { kind: "ok"; data: T; status: number }
  | BridgeError

export interface BridgeClient {
  call<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<ProxyResult<T>>
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

// ─── Provider Registry ─────────────────────────────────────────────────────

export interface ProviderRegistry {
  id: string
  baseUrl: string
  allowedHosts: string[]
  whoamiPath?: string
  composioToolkit?: string
}

// ─── Type helpers: schema → row type vending ───────────────────────────────
//
// The agent declares schema once (z.object({...})). All callbacks
// (step.run / emit / db.query) receive a row typed as the inferred shape
// PLUS system fields { id, status, external_id }. No more `as any` chasing.

export type Infer<TSchema extends ZodTypeAny> = z.infer<TSchema>

export type RowOf<TSchema extends ZodTypeAny> = Infer<TSchema> & {
  id: string
  status: string
  external_id?: string
}

// ─── Resource ──────────────────────────────────────────────────────────────

export type StateTuple = readonly [string, ...string[]]

export interface EmitConfig<TRow> {
  surface: string                            // "content_plan" | "ops_log" | "none" | <agent-defined>
  summary?: (row: TRow) => string | null
  deepLink?: (row: TRow) => string | null
}

export interface ResourceDef<TSchema extends ZodTypeAny, States extends StateTuple> {
  schema: TSchema
  states: States
  initialState: States[number]
  /** Where to put row when an action on it fails. Optional — if absent, status preserved on failure. */
  failedState?: States[number]
  emit?: EmitConfig<RowOf<TSchema>>
  refreshEvery?: string
  fetch?: (ctx: { bridge: BridgeClient }) => Promise<Infer<TSchema>[]>
}

export interface ResourceHandle<TSchema extends ZodTypeAny = ZodTypeAny, States extends StateTuple = StateTuple> {
  __resource: true
  name: string
  states: States
  schema: TSchema
  def: ResourceDef<TSchema, States>
  /** Foreign-key reference. Returns a branded zod string schema. */
  ref(): ZodSchema<string>
}

// ─── Action ────────────────────────────────────────────────────────────────

export type StepResult<TOut = {}> =
  | { ok: true; data?: TOut; externalId?: string }
  | { fail: BridgeError | { kind: "error"; code: string; message: string } }

export interface StepContext<TRow, TInput> {
  row: TRow
  input: TInput
  bridge: BridgeClient
  persist: (patch: Partial<TRow>) => Promise<void>
  log: (msg: string, extra?: Record<string, unknown>) => void
}

export interface Step<TRow, TInput, TOut = {}> {
  name: string
  run: (ctx: StepContext<TRow, TInput>) => Promise<StepResult<TOut>>
}

export interface ReversibleDef<TRow, States extends StateTuple> {
  toState: States[number]
  run: (ctx: StepContext<TRow, {}>) => Promise<StepResult>
}

/**
 * SDK boundary: ActionDef describes HOW to do something — its inputs, steps,
 * state transitions, and reversal path. WHEN to do it (now / in 5h / every
 * Monday) is NOT an SDK concern; that lives in the Holaboss automations
 * subsystem. The SDK therefore intentionally has NO `schedulable` flag and NO
 * retry policy — re-invocation on failure is the caller's choice.
 *
 * Actions MUST be idempotent: re-running an action on a row that already
 * carries persisted intermediate state (e.g. media_id from a prior failed
 * publish attempt) must safely no-op the already-done steps. Use row.external_id
 * and row.<persisted_field> to detect "already done".
 */
export interface ActionDef<TRow, States extends StateTuple, I = {}> {
  fromStates: readonly States[number][]
  /**
   * State to put the row in on success.
   * `null` = side-effect action; row.status is NOT changed, NO output is re-emitted.
   */
  toState: States[number] | null
  schema?: ZodSchema<I>
  /** Override the auto-derived tool name. Default: `<app>_<action>_<resource>`.
   *  If overridden, the reverse tool becomes `<toolName>_reverse`. */
  toolName?: string
  reversible?: ReversibleDef<TRow, States>
  // exactly one of:
  run?: (ctx: StepContext<TRow, I>) => Promise<StepResult>
  steps?: Step<TRow, I>[]
}

// ─── Sync ──────────────────────────────────────────────────────────────────
//
// A sync is just a special background action that automations triggers on a
// `schedule` hint. The SDK provides the execution machinery (DbView, upsert,
// normalize); the SDK does NOT internally schedule.
//
// fetch() MUST return an explicit ok/error union — the SDK distinguishes
// "upstream succeeded with 0 items" from "upstream failed". Returning an empty
// array on failure (the old pattern) would silently mask outages from
// dashboards and automations retry logic.

export type SyncFetchResult<TRaw> =
  | { ok: true; items: TRaw[] }
  | { ok: false; error: BridgeError | { kind: "error"; code: string; message: string } }

export interface SyncDef<TSchema extends ZodTypeAny, TRaw, TNormalized> {
  /** Hint to automations (cron expression). SDK does not enforce. */
  schedule: string
  /** The resource these metrics attach to (for deep_link / aggregation). */
  attachTo?: ResourceHandle<TSchema, any>
  fetch: (ctx: { bridge: BridgeClient; db: DbView }) => Promise<SyncFetchResult<TRaw>>
  upsert: { key: keyof TRaw & string }
  normalize: (raw: TRaw) => TNormalized
}

// ─── DbView ────────────────────────────────────────────────────────────────
//
// where() supports scalar-equality filtering only. Arrays / objects are
// excluded at the type level because the runtime uses === comparison and
// can't meaningfully match deeply.

type ScalarValue = string | number | boolean | null | undefined
type ScalarKeys<T> = {
  [K in keyof T]-?: T[K] extends ScalarValue ? K : never
}[keyof T]
type ScalarFilter<T> = Partial<Pick<T, ScalarKeys<T>>>

export interface DbView {
  query<TSchema extends ZodTypeAny, States extends StateTuple>(
    resource: ResourceHandle<TSchema, States>,
  ): {
    where: (cond: ScalarFilter<RowOf<TSchema> & { status: States[number] }>) => {
      recent: (window: string) => RowOf<TSchema>[]
      all: () => RowOf<TSchema>[]
    }
    all: () => RowOf<TSchema>[]
  }
}

// ─── App ───────────────────────────────────────────────────────────────────

export interface AppConfig {
  id: string
  provider: ProviderRegistry
  description?: string
}

export interface DerivedTool {
  name: string
  inputShape: string
  description: string
  category: "connection" | "resource_query" | "action" | "reverse_action" | "sync" | "snapshot"
}

export interface AppHandle {
  config: AppConfig
  connection(opts?: { whoamiPath?: string }): void
  resource<TSchema extends ZodTypeAny, States extends StateTuple>(
    name: string,
    def: ResourceDef<TSchema, States>,
  ): ResourceHandle<TSchema, States>
  action<TSchema extends ZodTypeAny, States extends StateTuple, I = {}>(
    resource: ResourceHandle<TSchema, States>,
    name: string,
    def: ActionDef<RowOf<TSchema>, States, I>,
  ): void
  sync<TSchema extends ZodTypeAny, RAW, N>(
    name: string,
    def: SyncDef<TSchema, RAW, N>,
  ): void
  start(): Promise<void>
  derivedTools(): DerivedTool[]
  state(): AppState
}

// ─── Internal runtime state ────────────────────────────────────────────────

export interface RowRecord {
  id: string
  resource: string
  status: string
  data: Record<string, unknown>
  externalId?: string
  errorMessage?: string
  scheduledAt?: string
  createdInTurn?: string
  sessionId?: string
  createdAt: string
  updatedAt: string
}

export interface AuditEntry {
  at: string
  event: "action.start" | "step.complete" | "action.retry" | "action.end" | "tool.call" | "sync.start" | "sync.end"
  fields: Record<string, unknown>
}

export interface OutputCard {
  resourceName: string
  rowId: string
  surface: string
  status: string
  summary: string | null
  deepLink: string | null
  updatedAt: string
}

export interface NotificationEntry {
  at: string
  level: "info" | "warning" | "error"
  summary: string
  agentHint?: string
  ref?: { kind: string; id: string }
}

export interface SyncRecord {
  syncName: string
  attachedRowId: string                       // the row from the attachTo resource
  key: string
  raw: Record<string, unknown>
  normalized: Record<string, unknown>
  syncedAt: string
}

export interface AppState {
  rows: RowRecord[]
  audit: AuditEntry[]
  outputs: OutputCard[]
  notifications: NotificationEntry[]
  syncRecords: SyncRecord[]
  derivedTools: DerivedTool[]
}

export interface TurnContext {
  turnId: string
  sessionId: string
}
