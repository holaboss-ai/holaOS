import type { ZodTypeAny } from "zod"
import { z } from "zod"
import type {
  ActionDef,
  AppConfig,
  AppHandle,
  AppState,
  BridgeClient,
  DerivedTool,
  ResourceDef,
  ResourceHandle,
  RowOf,
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
  }): Promise<any>
  _invokeReverse(opts: {
    actionName: string
    rowId: string
    bridge: BridgeClient
  }): Promise<any>
  _runSync(name: string, bridge: BridgeClient): Promise<SyncRunResult>
  _state: RuntimeState
  _setTurn(ctx: TurnContext | null): void
  _resources: Map<string, ResourceHandle<any, any>>
  _actions: RegisteredAction[]
  _syncs: RegisteredSync[]
}

export function createApp(config: AppConfig): AppHandleInternal {
  const state = new RuntimeState()
  const resources = new Map<string, ResourceHandle<any, any>>()
  const actions: RegisteredAction[] = []
  const syncs: RegisteredSync[] = []
  let connectionCalled = false

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
      ref: () => z.string().brand<typeof name>(),
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
    start,
    derivedTools,
    state: getStateSnapshot,
    _state: state,
    _resources: resources,
    _actions: actions,
    _syncs: syncs,
    _setTurn: (ctx) => state.setTurnContext(ctx),
    async _invokeAction({ actionName, rowId, input, bridge }) {
      const reg = actions.find(a => a.name === actionName)
      if (!reg) throw new Error(`action ${actionName} not registered`)
      return runAction({
        appId: config.id,
        resourceName: reg.resource.name,
        resourceDef: reg.resource.def,
        actionName: reg.name,
        actionDef: reg.def,
        rowId,
        input: (input ?? {}) as Record<string, unknown>,
        bridge,
        state,
      })
    },
    async _invokeReverse({ actionName, rowId, bridge }) {
      const reg = actions.find(a => a.name === actionName)
      if (!reg) throw new Error(`action ${actionName} not registered`)
      if (!reg.def.reversible) {
        throw new Error(`action ${actionName} is not reversible`)
      }
      const row = state.getRow(rowId)
      if (!row) throw new Error(`row ${rowId} not found`)
      if (row.status !== reg.def.toState) {
        return {
          fail: {
            code: "invalid_state",
            message: `cannot reverse ${actionName}: row is in '${row.status}', expected '${reg.def.toState}'`,
          },
        }
      }
      const reverseDef: ActionDef<Record<string, unknown>, StateTuple, Record<string, unknown>> = {
        fromStates: [reg.def.toState as string],
        toState: reg.def.reversible.toState,
        run: reg.def.reversible.run,
      }
      return runAction({
        appId: config.id,
        resourceName: reg.resource.name,
        resourceDef: reg.resource.def,
        actionName: `cancel_${reg.name}`,
        actionDef: reverseDef,
        rowId,
        input: {},
        bridge,
        state,
      })
    },
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
