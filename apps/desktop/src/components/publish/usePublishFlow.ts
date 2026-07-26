import { useCallback, useEffect, useRef, useState } from "react";

export type PublishPhase =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "packaging" }
  | { status: "uploading"; uploadedBytes: number; totalBytes: number; startedAt: number }
  | { status: "finalizing" }
  | { status: "success"; submissionId: string; templateId: string; archiveSizeBytes: number }
  | { status: "error"; message: string; failedAt: "creating" | "packaging" | "uploading" | "finalizing"; submissionId?: string; uploadUrl?: string; templateId?: string };

export interface PublishInput {
  workspaceId: string;
  name: string;
  description: string;
  authorName: string;
  category: string;
  tags: string[];
  apps: string[];
  onboardingMd: string | null;
  readmeMd: string | null;
  userId: string;
  /** Per-publish opt-out file paths from the bundle file tree. */
  forceExcludePaths?: string[];
  /**
   * Resume context — if present we skip the create step and go straight to
   * package/upload using the existing submission.
   */
  resume?: {
    submissionId: string;
    templateId: string;
    uploadUrl: string;
  };
}

export interface PublishFlowApi {
  phase: PublishPhase;
  start: (input: PublishInput) => Promise<void>;
  retry: (input: PublishInput) => Promise<void>;
  reset: () => void;
}

/**
 * Drives the three-phase publish state machine: createSubmission → package+upload → finalize.
 * Subscribes to main-process progress events so the uploading phase can show a real bar.
 * On failure, captures enough context to retry from the failed step rather than restarting.
 */
export function usePublishFlow(): PublishFlowApi {
  const [phase, setPhase] = useState<PublishPhase>({ status: "idle" });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Subscribe once to publish progress for the entire mount lifetime.
  useEffect(() => {
    const unsubscribe = window.electronAPI.workspace.onPublishProgress((payload) => {
      if (payload.phase === "packaging") {
        setPhase((current) => {
          if (current.status === "packaging" || current.status === "creating") {
            return { status: "packaging" };
          }
          return current;
        });
        return;
      }
      if (payload.phase === "uploading") {
        if (payload.stage === "start" && typeof payload.totalBytes === "number") {
          setPhase({
            status: "uploading",
            uploadedBytes: 0,
            totalBytes: payload.totalBytes,
            startedAt: Date.now(),
          });
          return;
        }
        if (payload.stage === "progress" && typeof payload.uploadedBytes === "number" && typeof payload.totalBytes === "number") {
          setPhase((current) => {
            if (current.status !== "uploading") {
              return current;
            }
            return {
              ...current,
              uploadedBytes: payload.uploadedBytes ?? current.uploadedBytes,
              totalBytes: payload.totalBytes ?? current.totalBytes,
            };
          });
        }
      }
    });
    return unsubscribe;
  }, []);

  const run = useCallback(async (input: PublishInput) => {
    let submissionId = input.resume?.submissionId;
    let templateId = input.resume?.templateId ?? "";
    let uploadUrl = input.resume?.uploadUrl ?? "";

    try {
      if (!submissionId) {
        setPhase({ status: "creating" });
        const submission = await window.electronAPI.workspace.createSubmission({
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          authorName: input.authorName,
          category: input.category,
          tags: input.tags,
          apps: input.apps,
          onboardingMd: input.onboardingMd,
          readmeMd: input.readmeMd,
        });
        submissionId = submission.submission_id;
        templateId = submission.template_id;
        uploadUrl = submission.upload_url;
      }

      // Package + upload (progress events flow in via the listener above).
      setPhase({ status: "packaging" });
      const result = await window.electronAPI.workspace.packageAndUploadWorkspace({
        workspaceId: input.workspaceId,
        apps: input.apps,
        manifest: {
          template_id: templateId,
          name: input.name,
          version: "1.0.0",
          description: input.description,
          category: input.category,
          tags: input.tags,
          apps: input.apps,
          onboarding_md: input.onboardingMd,
          readme_md: input.readmeMd,
          author: { id: input.userId, name: input.authorName },
        },
        uploadUrl,
        forceExcludePaths: input.forceExcludePaths ?? [],
      });

      setPhase({ status: "finalizing" });
      await window.electronAPI.workspace.finalizeSubmission(submissionId);

      setPhase({
        status: "success",
        submissionId,
        templateId,
        archiveSizeBytes: result.archiveSizeBytes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const previous = phaseRef.current;
      const failedAt: "creating" | "packaging" | "uploading" | "finalizing" =
        previous.status === "creating"
          ? "creating"
          : previous.status === "packaging"
            ? "packaging"
            : previous.status === "uploading"
              ? "uploading"
              : "finalizing";
      setPhase({
        status: "error",
        message,
        failedAt,
        submissionId,
        templateId,
        uploadUrl,
      });
    }
  }, []);

  return {
    phase,
    start: run,
    retry: run,
    reset: () => setPhase({ status: "idle" }),
  };
}
