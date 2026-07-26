import type { ZodTypeAny } from "zod"
import { z } from "zod"
import type {
  ActionDef,
  AppConfig,
  AppHandle,
  AppState,
  BridgeClient,
  DerivedTool,
  Infer,
  ResourceDef,
  ResourceHandle,
  RowOf,
  StateBackend,
  StateTuple,
  SyncDef,
  TurnContext,
} from "./types.ts"
import { RuntimeState } from "./runtime/state.ts"
import { runAction } from "./runtime/action-runner.ts"
import { runSync, type SyncRunResult } from "./runtime/sync-runner.ts"

// Storage shape — homogeneous so the actions[] array can hold registrations
// from different resources/schemas. Agent-facing type safety lives at the
// app.action<TS, S, I>(...) call site, not at storage. The runtime operates
// on Record<string, unknown> rows by design, so widening here is honest.
interface RegisteredAction {
  resource: ResourceHandle<ZodTypeAny, StateTuple>
  name: string
  def: ActionDef<Record<string, unknown>, StateTuple, Record<string, unknown>>
}

interface RegisteredSync {
  name: string
  def: SyncDef<ZodTypeAny, unknown, unknown>
}

export interface AppHandleInternal extends AppHandle {
  _invokeAction(opts: {
    actionName: string
    rowId: string
    input?: unknown
    bridge: BridgeClient
    turnContext?: TurnContext | null
  }): Promise<any>
  _invokeReverse(opts: {
    actionName: string
    rowId: string
    bridge: BridgeClient
    turnContext?: TurnContext | null
  }): Promise<any>
  _runSync(name: string, bridge: BridgeClient): Promise<SyncRunResult>
  _state: StateBackend
  _setTurn(ctx: TurnContext | null): void
  _resources: Map<string, ResourceHandle<any, any>>
  _actions: RegisteredAction[]
  _syncs: RegisteredSync[]
}

/**
 * createApp options. `backend` defaults to in-memory; production runtime
 * should pass a SqliteStateBackend (see runtime/state-backend-sqlite.ts).
 */
export interface CreateAppOptions {
  backend?: StateBackend
}

export function createApp(config: AppConfig, options: CreateAppOptions = {}): AppHandleInternal {
  const state: StateBackend = options.backend ?? new RuntimeState()
  const resources = new Map<string, ResourceHandle<any, any>>()
  const actions: RegisteredAction[] = []
  const syncs: RegisteredSync[] = []
  let connectionCalled = false
  let currentTurnContext: TurnContext | null = null

  function setTurnContext(ctx: TurnContext | null): void {
    currentTurnContext = ctx
    state.setTurnContext(ctx)
  }

  function withTemporaryTurnContext<T>(ctx: TurnContext | null | undefined, fn: () => T): T {
    if (ctx === undefined) {
      return fn()
    }
    const previous = currentTurnContext
    setTurnContext(ctx)
    try {
      return fn()
    } finally {
      setTurnContext(previous)
    }
  }

  function connection(_opts?: { whoamiPath?: string }): void {
    connectionCalled = true
  }

  function resource<TSchema extends ZodTypeAny, States extends StateTuple>(
    name: string,
    def: ResourceDef<TSchema, States>,
  ): ResourceHandle<TSchema, States> {
    if (!(def.states as readonly string[]).includes(def.initialState)) {
      throw new Error(
        `[${config.id}] resource '${name}': initialState '${def.initialState}' not in states [${def.states.join(",")}]`,
      )
    }
    if (def.failedState !== undefined && !(def.states as readonly string[]).includes(def.failedState)) {
      throw new Error(
        `[${config.id}] resource '${name}': failedState '${def.failedState}' not in states [${def.states.join(",")}]`,
      )
    }
    const handle: ResourceHandle<TSchema, States> = {
      __resource: true,
      name,
      states: def.states,
      schema: def.schema,
      def,
      // ref() returns plain z.string() (NOT branded). Branding broke round-trip
      // updates — provider responses come back as plain strings and couldn't
      // satisfy the brand, forcing `as` casts at every persist call.
      // The semantic "this is an <X> id" is documented by the field name +
      // schema location; type-system enforcement adds more friction than value.
      ref: () => z.string(),
    }
    resources.set(name, handle)
    return handle
  }

  function action<TSchema extends ZodTypeAny, States extends StateTuple, I = {}>(
    res: ResourceHandle<TSchema, States>,
    name: string,
    def: ActionDef<RowOf<TSchema>, States, I>,
  ): void {
    if (!def.steps && !def.run) {
      throw new Error(`[${config.id}] action ${name}: must provide either run or steps`)
    }
    if (def.steps && def.run) {
      throw new Error(`[${config.id}] action ${name}: provide either run or steps, not both`)
    }
    const allowed = res.def.states as readonly string[]
    for (const s of def.fromStates) {
      if (!allowed.includes(s as string)) {
        throw new Error(
          `[${config.id}] action ${name}: fromStates contains '${s}' not in resource '${res.name}' states [${allowed.join(",")}]`,
        )
      }
    }
    if (def.toState !== null && !allowed.includes(def.toState as string)) {
      throw new Error(
        `[${config.id}] action ${name}: toState '${def.toState}' not in resource '${res.name}' states [${allowed.join(",")}]`,
      )
    }
    if (def.reversible && !allowed.includes(def.reversible.toState as string)) {
      throw new Error(
        `[${config.id}] action ${name}: reversible.toState '${def.reversible.toState}' not in resource '${res.name}' states`,
      )
    }
    if (def.failedState !== undefined && !allowed.includes(def.failedState as string)) {
      throw new Error(
        `[${config.id}] action ${name}: failedState '${def.failedState}' not in resource '${res.name}' states`,
      )
    }
    // Single intentional widening at storage boundary — runtime operates on
    // Record<string, unknown> rows, so the precise TSchema/I types are
    // discarded here. The agent's compile-time guarantee lives at the
    // app.action<TSchema, States, I>(...) call above; storage doesn't need it.
    actions.push({
      resource: res as unknown as ResourceHandle<ZodTypeAny, StateTuple>,
      name,
      def: def as unknown as ActionDef<Record<string, unknown>, StateTuple, Record<string, unknown>>,
    })
  }

  function sync<TSchema extends ZodTypeAny, RAW, N>(
    name: string,
    def: SyncDef<TSchema, RAW, N>,
  ): void {
    // Storage widens: runtime calls fetch/normalize generically. Agent-side
    // typing was preserved at the app.sync<TSchema, RAW, N>(...) call above.
    syncs.push({
      name,
      def: def as unknown as SyncDef<ZodTypeAny, unknown, unknown>,
    })
  }

  async function start(): Promise<void> {
    if (!connectionCalled) {
      throw new Error(`[${config.id}] app.connection() must be called before app.start()`)
    }
  }

  function createRow<TSchema extends ZodTypeAny, States extends StateTuple>(
    resource: ResourceHandle<TSchema, States>,
    data: Infer<TSchema>,
    options: { status?: States[number]; turnContext?: TurnContext | null } = {},
  ): RowOf<TSchema> {
    const status = options.status ?? resource.def.initialState
    if (!(resource.def.states as readonly string[]).includes(status)) {
      throw new Error(
        `[${config.id}] createRow('${resource.name}'): status '${status}' not in states [${resource.def.states.join(",")}]`,
      )
    }
    return withTemporaryTurnContext(options.turnContext, () => {
      const row = state.insertRow(resource.name, data as Record<string, unknown>, status)
      return rowRecordView<TSchema>(row)
    })
  }

  function getRow<TSchema extends ZodTypeAny, States extends StateTuple>(
    resource: ResourceHandle<TSchema, States>,
    rowId: string,
  ): RowOf<TSchema> | null {
    const row = state.getRow(rowId)
    if (!row || row.resource !== resource.name) {
      return null
    }
    return rowRecordView<TSchema>(row)
  }

  function listRows<TSchema extends ZodTypeAny, States extends StateTuple>(
    resource: ResourceHandle<TSchema, States>,
  ): RowOf<TSchema>[] {
    return state.rowsByResource(resource.name).map((row) => rowRecordView<TSchema>(row))
  }

  async function runRegisteredAction(params: {
    actionName: string
    rowId: string
    input?: unknown
    bridge: BridgeClient
    turnContext?: TurnContext | null
  }): Promise<any> {
    const reg = actions.find(a => a.name === params.actionName)
    if (!reg) throw new Error(`action ${params.actionName} not registered`)
    const turnContext =
      params.turnContext === undefined ? currentTurnContext : params.turnContext
    return await runAction({
      appId: config.id,
      resourceName: reg.resource.name,
      resourceDef: reg.resource.def,
      actionName: reg.name,
      actionDef: reg.def,
      rowId: params.rowId,
      input: (params.input ?? {}) as Record<string, unknown>,
      bridge: params.bridge,
      state,
      turnContext,
    })
  }

  async function runRegisteredReverse(params: {
    actionName: string
    rowId: string
    bridge: BridgeClient
    turnContext?: TurnContext | null
  }): Promise<any> {
    const reg = actions.find(a => a.name === params.actionName)
    if (!reg) throw new Error(`action ${params.actionName} not registered`)
    if (!reg.def.reversible) {
      throw new Error(`action ${params.actionName} is not reversible`)
    }
    const row = state.getRow(params.rowId)
    if (!row) throw new Error(`row ${params.rowId} not found`)
    if (row.status !== reg.def.toState) {
      return {
        fail: {
          code: "invalid_state",
          message: `cannot reverse ${params.actionName}: row is in '${row.status}', expected '${reg.def.toState}'`,
        },
      }
    }
    const reverseDef: ActionDef<Record<string, unknown>, StateTuple, Record<string, unknown>> = {
      fromStates: [reg.def.toState as string],
      toState: reg.def.reversible.toState,
      run: reg.def.reversible.run,
    }
    const reverseResourceDef = { ...reg.resource.def, failedState: undefined }
    const turnContext =
      params.turnContext === undefined ? currentTurnContext : params.turnContext
    return await runAction({
      appId: config.id,
      resourceName: reg.resource.name,
      resourceDef: reverseResourceDef,
      actionName: `cancel_${reg.name}`,
      actionDef: reverseDef,
      rowId: params.rowId,
      input: {},
      bridge: params.bridge,
      state,
      turnContext,
    })
  }

  function derivedTools(): DerivedTool[] {
    const tools: DerivedTool[] = []

    if (connectionCalled) {
      tools.push({
        name: `${config.id}_connection_status`,
        inputShape: "{}",
        description: `Check ${config.id} connection state.`,
        category: "connection",
      })
    }

    for (const [rname, rhandle] of resources) {
      tools.push({
        name: `${config.id}_list_${plural(rname)}`,
        inputShape: "{ status?, limit? }",
        description: `List ${rname} rows.`,
        category: "resource_query",
      })
      tools.push({
        name: `${config.id}_get_${rname}`,
        inputShape: `{ ${rname}_id }`,
        description: `Fetch a single ${rname}.`,
        category: "resource_query",
      })
      if (rhandle.def.refreshEvery) {
        tools.push({
          name: `${config.id}_refresh_${plural(rname)}`,
          inputShape: "{}",
          description: `Force-refresh ${rname} cache.`,
          category: "resource_query",
        })
      }
    }

    for (const { resource: r, name, def } of actions) {
      const toolName = def.toolName ?? `${config.id}_${name}_${r.name}`
      tools.push({
        name: toolName,
        inputShape: `{ ${r.name}_id${def.schema ? ", ...extra" : ""} }`,
        description: `${name} a ${r.name} (from ${def.fromStates.join("|")} → ${def.toState ?? "side-effect"}).`,
        category: "action",
      })
      if (def.reversible) {
        const reverseToolName = def.toolName
          ? `${def.toolName}_reverse`
          : `${config.id}_cancel_${name}_${r.name}`
        tools.push({
          name: reverseToolName,
          inputShape: `{ ${r.name}_id }`,
          description: `Reverse ${name} on a ${r.name} (→ ${def.reversible.toState}).`,
          category: "reverse_action",
        })
      }
    }

    for (const { name } of syncs) {
      tools.push({
        name: `${config.id}_${name}_sync_status`,
        inputShape: "{}",
        description: `Status of ${name} sync.`,
        category: "sync",
      })
    }

    tools.push({
      name: `${config.id}_snapshot`,
      inputShape: "{}",
      description: `Compact situational read of ${config.id}.`,
      category: "snapshot",
    })

    return tools
  }

  function getStateSnapshot(): AppState {
    const snap = state.snapshot()
    snap.derivedTools = derivedTools()
    return snap
  }

  return {
    config,
    connection,
    resource,
    action,
    sync,
    createRow,
    getRow,
    listRows,
    runAction: runRegisteredAction,
    reverseAction: runRegisteredReverse,
    start,
    derivedTools,
    state: getStateSnapshot,
    _state: state,
    _resources: resources,
    _actions: actions,
    _syncs: syncs,
    _setTurn: setTurnContext,
    _invokeAction: runRegisteredAction,
    _invokeReverse: runRegisteredReverse,
    async _runSync(name, bridge) {
      const reg = syncs.find(s => s.name === name)
      if (!reg) throw new Error(`sync ${name} not registered`)
      return runSync({
        appId: config.id,
        syncName: reg.name,
        syncDef: reg.def,
        bridge,
        state,
      })
    },
  }
}

function plural(name: string): string {
  if (name.endsWith("s") || name.endsWith("x") || name.endsWith("ch")) return `${name}es`
  if (name.endsWith("y")) return `${name.slice(0, -1)}ies`
  return `${name}s`
}

function rowRecordView<TSchema extends ZodTypeAny>(row: {
  id: string
  status: string
  data: Record<string, unknown>
  externalId?: string
}): RowOf<TSchema> {
  return {
    ...row.data,
    id: row.id,
    status: row.status,
    external_id: row.externalId,
  } as RowOf<TSchema>
}
