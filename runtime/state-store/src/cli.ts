import { RuntimeStateStore, type RuntimeStateStoreOptions } from "./store.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type RequestEnvelope = {
  options?: RuntimeStateStoreOptions;
  [key: string]: JsonValue | RuntimeStateStoreOptions | undefined;
};

function toBindingRecord(record: ReturnType<RuntimeStateStore["getBinding"]> extends infer T ? Exclude<T, null> : never) {
  return {
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    harness: record.harness,
    harness_session_id: record.harnessSessionId,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function toWorkspaceRecord(record: ReturnType<RuntimeStateStore["getWorkspace"]> extends infer T ? Exclude<T, null> : never) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    harness: record.harness,
    error_message: record.errorMessage,
    onboarding_status: record.onboardingStatus,
    onboarding_session_id: record.onboardingSessionId,
    onboarding_completed_at: record.onboardingCompletedAt,
    onboarding_completion_summary: record.onboardingCompletionSummary,
    onboarding_requested_at: record.onboardingRequestedAt,
    onboarding_requested_by: record.onboardingRequestedBy,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    deleted_at_utc: record.deletedAtUtc
  };
}

function outputTypeForArtifactType(artifactType: string) {
  switch (artifactType) {
    case "draft":
      return "post";
    case "image":
      return "file";
    case "html":
      return "html";
    case "document":
    default:
      return "document";
  }
}

function artifactTypeFromOutputRecord(record: ReturnType<RuntimeStateStore["listOutputs"]>[number]) {
  const metadataArtifactType =
    typeof record.metadata.artifact_type === "string" ? record.metadata.artifact_type.trim() : "";
  if (metadataArtifactType) {
    return metadataArtifactType;
  }
  if (record.outputType === "post") {
    return "draft";
  }
  if (record.outputType === "html") {
    return "html";
  }
  const category = typeof record.metadata.category === "string" ? record.metadata.category.trim() : "";
  if (category === "image") {
    return "image";
  }
  return "document";
}

function externalIdFromOutputRecord(record: ReturnType<RuntimeStateStore["listOutputs"]>[number]) {
  const metadataExternalId =
    typeof record.metadata.external_id === "string" ? record.metadata.external_id.trim() : "";
  if (metadataExternalId) {
    return metadataExternalId;
  }
  return record.moduleResourceId ?? record.filePath ?? record.artifactId ?? record.id;
}

function toSessionArtifactRecord(record: ReturnType<RuntimeStateStore["listOutputs"]>[number]) {
  return {
    id: record.artifactId ?? record.id,
    session_id: record.sessionId,
    workspace_id: record.workspaceId,
    input_id: record.inputId,
    artifact_type: artifactTypeFromOutputRecord(record),
    external_id: externalIdFromOutputRecord(record),
    platform: record.platform,
    title: record.title || null,
    metadata: record.metadata as JsonObject,
    created_at: record.createdAt
  };
}

function toOutputFolderRecord(record: ReturnType<RuntimeStateStore["listOutputFolders"]>[number]) {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    name: record.name,
    position: record.position,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function toOutputRecord(record: ReturnType<RuntimeStateStore["listOutputs"]>[number]) {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    output_type: record.outputType,
    title: record.title,
    status: record.status,
    module_id: record.moduleId,
    module_resource_id: record.moduleResourceId,
    file_path: record.filePath,
    html_content: record.htmlContent,
    session_id: record.sessionId,
    input_id: record.inputId,
    artifact_id: record.artifactId,
    folder_id: record.folderId,
    platform: record.platform,
    metadata: record.metadata as JsonObject,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function toCronjobRecord(record: ReturnType<RuntimeStateStore["listCronjobs"]>[number]) {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    initiated_by: record.initiatedBy,
    name: record.name,
    cron: record.cron,
    description: record.description,
    instruction: record.instruction,
    enabled: record.enabled,
    delivery: record.delivery as JsonObject,
    metadata: record.metadata as JsonObject,
    last_run_at: record.lastRunAt,
    next_run_at: record.nextRunAt,
    run_count: record.runCount,
    last_status: record.lastStatus,
    last_error: record.lastError,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function toAppBuildRecord(record: ReturnType<RuntimeStateStore["getAppBuild"]> extends infer T ? Exclude<T, null> : never) {
  return {
    workspace_id: record.workspaceId,
    app_id: record.appId,
    status: record.status,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    error: record.error,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function toTaskProposalRecord(record: ReturnType<RuntimeStateStore["listTaskProposals"]>[number]) {
  return {
    proposal_id: record.proposalId,
    workspace_id: record.workspaceId,
    task_name: record.taskName,
    task_prompt: record.taskPrompt,
    task_generation_rationale: record.taskGenerationRationale,
    proposal_source: record.proposalSource,
    source_event_ids: record.sourceEventIds,
    created_at: record.createdAt,
    state: record.state,
    accepted_session_id: record.acceptedSessionId,
    accepted_input_id: record.acceptedInputId,
    accepted_at: record.acceptedAt
  };
}

function toInputRecord(record: ReturnType<RuntimeStateStore["getInput"]> extends infer T ? Exclude<T, null> : never) {
  return {
    input_id: record.inputId,
    session_id: record.sessionId,
    workspace_id: record.workspaceId,
    payload: record.payload as JsonObject,
    status: record.status,
    priority: record.priority,
    available_at: record.availableAt,
    attempt: record.attempt,
    idempotency_key: record.idempotencyKey,
    claimed_by: record.claimedBy,
    claimed_until: record.claimedUntil,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function toRuntimeStateRecord(record: ReturnType<RuntimeStateStore["getRuntimeState"]> extends infer T ? Exclude<T, null> : never) {
  return {
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    status: record.status,
    current_input_id: record.currentInputId,
    current_worker_id: record.currentWorkerId,
    lease_until: record.leaseUntil,
    heartbeat_at: record.heartbeatAt,
    last_error: (record.lastError as JsonObject | null) ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function toSessionMessageRecord(record: ReturnType<RuntimeStateStore["listSessionMessages"]>[number]) {
  return {
    id: record.id,
    role: record.role,
    text: record.text,
    created_at: record.createdAt,
    metadata: record.metadata as JsonObject
  };
}

function toOutputEventRecord(record: ReturnType<RuntimeStateStore["listOutputEvents"]>[number]) {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    input_id: record.inputId,
    sequence: record.sequence,
    event_type: record.eventType,
    payload: record.payload as JsonObject,
    created_at: record.createdAt
  };
}

export function handleRequest(operation: string, envelope: RequestEnvelope): JsonValue {
  const store = new RuntimeStateStore(envelope.options ?? {});
  try {
    switch (operation) {
      case "workspace-dir":
        return store.workspaceDir(String(envelope.workspace_id));
      case "create-workspace":
        return toWorkspaceRecord(
          store.createWorkspace({
            workspaceId: typeof envelope.workspace_id === "string" ? envelope.workspace_id : undefined,
            name: String(envelope.name),
            harness: String(envelope.harness),
            status: typeof envelope.status === "string" ? envelope.status : undefined,
            onboardingStatus: typeof envelope.onboarding_status === "string" ? envelope.onboarding_status : undefined,
            onboardingSessionId:
              typeof envelope.onboarding_session_id === "string" ? envelope.onboarding_session_id : null,
            errorMessage: typeof envelope.error_message === "string" ? envelope.error_message : null
          })
        );
      case "list-workspaces":
        return store
          .listWorkspaces({
            includeDeleted: typeof envelope.include_deleted === "boolean" ? envelope.include_deleted : false
          })
          .map((record) => toWorkspaceRecord(record));
      case "get-workspace": {
        const record = store.getWorkspace(String(envelope.workspace_id), {
          includeDeleted: typeof envelope.include_deleted === "boolean" ? envelope.include_deleted : false
        });
        return record ? toWorkspaceRecord(record) : null;
      }
      case "update-workspace": {
        const fields = (envelope.fields as JsonObject | undefined) ?? {};
        return toWorkspaceRecord(
          store.updateWorkspace(String(envelope.workspace_id), {
            status: typeof fields.status === "string" ? fields.status : fields.status === null ? null : undefined,
            errorMessage:
              typeof fields.error_message === "string"
                ? fields.error_message
                : fields.error_message === null
                ? null
                : undefined,
            deletedAtUtc:
              typeof fields.deleted_at_utc === "string"
                ? fields.deleted_at_utc
                : fields.deleted_at_utc === null
                ? null
                : undefined,
            onboardingStatus:
              typeof fields.onboarding_status === "string"
                ? fields.onboarding_status
                : fields.onboarding_status === null
                ? null
                : undefined,
            onboardingSessionId:
              typeof fields.onboarding_session_id === "string"
                ? fields.onboarding_session_id
                : fields.onboarding_session_id === null
                ? null
                : undefined,
            onboardingCompletedAt:
              typeof fields.onboarding_completed_at === "string"
                ? fields.onboarding_completed_at
                : fields.onboarding_completed_at === null
                ? null
                : undefined,
            onboardingCompletionSummary:
              typeof fields.onboarding_completion_summary === "string"
                ? fields.onboarding_completion_summary
                : fields.onboarding_completion_summary === null
                ? null
                : undefined,
            onboardingRequestedAt:
              typeof fields.onboarding_requested_at === "string"
                ? fields.onboarding_requested_at
                : fields.onboarding_requested_at === null
                ? null
                : undefined,
            onboardingRequestedBy:
              typeof fields.onboarding_requested_by === "string"
                ? fields.onboarding_requested_by
                : fields.onboarding_requested_by === null
                ? null
                : undefined
          })
        );
      }
      case "delete-workspace":
        return toWorkspaceRecord(store.deleteWorkspace(String(envelope.workspace_id)));
      case "upsert-binding":
        return toBindingRecord(
          store.upsertBinding({
            workspaceId: String(envelope.workspace_id),
            sessionId: String(envelope.session_id),
            harness: String(envelope.harness),
            harnessSessionId: String(envelope.harness_session_id)
          })
        );
      case "get-binding": {
        const record = store.getBinding({
          workspaceId: String(envelope.workspace_id),
          sessionId: String(envelope.session_id)
        });
        return record ? toBindingRecord(record) : null;
      }
      case "enqueue-input":
        return toInputRecord(
          store.enqueueInput({
            workspaceId: String(envelope.workspace_id),
            sessionId: String(envelope.session_id),
            payload: (envelope.payload as JsonObject | undefined) ?? {},
            priority: typeof envelope.priority === "number" ? envelope.priority : 0,
            idempotencyKey: typeof envelope.idempotency_key === "string" ? envelope.idempotency_key : null
          })
        );
      case "get-input": {
        const record = store.getInput({
          workspaceId: String(envelope.workspace_id),
          inputId: String(envelope.input_id),
        });
        return record ? toInputRecord(record) : null;
      }
      case "get-input-by-idempotency-key": {
        const record = store.getInputByIdempotencyKey({
          workspaceId: String(envelope.workspace_id),
          idempotencyKey: String(envelope.idempotency_key),
        });
        return record ? toInputRecord(record) : null;
      }
      case "update-input": {
        const fields = (envelope.fields as JsonObject | undefined) ?? {};
        const record = store.updateInput({
          workspaceId: String(envelope.workspace_id),
          inputId: String(envelope.input_id),
          fields: {
            sessionId: typeof fields.session_id === "string" ? fields.session_id : undefined,
            workspaceId: typeof fields.workspace_id === "string" ? fields.workspace_id : undefined,
            payload: (fields.payload as JsonObject | undefined) ?? undefined,
            status: typeof fields.status === "string" ? fields.status : undefined,
            priority: typeof fields.priority === "number" ? fields.priority : undefined,
            availableAt: typeof fields.available_at === "string" ? fields.available_at : undefined,
            attempt: typeof fields.attempt === "number" ? fields.attempt : undefined,
            idempotencyKey:
              typeof fields.idempotency_key === "string" ? fields.idempotency_key : fields.idempotency_key === null ? null : undefined,
            claimedBy: typeof fields.claimed_by === "string" ? fields.claimed_by : fields.claimed_by === null ? null : undefined,
            claimedUntil:
              typeof fields.claimed_until === "string" ? fields.claimed_until : fields.claimed_until === null ? null : undefined,
          },
        });
        return record ? toInputRecord(record) : null;
      }
      case "claim-inputs":
        return store
          .claimInputs({
            limit: typeof envelope.limit === "number" ? envelope.limit : 1,
            claimedBy: String(envelope.claimed_by),
            leaseSeconds: typeof envelope.lease_seconds === "number" ? envelope.lease_seconds : 0,
            distinctSessions: envelope.distinct_sessions === true
          })
          .map((record) => toInputRecord(record));
      case "has-available-inputs-for-session":
        return store.hasAvailableInputsForSession({
          sessionId: String(envelope.session_id),
          workspaceId: String(envelope.workspace_id),
        });
      case "ensure-runtime-state":
        return toRuntimeStateRecord(
          store.ensureRuntimeState({
            workspaceId: String(envelope.workspace_id),
            sessionId: String(envelope.session_id),
            status: typeof envelope.status === "string" ? envelope.status : undefined,
            currentInputId: typeof envelope.current_input_id === "string" ? envelope.current_input_id : null
          })
        );
      case "update-runtime-state":
        return toRuntimeStateRecord(
          store.updateRuntimeState({
            workspaceId: String(envelope.workspace_id),
            sessionId: String(envelope.session_id),
            status: String(envelope.status),
            currentInputId: typeof envelope.current_input_id === "string" ? envelope.current_input_id : null,
            currentWorkerId: typeof envelope.current_worker_id === "string" ? envelope.current_worker_id : null,
            leaseUntil: typeof envelope.lease_until === "string" ? envelope.lease_until : null,
            heartbeatAt: typeof envelope.heartbeat_at === "string" ? envelope.heartbeat_at : undefined,
            lastError:
              typeof envelope.last_error === "string" || envelope.last_error == null
                ? envelope.last_error
                : (envelope.last_error as JsonObject)
          })
        );
      case "list-runtime-states":
        return store.listRuntimeStates(String(envelope.workspace_id)).map((record) => toRuntimeStateRecord(record));
      case "get-runtime-state": {
        if (typeof envelope.workspace_id !== "string" || !envelope.workspace_id.trim()) {
          throw new Error("workspace_id is required");
        }
        const record = store.getRuntimeState({
          sessionId: String(envelope.session_id),
          workspaceId: envelope.workspace_id
        });
        return record ? toRuntimeStateRecord(record) : null;
      }
      case "insert-session-message":
        store.insertSessionMessage({
          workspaceId: String(envelope.workspace_id),
          sessionId: String(envelope.session_id),
          role: String(envelope.role),
          text: String(envelope.text),
          messageId: typeof envelope.message_id === "string" ? envelope.message_id : undefined,
          createdAt: typeof envelope.created_at === "string" ? envelope.created_at : undefined
        });
        return { ok: true };
      case "list-session-messages":
        return store
          .listSessionMessages({
            workspaceId: String(envelope.workspace_id),
            sessionId: String(envelope.session_id)
          })
          .map((record) => toSessionMessageRecord(record));
      case "append-output-event":
        store.appendOutputEvent({
          workspaceId: String(envelope.workspace_id),
          sessionId: String(envelope.session_id),
          inputId: String(envelope.input_id),
          sequence: Number(envelope.sequence),
          eventType: String(envelope.event_type),
          payload: (envelope.payload as JsonObject | undefined) ?? {},
          createdAt: typeof envelope.created_at === "string" ? envelope.created_at : undefined
        });
        return { ok: true };
      case "latest-output-event-id":
        return store.latestOutputEventId({
          workspaceId: String(envelope.workspace_id),
          sessionId: String(envelope.session_id),
          inputId: typeof envelope.input_id === "string" ? envelope.input_id : undefined
        });
      case "list-output-events":
        return store
          .listOutputEvents({
            workspaceId: String(envelope.workspace_id),
            sessionId: String(envelope.session_id),
            inputId: typeof envelope.input_id === "string" ? envelope.input_id : undefined,
            includeHistory: typeof envelope.include_history === "boolean" ? envelope.include_history : true,
            afterEventId: typeof envelope.after_event_id === "number" ? envelope.after_event_id : 0
          })
          .map((record) => toOutputEventRecord(record));
      case "create-session-artifact":
        return toSessionArtifactRecord(
          store.createOutput({
            workspaceId: String(envelope.workspace_id),
            outputType: outputTypeForArtifactType(String(envelope.artifact_type)),
            title: typeof envelope.title === "string" ? envelope.title : "",
            status: "completed",
            moduleId: typeof envelope.module_id === "string" ? envelope.module_id : null,
            moduleResourceId:
              typeof envelope.module_resource_id === "string"
                ? envelope.module_resource_id
                : String(envelope.external_id),
            sessionId: String(envelope.session_id),
            inputId: typeof envelope.input_id === "string" ? envelope.input_id : null,
            artifactId: typeof envelope.artifact_id === "string" ? envelope.artifact_id : undefined,
            platform: typeof envelope.platform === "string" ? envelope.platform : null,
            metadata: {
              ...((envelope.metadata as JsonObject | undefined) ?? {}),
              origin_type: "app",
              change_type: typeof envelope.change_type === "string" ? envelope.change_type : "created",
              artifact_type: String(envelope.artifact_type),
              external_id: String(envelope.external_id),
            },
          })
        );
      case "list-session-artifacts":
        return store
          .listOutputs({
            workspaceId: String(envelope.workspace_id),
            sessionId: String(envelope.session_id),
            limit: typeof envelope.limit === "number" ? envelope.limit : 500,
            offset: typeof envelope.offset === "number" ? envelope.offset : 0
          })
          .map((record) => toSessionArtifactRecord(record));
      case "list-sessions-with-artifacts": {
        const workspaceId = String(envelope.workspace_id);
        const limit = typeof envelope.limit === "number" ? envelope.limit : 20;
        const offset = typeof envelope.offset === "number" ? envelope.offset : 0;
        const outputs = store.listOutputs({
          workspaceId,
          limit: 1000,
          offset: 0,
        }).sort((left, right) => {
          const leftTime = Date.parse(left.createdAt ?? "") || 0;
          const rightTime = Date.parse(right.createdAt ?? "") || 0;
          if (leftTime !== rightTime) {
            return leftTime - rightTime;
          }
          return left.id.localeCompare(right.id);
        });
        const artifactsBySession = new Map<string, ReturnType<typeof toSessionArtifactRecord>[]>();
        for (const output of outputs) {
          const sessionId = output.sessionId ?? "";
          if (!sessionId) {
            continue;
          }
          const existing = artifactsBySession.get(sessionId);
          if (existing) {
            existing.push(toSessionArtifactRecord(output));
          } else {
            artifactsBySession.set(sessionId, [toSessionArtifactRecord(output)]);
          }
        }
        return store
          .listRuntimeStates(workspaceId)
          .slice(offset, offset + limit)
          .map((record) => ({
            session_id: record.sessionId,
            status: record.status,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
            artifacts: artifactsBySession.get(record.sessionId) ?? []
          })) as JsonValue;
      }
      case "create-output-folder":
        return toOutputFolderRecord(
          store.createOutputFolder({
            workspaceId: String(envelope.workspace_id),
            name: String(envelope.name)
          })
        );
      case "list-output-folders":
        return store
          .listOutputFolders({ workspaceId: String(envelope.workspace_id) })
          .map((record) => toOutputFolderRecord(record));
      case "update-output-folder": {
        const record = store.updateOutputFolder({
          workspaceId: String(envelope.workspace_id),
          folderId: String(envelope.folder_id),
          name: typeof envelope.name === "string" ? envelope.name : null,
          position: typeof envelope.position === "number" ? envelope.position : null
        });
        return record ? toOutputFolderRecord(record) : null;
      }
      case "get-output-folder": {
        const record = store.getOutputFolder({
          workspaceId: String(envelope.workspace_id),
          folderId: String(envelope.folder_id),
        });
        return record ? toOutputFolderRecord(record) : null;
      }
      case "delete-output-folder":
        return store.deleteOutputFolder({
          workspaceId: String(envelope.workspace_id),
          folderId: String(envelope.folder_id),
        });
      case "create-output":
        return toOutputRecord(
          store.createOutput({
            workspaceId: String(envelope.workspace_id),
            outputType: String(envelope.output_type),
            title: typeof envelope.title === "string" ? envelope.title : "",
            status: typeof envelope.status === "string" ? envelope.status : undefined,
            moduleId: typeof envelope.module_id === "string" ? envelope.module_id : null,
            moduleResourceId: typeof envelope.module_resource_id === "string" ? envelope.module_resource_id : null,
            filePath: typeof envelope.file_path === "string" ? envelope.file_path : null,
            htmlContent: typeof envelope.html_content === "string" ? envelope.html_content : null,
            sessionId: typeof envelope.session_id === "string" ? envelope.session_id : null,
            inputId: typeof envelope.input_id === "string" ? envelope.input_id : null,
            artifactId: typeof envelope.artifact_id === "string" ? envelope.artifact_id : null,
            folderId: typeof envelope.folder_id === "string" ? envelope.folder_id : null,
            platform: typeof envelope.platform === "string" ? envelope.platform : null,
            metadata: (envelope.metadata as JsonObject | undefined) ?? {},
            outputId: typeof envelope.output_id === "string" ? envelope.output_id : undefined
          })
        );
      case "list-outputs":
        return store
          .listOutputs({
            workspaceId: String(envelope.workspace_id),
            outputType: typeof envelope.output_type === "string" ? envelope.output_type : null,
            status: typeof envelope.status === "string" ? envelope.status : null,
            platform: typeof envelope.platform === "string" ? envelope.platform : null,
            folderId: typeof envelope.folder_id === "string" ? envelope.folder_id : null,
            sessionId: typeof envelope.session_id === "string" ? envelope.session_id : null,
            inputId: typeof envelope.input_id === "string" ? envelope.input_id : null,
            limit: typeof envelope.limit === "number" ? envelope.limit : 50,
            offset: typeof envelope.offset === "number" ? envelope.offset : 0
          })
          .map((record) => toOutputRecord(record));
      case "get-output": {
        const record = store.getOutput({
          workspaceId: String(envelope.workspace_id),
          outputId: String(envelope.output_id),
        });
        return record ? toOutputRecord(record) : null;
      }
      case "update-output": {
        const record = store.updateOutput({
          workspaceId: String(envelope.workspace_id),
          outputId: String(envelope.output_id),
          title: typeof envelope.title === "string" ? envelope.title : null,
          status: typeof envelope.status === "string" ? envelope.status : null,
          moduleResourceId: typeof envelope.module_resource_id === "string" ? envelope.module_resource_id : null,
          filePath: typeof envelope.file_path === "string" ? envelope.file_path : null,
          htmlContent: typeof envelope.html_content === "string" ? envelope.html_content : null,
          metadata: (envelope.metadata as JsonObject | undefined) ?? null,
          folderId: typeof envelope.folder_id === "string" ? envelope.folder_id : null
        });
        return record ? toOutputRecord(record) : null;
      }
      case "delete-output":
        return store.deleteOutput({
          workspaceId: String(envelope.workspace_id),
          outputId: String(envelope.output_id),
        });
      case "get-output-counts":
        return store.getOutputCounts({ workspaceId: String(envelope.workspace_id) }) as JsonValue;
      case "create-cronjob":
        return toCronjobRecord(
          store.createCronjob({
            workspaceId: String(envelope.workspace_id),
            initiatedBy: String(envelope.initiated_by),
            cron: String(envelope.cron),
            description: String(envelope.description),
            instruction: typeof envelope.instruction === "string" ? envelope.instruction : undefined,
            delivery: (envelope.delivery as JsonObject | undefined) ?? {},
            enabled: typeof envelope.enabled === "boolean" ? envelope.enabled : true,
            metadata: (envelope.metadata as JsonObject | undefined) ?? {},
            name: typeof envelope.name === "string" ? envelope.name : "",
            jobId: typeof envelope.job_id === "string" ? envelope.job_id : undefined,
            nextRunAt: typeof envelope.next_run_at === "string" ? envelope.next_run_at : null
          })
        );
      case "get-cronjob": {
        const record = store.getCronjob({
          workspaceId: String(envelope.workspace_id),
          jobId: String(envelope.job_id),
        });
        return record ? toCronjobRecord(record) : null;
      }
      case "list-cronjobs":
        return store
          .listCronjobs({
            workspaceId: typeof envelope.workspace_id === "string" ? envelope.workspace_id : null,
            enabledOnly: typeof envelope.enabled_only === "boolean" ? envelope.enabled_only : false
          })
          .map((record) => toCronjobRecord(record));
      case "update-cronjob": {
        const record = store.updateCronjob({
          workspaceId: String(envelope.workspace_id),
          jobId: String(envelope.job_id),
          name: typeof envelope.name === "string" ? envelope.name : null,
          cron: typeof envelope.cron === "string" ? envelope.cron : null,
          description: typeof envelope.description === "string" ? envelope.description : null,
          instruction: typeof envelope.instruction === "string" ? envelope.instruction : null,
          enabled: typeof envelope.enabled === "boolean" ? envelope.enabled : null,
          delivery: (envelope.delivery as JsonObject | undefined) ?? null,
          metadata: (envelope.metadata as JsonObject | undefined) ?? null,
          lastRunAt: typeof envelope.last_run_at === "string" ? envelope.last_run_at : envelope.last_run_at === null ? null : undefined,
          nextRunAt: typeof envelope.next_run_at === "string" ? envelope.next_run_at : envelope.next_run_at === null ? null : undefined,
          runCount: typeof envelope.run_count === "number" ? envelope.run_count : null,
          lastStatus: typeof envelope.last_status === "string" ? envelope.last_status : envelope.last_status === null ? null : undefined,
          lastError: typeof envelope.last_error === "string" ? envelope.last_error : envelope.last_error === null ? null : undefined
        });
        return record ? toCronjobRecord(record) : null;
      }
      case "delete-cronjob":
        return store.deleteCronjob({
          workspaceId: String(envelope.workspace_id),
          jobId: String(envelope.job_id),
        });
      case "upsert-app-build":
        return toAppBuildRecord(
          store.upsertAppBuild({
            workspaceId: String(envelope.workspace_id),
            appId: String(envelope.app_id),
            status: String(envelope.status),
            error: typeof envelope.error === "string" ? envelope.error : null
          })
        );
      case "get-app-build": {
        const record = store.getAppBuild({
          workspaceId: String(envelope.workspace_id),
          appId: String(envelope.app_id)
        });
        return record ? toAppBuildRecord(record) : null;
      }
      case "delete-app-build":
        return store.deleteAppBuild({
          workspaceId: String(envelope.workspace_id),
          appId: String(envelope.app_id)
        });
      case "create-task-proposal":
        return toTaskProposalRecord(
          store.createTaskProposal({
            proposalId: String(envelope.proposal_id),
            workspaceId: String(envelope.workspace_id),
            taskName: String(envelope.task_name),
            taskPrompt: String(envelope.task_prompt),
            taskGenerationRationale: String(envelope.task_generation_rationale),
            proposalSource: typeof envelope.proposal_source === "string" ? envelope.proposal_source : undefined,
            sourceEventIds: Array.isArray(envelope.source_event_ids)
              ? envelope.source_event_ids.filter((item): item is string => typeof item === "string")
              : [],
            createdAt: String(envelope.created_at),
            state: typeof envelope.state === "string" ? envelope.state : undefined
          })
        );
      case "get-task-proposal": {
        const record = store.getTaskProposal({
          workspaceId: String(envelope.workspace_id),
          proposalId: String(envelope.proposal_id),
        });
        return record ? toTaskProposalRecord(record) : null;
      }
      case "list-task-proposals":
        return store
          .listTaskProposals({ workspaceId: String(envelope.workspace_id) })
          .map((record) => toTaskProposalRecord(record));
      case "list-unreviewed-task-proposals":
        return store
          .listUnreviewedTaskProposals({ workspaceId: String(envelope.workspace_id) })
          .map((record) => toTaskProposalRecord(record));
      case "update-task-proposal-state": {
        const record = store.updateTaskProposalState({
          workspaceId: String(envelope.workspace_id),
          proposalId: String(envelope.proposal_id),
          state: String(envelope.state)
        });
        return record ? toTaskProposalRecord(record) : null;
      }
      default:
        throw new Error(`unsupported state-store operation: ${operation}`);
    }
  } finally {
    store.close();
  }
}

function parseArgs(argv: string[]): { operation: string; requestBase64: string } {
  if (argv.length < 3 || argv[1] !== "--request-base64") {
    throw new Error("usage: cli <operation> --request-base64 <base64-json>");
  }
  return {
    operation: argv[0],
    requestBase64: argv[2]
  };
}

function decodeRequest(encoded: string): RequestEnvelope {
  const json = Buffer.from(encoded, "base64").toString("utf-8");
  return JSON.parse(json) as RequestEnvelope;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const { operation, requestBase64 } = parseArgs(argv);
    const result = handleRequest(operation, decodeRequest(requestBase64));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
