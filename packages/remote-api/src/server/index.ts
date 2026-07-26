export { remoteApiRouter } from "./router";
export type { RemoteApiRouter } from "./router";
export { mountRemoteApi } from "./fastify";
export type { MountRemoteApiOptions } from "./fastify";
export {
  NotificationsServiceError,
  CronjobsServiceError,
  CapabilitiesServiceError,
  ChannelsServiceError,
} from "./context";
export type {
  RemoteApiContext,
  RemoteApiIdentity,
  MemoryService,
  OutputsService,
  NotificationsService,
  CronjobsService,
  CapabilitiesService,
  ChannelsService,
  ChannelsServiceErrorCode,
} from "./context";
export {
  createConsoleRemoteApiLogger,
  noopRemoteApiLogger,
} from "../logging";
export type { RemoteApiLogger, RemoteApiLogFields } from "../logging";
export { remoteApiContract } from "../contract";
export type {
  RemoteApiContract,
  RemoteApiInputs,
  RemoteApiOutputs,
  WorkspaceRecord,
  OutputRecord,
  NotificationRecord,
  CronjobRecord,
  CapabilityCatalogEntry,
  WorkspaceCapability,
  ChannelConnection,
} from "../contract";
