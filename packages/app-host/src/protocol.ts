// Holaboss desktop host bridge — shared protocol.
//
// Imported by BOTH sides so they can never drift:
//   - the web client (@holaboss/app-host, this package's main entry)
//   - the desktop app-surface preload + main process (apps/desktop, via a
//     workspace:* dep)
//
// Pure types + constants. No runtime dependencies. See
// docs/plans/2026-06-23-holaapp-desktop-host-bridge.md.

/** Bridge protocol version. Additive ops that a page must feature-detect bump
 *  this so `window.__holabossHost.version` gates them; a hosted page checks
 *  `version >= N`. v2 adds `item.open`; v3 adds `holahub.consume-pending-share`. */
export const BRIDGE_VERSION = 3 as const;

/** The global the app-surface preload injects into the hosted HolaApp page. */
export const HOST_GLOBAL_KEY = "__holabossHost" as const;

/** IPC channels between the app-surface preload and the desktop main process. */
export const HOST_IPC = {
  capabilities: "appSurface:host:capabilities",
  invoke: "appSurface:host:invoke",
} as const;

/** Event main → shell renderer: "open this chat with this input". */
export const HOST_RENDERER_EVENT = "host:openChat" as const;

/** Event main → shell renderer: "install this item" (carries a requestId).
 *  Fired when a hosted page (e.g. HolaHub) invokes the `install` op. The shell
 *  installs it HEADLESSLY (in place — no navigation) for keyless items, or opens
 *  the native connect surface for keyed/gated ones, then replies via
 *  HOST_INSTALL_RESULT so the invoking page can reflect the outcome. */
export const HOST_INSTALL_EVENT = "host:openInstall" as const;

/** Event shell renderer → main: the install ran; here's its outcome. Correlated
 *  back to the pending `install` invoke by requestId. */
export const HOST_INSTALL_RESULT = "host:installResult" as const;

/** Event main → shell renderer: "report what's installed" (carries a requestId).
 *  Fired when a hosted page invokes `install.status`; the shell replies via
 *  HOST_INSTALL_STATUS_RESULT with the installed items so the page can reflect an
 *  "Installed" state instead of always offering "Install". */
export const HOST_INSTALL_STATUS_EVENT = "host:installStatus" as const;

/** Event shell renderer → main: the installed-items list (correlated by requestId). */
export const HOST_INSTALL_STATUS_RESULT = "host:installStatusResult" as const;

/** Event main → shell renderer: "open this already-installed item". Fired when a
 *  hosted page (HolaHub) invokes `item.open` for a holaapp — the shell opens that
 *  app's surface. (skill/mcp/capability open a General chat instead, handled in
 *  main via the chat flow, so they don't use this event.) */
export const HOST_OPEN_APP_EVENT = "host:openApp" as const;

/** Event main → shell renderer: "the HolaEmployee roster changed — refetch it".
 *  Fired when a hosted page (the `/employees` surface) invokes `employees.changed`
 *  after creating / renaming / archiving an employee. Fire-and-forget: the shell
 *  invalidates its roster query so the sidebar reflects the change immediately,
 *  without the surface's gateway writes ever having to reach the desktop bridge. */
export const HOST_EMPLOYEES_CHANGED_EVENT = "host:employeesChanged" as const;

/** Op names. ADDITIVE only — never rename/remove an op once shipped. */
export const HOST_OPS = {
  chatStart: "chat.start",
  install: "install",
  installStatus: "install.status",
  itemOpen: "item.open",
  holahubConsumePendingShare: "holahub.consume-pending-share",
  employeesChanged: "employees.changed",
} as const;
export type HostOp = (typeof HOST_OPS)[keyof typeof HOST_OPS];

/** Result envelope every host op returns. */
export type HostResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

/** A generic, cross-app context object — the unit attached to the composer.
 *  Carries an inline snapshot (immediate grounding) AND refs + an MCP hint
 *  (so the agent can pull the live/full version via the app's MCP). */
export interface AppContext {
  /** hola_app_id, e.g. "need-review". */
  app: string;
  /** app-defined kind, e.g. "record" | "artifact" | "url". */
  kind: string;
  title: string;
  /** stable references the agent / app MCP can resolve, e.g. { recordId }. */
  refs?: Record<string, string>;
  /** an immediate, inline snapshot of the content. */
  snapshot?: {
    mime: "text/html" | "text/markdown" | "text/plain";
    content: string;
  };
  /** how the agent can expand it live via the app's MCP. */
  mcp?: { server: string; hint?: string };
}

// ── op: chat.start ────────────────────────────────────────────────────────

export interface ChatStartInput {
  /** Pre-filled composer text. */
  prompt?: string;
  /** Context objects attached to the composer as pills. */
  context?: AppContext[];
  /** Skills to quote in the composer as skill chips (their ids == workspace
   *  skill_id). Rendered as `/skill` chips, not generic context pills. */
  skillIds?: string[];
  /** Create a fresh session (default true). */
  newSession?: boolean;
  /** Auto-send instead of leaving an editable draft (default false). */
  autoSubmit?: boolean;
  /** Optional session title. */
  title?: string;
  /** Open a General (workspace-wide) session instead of one owned/tool-scoped by
   *  the calling HolaApp. Used by system surfaces like HolaHub whose hand-off
   *  belongs in General, not under an app row (default false → app-bounded). */
  general?: boolean;
}

export interface ChatStartResult {
  sessionId: string;
}

// ── op: install ───────────────────────────────────────────────────────────

/** A catalog item a hosted page (HolaHub) asks the desktop to install. Keyless
 *  items (skills, keyless MCPs, connect-free capabilities) install headlessly in
 *  place; keyed/gated ones open the native connect surface focused on `ref`. */
export interface InstallInput {
  type: "skill" | "mcp" | "holaapp" | "capability";
  /** The catalog id/slug in the source catalog. */
  ref: string;
  /** Credentials for a keyed item, keyed by required-key name. Supplied on a
   *  retry after a first call returned `needsConnect` with its `requiredKeys`. */
  values?: Record<string, string>;
}

/** Outcome of an install request.
 *  - `installed` — attached/installed just now (in place, no navigation).
 *  - `already`   — was already installed; nothing to do.
 *  - `needsConnect` — the item needs credentials/an integration first; the
 *    native connect surface was opened (`opened`) OR `requiredKeys` lists the
 *    keys the caller may collect and resend via InstallInput.values.
 *  - `error` — install failed; see `message`. */
export type InstallStatus = "installed" | "already" | "needsConnect" | "error";

export interface InstallResult {
  status: InstallStatus;
  /** Human-facing detail (error text, or why a connect is needed). */
  message?: string;
  /** needsConnect: the desktop opened its native connect surface for the item. */
  opened?: boolean;
  /** needsConnect: the required credential keys, if the caller can collect them
   *  and retry with InstallInput.values (else the native surface was opened). */
  requiredKeys?: string[];
}

/** Payload of HOST_INSTALL_EVENT (main → shell renderer). */
export interface InstallEventPayload extends InstallInput {
  /** Correlates the eventual HOST_INSTALL_RESULT back to the pending invoke. */
  requestId: string;
  /** The app-surface id that requested the install (e.g. "holahub"). */
  sourceAppId: string;
}

/** Payload of HOST_INSTALL_RESULT (shell renderer → main). */
export interface InstallResultMessage {
  requestId: string;
  result: InstallResult;
}

// ── op: install.status ────────────────────────────────────────────────────

/** One catalog item currently installed on this desktop (type + its catalog ref). */
export interface InstalledItem {
  type: InstallInput["type"];
  ref: string;
}

/** The result of `install.status` — everything installed, so an install surface
 *  can show "Installed" for items already present. */
export interface InstalledList {
  items: InstalledItem[];
}

/** Payload of HOST_INSTALL_STATUS_EVENT (main → shell renderer). */
export interface InstallStatusEventPayload {
  /** Correlates the eventual HOST_INSTALL_STATUS_RESULT back to the pending invoke. */
  requestId: string;
}

/** Payload of HOST_INSTALL_STATUS_RESULT (shell renderer → main). */
export interface InstallStatusResultMessage {
  requestId: string;
  list: InstalledList;
}

// ── op: item.open ─────────────────────────────────────────────────────────

/** An already-installed catalog item a hosted page (HolaHub) asks the desktop to
 *  open. A holaapp opens its surface; a skill/mcp/capability opens a General chat
 *  where the installed capability is available. */
export interface OpenItemInput {
  type: InstallInput["type"];
  ref: string;
  /** Display name of the item. For a skill/mcp/capability (which opens a chat)
   *  the desktop carries it into the new chat's composer as a context card, so a
   *  human-readable title beats a bare ref. Optional for back-compat. */
  title?: string;
}

export interface OpenItemResult {
  /** True when the desktop opened the item (a surface or a chat). */
  opened: boolean;
}

/** Payload of HOST_OPEN_APP_EVENT (main → shell renderer): open this holaapp's
 *  surface. The shell resolves the full app definition from the catalog by ref. */
export interface OpenAppEventPayload {
  ref: string;
}

// ── op: holahub.consume-pending-share ─────────────────────────────────────

/** One auto-attributed tool the shared output was made with — a catalog ref the
 *  HolaHub composer pre-attaches as a post item. */
export interface ShareDraftItem {
  type: "skill" | "mcp" | "holaapp" | "capability";
  ref: string;
  name: string;
}

/** A desktop output the shell staged for sharing. The shell (ChatPane) builds it
 *  and stages it via a trusted shell→main IPC; the HolaHub web surface pulls it
 *  once on its compose route via `holahub.consume-pending-share`, then prefills
 *  its composer. Everything here is user-editable in the composer. */
export interface ShareDraftImage {
  /** base64 (no data: prefix) of the generated image file. */
  dataBase64: string;
  contentType: string;
}

/** A generated document (pptx/docx/pdf/…) captured from a turn — base64, keeping
 *  the original file name; the composer uploads it on prefill. */
export interface ShareDraftFile {
  fileName: string;
  contentType: string;
  dataBase64: string;
}

/** One turn of a shared conversation — text + its captured media/files. No
 *  assistant internals (thinking/trace/tool args) — dropped at capture. */
// A simplified tool/phase step the assistant ran this turn (title only — no
// args/output details), for a "Worked across N steps" trace on the shared post.
export interface ShareDraftSessionStep {
  title: string;
  kind: "phase" | "tool";
}

export interface ShareDraftSessionTurn {
  role: "user" | "assistant";
  text: string;
  createdAt?: string | null;
  images?: ShareDraftImage[];
  videos?: ShareDraftImage[];
  files?: ShareDraftFile[];
  steps?: ShareDraftSessionStep[];
  /** Friendly name of the model behind this reply (assistant turns only). */
  model?: string;
}

export interface ShareDraft {
  title: string;
  /** Markdown body. Empty by default — the share centers on the produced
   *  artifact and the user writes their own caption (optionally AI-drafted from
   *  `sourceText`). */
  body: string;
  /** The assistant turn's text — NOT shown as the body; carried as hidden
   *  context so the composer's "draft with AI" button can seed a caption. */
  sourceText: string;
  /** Already uploaded to holahub_images; the composer attaches by id. */
  imageIds: string[];
  /** Generated images captured from the turn's outputs — the composer (which
   *  holds the session) uploads them on prefill. */
  images: ShareDraftImage[];
  /** Generated video(s) captured from the turn — same base64+upload path as
   *  images (size-capped upstream to keep IPC sane). */
  videos: ShareDraftImage[];
  /** Session tools resolved to catalog refs — the auto-attribution. */
  items: ShareDraftItem[];
  /** Provenance for analytics (e.g. "desktop_chat"). */
  source: string;
  /** When present, this is a whole-conversation share → a "session" post. */
  session?: { turns: ShareDraftSessionTurn[] };
}

// ── op: employees.changed ─────────────────────────────────────────────────

/** Input for `employees.changed` — a fire-and-forget nudge from the `/employees`
 *  surface telling the desktop shell to refetch its HolaEmployee roster. `reason`
 *  is advisory (for logging only); the shell just invalidates its roster query. */
export interface EmployeesChangedInput {
  reason?: "created" | "updated" | "archived";
}

/** Input/result per op — the contract the desktop dispatch table implements. */
export interface HostOpMap {
  "chat.start": { input: ChatStartInput; result: ChatStartResult };
  install: { input: InstallInput; result: InstallResult };
  "install.status": { input: Record<string, never>; result: InstalledList };
  "item.open": { input: OpenItemInput; result: OpenItemResult };
  "holahub.consume-pending-share": {
    input: Record<string, never>;
    result: ShareDraft | null;
  };
  "employees.changed": {
    input: EmployeesChangedInput;
    result: Record<string, never>;
  };
}

/** The shape the preload exposes as `window[HOST_GLOBAL_KEY]`. */
export interface HolabossHost {
  readonly version: number;
  capabilities(): Promise<HostOp[]>;
  invoke<Op extends HostOp>(
    op: Op,
    payload: HostOpMap[Op]["input"],
  ): Promise<HostResult<HostOpMap[Op]["result"]>>;
}
