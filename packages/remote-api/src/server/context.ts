import type { RemoteApiInputs, RemoteApiOutputs } from "../contract";
import type { RemoteApiLogger } from "../logging";

type MemoryInputs = RemoteApiInputs["memory"];
type MemoryOutputs = RemoteApiOutputs["memory"];
type OutputsInputs = RemoteApiInputs["outputs"];
type OutputsOutputs = RemoteApiOutputs["outputs"];
type NotificationsInputs = RemoteApiInputs["notifications"];
type NotificationsOutputs = RemoteApiOutputs["notifications"];
type CronjobsInputs = RemoteApiInputs["cronjobs"];
type CronjobsOutputs = RemoteApiOutputs["cronjobs"];
type CapabilitiesInputs = RemoteApiInputs["capabilities"];
type CapabilitiesOutputs = RemoteApiOutputs["capabilities"];
type ChannelsInputs = RemoteApiInputs["channels"];
type ChannelsOutputs = RemoteApiOutputs["channels"];
type SkillsInputs = RemoteApiInputs["skills"];
type SkillsOutputs = RemoteApiOutputs["skills"];

type MaybePromise<T> = T | Promise<T>;

/**
 * The runtime-supplied implementation of the memory agent surface. Handlers
 * delegate to this port; the runtime adapts its FilesystemMemoryService to it.
 */
export interface MemoryService {
  search(input: MemoryInputs["search"]): MaybePromise<MemoryOutputs["search"]>;
  get(input: MemoryInputs["get"]): MaybePromise<MemoryOutputs["get"]>;
  upsert(input: MemoryInputs["upsert"]): MaybePromise<MemoryOutputs["upsert"]>;
  status(input: MemoryInputs["status"]): MaybePromise<MemoryOutputs["status"]>;
  sync(input: MemoryInputs["sync"]): MaybePromise<MemoryOutputs["sync"]>;
  browseTree(
    input: MemoryInputs["browseTree"]
  ): MaybePromise<MemoryOutputs["browseTree"]>;
  readFile(
    input: MemoryInputs["readFile"]
  ): MaybePromise<MemoryOutputs["readFile"]>;
  readNodeDetail(
    input: MemoryInputs["readNodeDetail"]
  ): MaybePromise<MemoryOutputs["readNodeDetail"]>;
  browseGraph(
    input: MemoryInputs["browseGraph"]
  ): MaybePromise<MemoryOutputs["browseGraph"]>;
}

/** The runtime-supplied implementation of the outputs domain. */
export interface OutputsService {
  list(input: OutputsInputs["list"]): MaybePromise<OutputsOutputs["list"]>;
}

/** The runtime-supplied implementation of the notifications domain. */
export interface NotificationsService {
  list(
    input: NotificationsInputs["list"]
  ): MaybePromise<NotificationsOutputs["list"]>;
  /** Throws {@link NotificationsServiceError} NOT_FOUND when the id is unknown. */
  update(
    input: NotificationsInputs["update"]
  ): MaybePromise<NotificationsOutputs["update"]>;
}

/** The runtime-supplied implementation of the cronjobs domain. */
export interface CronjobsService {
  list(input: CronjobsInputs["list"]): MaybePromise<CronjobsOutputs["list"]>;
  /** Throws {@link CronjobsServiceError} NOT_FOUND when the id is unknown. */
  runNow(
    input: CronjobsInputs["runNow"]
  ): MaybePromise<CronjobsOutputs["runNow"]>;
  create(
    input: CronjobsInputs["create"]
  ): MaybePromise<CronjobsOutputs["create"]>;
  /** Throws {@link CronjobsServiceError} NOT_FOUND when the id is unknown. */
  update(
    input: CronjobsInputs["update"]
  ): MaybePromise<CronjobsOutputs["update"]>;
  /** Throws {@link CronjobsServiceError} NOT_FOUND when the id is unknown. */
  delete(
    input: CronjobsInputs["delete"]
  ): MaybePromise<CronjobsOutputs["delete"]>;
}

/** The runtime-supplied implementation of the capabilities domain. */
export interface CapabilitiesService {
  catalog(
    input: CapabilitiesInputs["catalog"]
  ): MaybePromise<CapabilitiesOutputs["catalog"]>;
  listInstalled(
    input: CapabilitiesInputs["listInstalled"]
  ): MaybePromise<CapabilitiesOutputs["listInstalled"]>;
  /** Throws {@link CapabilitiesServiceError} NOT_FOUND when the capability id is unknown. */
  install(
    input: CapabilitiesInputs["install"]
  ): MaybePromise<CapabilitiesOutputs["install"]>;
  /** Builds a capability from a manually-picked set of skills + integrations and installs it. */
  create(
    input: CapabilitiesInputs["create"]
  ): MaybePromise<CapabilitiesOutputs["create"]>;
  /** Imports a Claude/Codex plugin directory as a capability; throws on a bad path/manifest. */
  importPlugin(
    input: CapabilitiesInputs["importPlugin"]
  ): MaybePromise<CapabilitiesOutputs["importPlugin"]>;
  uninstall(
    input: CapabilitiesInputs["uninstall"]
  ): MaybePromise<CapabilitiesOutputs["uninstall"]>;
  /** Throws {@link CapabilitiesServiceError} NOT_FOUND when the capability id is unknown. */
  toggle(input: CapabilitiesInputs["toggle"]): MaybePromise<CapabilitiesOutputs["toggle"]>;
}

/** The runtime-supplied implementation of the curated skills catalog. */
export interface SkillsCatalogService {
  catalog(
    input: SkillsInputs["catalog"]
  ): MaybePromise<SkillsOutputs["catalog"]>;
  /** Materializes a catalog skill into the workspace; throws when the id is unknown. */
  install(
    input: SkillsInputs["install"]
  ): MaybePromise<SkillsOutputs["install"]>;
}

/** The runtime-supplied implementation of the channels (IM connections) domain. */
export interface ChannelsService {
  list(input: ChannelsInputs["list"]): MaybePromise<ChannelsOutputs["list"]>;
  validate(input: ChannelsInputs["validate"]): MaybePromise<ChannelsOutputs["validate"]>;
  startDeviceAuth(
    input: ChannelsInputs["startDeviceAuth"],
  ): MaybePromise<ChannelsOutputs["startDeviceAuth"]>;
  pollDeviceAuth(
    input: ChannelsInputs["pollDeviceAuth"],
  ): MaybePromise<ChannelsOutputs["pollDeviceAuth"]>;
  /** Throws {@link ChannelsServiceError} INVALID_TOKEN when the token fails validation. */
  create(input: ChannelsInputs["create"]): MaybePromise<ChannelsOutputs["create"]>;
  /** Throws {@link ChannelsServiceError} NOT_FOUND when the connection id is unknown. */
  delete(input: ChannelsInputs["delete"]): MaybePromise<ChannelsOutputs["delete"]>;
  /** Throws {@link ChannelsServiceError} NOT_FOUND when the connection id is unknown. */
  setHarness(
    input: ChannelsInputs["setHarness"],
  ): MaybePromise<ChannelsOutputs["setHarness"]>;
  /** Throws {@link ChannelsServiceError} NOT_FOUND when the connection id is unknown. */
  setModel(
    input: ChannelsInputs["setModel"],
  ): MaybePromise<ChannelsOutputs["setModel"]>;
  /**
   * The agent sessions (conversations) a channel has spun up — one per
   * chat/thread — newest-active first. Read-only; powers the channel's
   * "replicate view". Throws {@link ChannelsServiceError} NOT_FOUND when the
   * connection id is unknown.
   */
  listSessions(
    input: ChannelsInputs["listSessions"],
  ): MaybePromise<ChannelsOutputs["listSessions"]>;
}

/**
 * Authenticated caller identity for a request. Present once the Remote boundary
 * verifies an OAuth-scoped workspace token (roadmap B1); absent on the
 * in-process path (the runtime supplies no token). The authz middleware no-ops
 * when it is absent, so threading this changes no call sites. v1 carries no
 * token verification/RLS — only the shape and the assertion seam.
 */
export interface RemoteApiIdentity {
  /** Workspace this token authorizes. v1 is 1:1 user↔workspace (decision #29). */
  workspaceId: string;
  /** Stable principal id (user / agent / HolaApp). */
  subject: string;
  /** Granted scope strings (decision #15 vocabulary). */
  scopes: string[];
}

export interface RemoteApiContext {
  memory: MemoryService;
  outputs: OutputsService;
  notifications: NotificationsService;
  cronjobs: CronjobsService;
  capabilities: CapabilitiesService;
  skills: SkillsCatalogService;
  channels: ChannelsService;
  /** Authenticated caller identity; absent on the in-process path (no-op authz). */
  identity?: RemoteApiIdentity;
  /** Correlation id for this request; echoed in every log line on both sides. */
  requestId?: string;
  /** Per-request logger (the runtime injects a pino child). */
  logger?: RemoteApiLogger;
}

export class NotificationsServiceError extends Error {
  readonly code: "NOT_FOUND";

  constructor(code: "NOT_FOUND", options?: { message?: string }) {
    super(options?.message ?? code);
    this.name = "NotificationsServiceError";
    this.code = code;
  }
}

export class CronjobsServiceError extends Error {
  readonly code: "NOT_FOUND";

  constructor(code: "NOT_FOUND", options?: { message?: string }) {
    super(options?.message ?? code);
    this.name = "CronjobsServiceError";
    this.code = code;
  }
}

export class CapabilitiesServiceError extends Error {
  readonly code: "NOT_FOUND";

  constructor(code: "NOT_FOUND", options?: { message?: string }) {
    super(options?.message ?? code);
    this.name = "CapabilitiesServiceError";
    this.code = code;
  }
}

export type ChannelsServiceErrorCode = "NOT_FOUND" | "INVALID_TOKEN";

export class ChannelsServiceError extends Error {
  readonly code: ChannelsServiceErrorCode;

  constructor(code: ChannelsServiceErrorCode, options?: { message?: string }) {
    super(options?.message ?? code);
    this.name = "ChannelsServiceError";
    this.code = code;
  }
}
