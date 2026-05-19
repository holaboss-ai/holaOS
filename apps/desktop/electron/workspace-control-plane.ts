export type WorkspaceLocation = "local" | "cloud"

export interface OpenWorkspaceSession<WorkspaceLifecycleResponse> {
  workspaceId: string
  location: WorkspaceLocation
  runtimeBaseUrl: string
  runtimeAuthToken: string | null
  workspaceRoot: string
  lifecycle: WorkspaceLifecycleResponse
}

export interface WorkspaceControlPlane<
  WorkspaceListResponse,
  WorkspaceResponse,
  WorkspaceLifecycleResponse,
  CreateWorkspacePayload,
  WorkspaceOpenSessionResponse extends {
    lifecycle: WorkspaceLifecycleResponse
  },
> {
  listWorkspaces(): Promise<WorkspaceListResponse>
  listWorkspacesCached(): Promise<WorkspaceListResponse>
  createWorkspace(payload: CreateWorkspacePayload): Promise<WorkspaceResponse>
  deleteWorkspace(
    workspaceId: string,
    keepFiles?: boolean,
  ): Promise<WorkspaceResponse>
  activateWorkspaceRecord(workspaceId: string): Promise<WorkspaceResponse>
  getWorkspaceLifecycle(
    workspaceId: string,
  ): Promise<WorkspaceLifecycleResponse>
  activateWorkspace(workspaceId: string): Promise<WorkspaceLifecycleResponse>
  openWorkspace(workspaceId: string): Promise<WorkspaceOpenSessionResponse>
}

export interface WorkspaceRegistry<WorkspaceListResponse> {
  listCachedWorkspaces:
    | (() => WorkspaceListResponse)
    | (() => Promise<WorkspaceListResponse>)
}

export interface LocalWorkspaceControlPlaneDependencies<
  WorkspaceListResponse,
  WorkspaceResponse,
  WorkspaceLifecycleResponse,
  CreateWorkspacePayload,
  WorkspaceOpenSessionResponse extends {
    lifecycle: WorkspaceLifecycleResponse
  },
> {
  listWorkspaces: () => Promise<WorkspaceListResponse>
  workspaceRegistry: WorkspaceRegistry<WorkspaceListResponse>
  createWorkspace: (
    payload: CreateWorkspacePayload,
  ) => Promise<WorkspaceResponse>
  deleteWorkspace: (
    workspaceId: string,
    keepFiles?: boolean,
  ) => Promise<WorkspaceResponse>
  activateWorkspaceRecord: (workspaceId: string) => Promise<WorkspaceResponse>
  getWorkspaceLifecycle: (
    workspaceId: string,
  ) => Promise<WorkspaceLifecycleResponse>
  openWorkspace: (workspaceId: string) => Promise<WorkspaceOpenSessionResponse>
}

export class LocalWorkspaceControlPlane<
  WorkspaceListResponse,
  WorkspaceResponse,
  WorkspaceLifecycleResponse,
  CreateWorkspacePayload,
  WorkspaceOpenSessionResponse extends {
    lifecycle: WorkspaceLifecycleResponse
  },
> implements
    WorkspaceControlPlane<
      WorkspaceListResponse,
      WorkspaceResponse,
      WorkspaceLifecycleResponse,
      CreateWorkspacePayload,
      WorkspaceOpenSessionResponse
    >
{
  readonly #deps: LocalWorkspaceControlPlaneDependencies<
    WorkspaceListResponse,
    WorkspaceResponse,
    WorkspaceLifecycleResponse,
    CreateWorkspacePayload,
    WorkspaceOpenSessionResponse
  >

  constructor(
    deps: LocalWorkspaceControlPlaneDependencies<
      WorkspaceListResponse,
      WorkspaceResponse,
      WorkspaceLifecycleResponse,
      CreateWorkspacePayload,
      WorkspaceOpenSessionResponse
    >,
  ) {
    this.#deps = deps
  }

  async listWorkspaces(): Promise<WorkspaceListResponse> {
    return this.#deps.listWorkspaces()
  }

  async listWorkspacesCached(): Promise<WorkspaceListResponse> {
    return Promise.resolve(this.#deps.workspaceRegistry.listCachedWorkspaces())
  }

  async createWorkspace(
    payload: CreateWorkspacePayload,
  ): Promise<WorkspaceResponse> {
    return this.#deps.createWorkspace(payload)
  }

  async deleteWorkspace(
    workspaceId: string,
    keepFiles?: boolean,
  ): Promise<WorkspaceResponse> {
    return this.#deps.deleteWorkspace(workspaceId, keepFiles)
  }

  async activateWorkspaceRecord(
    workspaceId: string,
  ): Promise<WorkspaceResponse> {
    return this.#deps.activateWorkspaceRecord(workspaceId)
  }

  async getWorkspaceLifecycle(
    workspaceId: string,
  ): Promise<WorkspaceLifecycleResponse> {
    return this.#deps.getWorkspaceLifecycle(workspaceId)
  }

  async activateWorkspace(
    workspaceId: string,
  ): Promise<WorkspaceLifecycleResponse> {
    return (await this.openWorkspace(workspaceId)).lifecycle
  }

  async openWorkspace(workspaceId: string): Promise<WorkspaceOpenSessionResponse> {
    return this.#deps.openWorkspace(workspaceId)
  }
}

export function createLocalWorkspaceControlPlane<
  WorkspaceListResponse,
  WorkspaceResponse,
  WorkspaceLifecycleResponse,
  CreateWorkspacePayload,
  WorkspaceOpenSessionResponse extends {
    lifecycle: WorkspaceLifecycleResponse
  },
>(
  deps: LocalWorkspaceControlPlaneDependencies<
    WorkspaceListResponse,
    WorkspaceResponse,
    WorkspaceLifecycleResponse,
    CreateWorkspacePayload,
    WorkspaceOpenSessionResponse
  >,
): LocalWorkspaceControlPlane<
  WorkspaceListResponse,
  WorkspaceResponse,
  WorkspaceLifecycleResponse,
  CreateWorkspacePayload,
  WorkspaceOpenSessionResponse
> {
  return new LocalWorkspaceControlPlane(deps)
}
