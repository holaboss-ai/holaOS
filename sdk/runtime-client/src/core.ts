import {
  createRequestFn,
  isTransientRuntimeError,
  runtimeErrorFromBody,
  type CreateRuntimeRequestOptions,
  type RequestFn,
  type RuntimeRequest,
  type RuntimeRequestMethod,
  type RuntimeRequestParams,
} from "./request";
import {
  makeAppsMethods,
  type AppsMethods,
} from "./methods/apps";
import {
  makeCronjobsMethods,
  type CronjobsMethods,
} from "./methods/cronjobs";
import {
  makeIntegrationsMethods,
  type IntegrationsMethods,
} from "./methods/integrations";
import {
  makeMemoryMethods,
  type MemoryMethods,
} from "./methods/memory";
import {
  makeNotificationsMethods,
  type NotificationsMethods,
} from "./methods/notifications";
import {
  makeOutputsMethods,
  type OutputsMethods,
} from "./methods/outputs";
import {
  makeSessionsMethods,
  type SessionsMethods,
} from "./methods/sessions";
import {
  makeTaskProposalsMethods,
  type TaskProposalsMethods,
} from "./methods/task-proposals";
import {
  makeWorkspacesMethods,
  type WorkspacesMethods,
} from "./methods/workspaces";
export type {
  CreateWorkspaceBody,
  DeleteWorkspaceOptions,
  ListWorkspacesParams,
  UpdateWorkspaceBody,
  WorkspaceListResponse,
  WorkspaceRecord,
  WorkspaceResponse,
  WorkspacesMethods,
} from "./methods/workspaces";
export type { OnboardingAlignmentReport } from "../../../shared/onboarding-contract.js";

export type {
  RequestFn,
  RuntimeRequest,
  RuntimeRequestMethod,
  RuntimeRequestParams,
};
export { isTransientRuntimeError, runtimeErrorFromBody };

export type CreateRuntimeClientOptions = CreateRuntimeRequestOptions;

export type RuntimeClient = {
  /**
   * Generic typed request — escape hatch for endpoints not yet covered by
   * domain methods. Every method namespace below ultimately routes through
   * this same function, so call sites can fall back to it without losing
   * retry/timeout/error-parsing behavior.
   */
  request: RequestFn;
  apps: AppsMethods;
  cronjobs: CronjobsMethods;
  integrations: IntegrationsMethods;
  memory: MemoryMethods;
  notifications: NotificationsMethods;
  outputs: OutputsMethods;
  sessions: SessionsMethods;
  taskProposals: TaskProposalsMethods;
  workspaces: WorkspacesMethods;
};

export function createRuntimeClient(
  options: CreateRuntimeClientOptions
): RuntimeClient {
  const request = createRequestFn(options);
  return {
    request,
    apps: makeAppsMethods(request),
    cronjobs: makeCronjobsMethods(request),
    integrations: makeIntegrationsMethods(request),
    memory: makeMemoryMethods(request),
    notifications: makeNotificationsMethods(request),
    outputs: makeOutputsMethods(request),
    sessions: makeSessionsMethods(request),
    taskProposals: makeTaskProposalsMethods(request),
    workspaces: makeWorkspacesMethods(request),
  };
}
