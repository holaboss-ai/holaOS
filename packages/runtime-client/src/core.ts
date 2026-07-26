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
  makeIntegrationsMethods,
  type IntegrationsMethods,
} from "./methods/integrations";
import {
  makeMemoryMethods,
  type MemoryMethods,
} from "./methods/memory";
import {
  makeSessionsMethods,
  type SessionsMethods,
} from "./methods/sessions";
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
  integrations: IntegrationsMethods;
  memory: MemoryMethods;
  sessions: SessionsMethods;
  workspaces: WorkspacesMethods;
};

export function createRuntimeClient(
  options: CreateRuntimeClientOptions
): RuntimeClient {
  const request = createRequestFn(options);
  return {
    request,
    apps: makeAppsMethods(request),
    integrations: makeIntegrationsMethods(request),
    memory: makeMemoryMethods(request),
    sessions: makeSessionsMethods(request),
    workspaces: makeWorkspacesMethods(request),
  };
}
