import { useCallback, useEffect, useRef, useState } from "react";

import {
  SettingsCard,
  SettingsMenuSelectRow,
} from "@/components/settings";
import {
  deriveMediaGenerationDraft,
  type MediaGenerationDraft,
  type MediaGenerationKind,
  mediaGenerationModelOptions,
  mediaGenerationPlaceholder,
  parseRuntimeConfigDocument,
  persistMediaGenerationModel,
} from "@/lib/mediaGenerationConfig";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

const EMPTY_DRAFT: MediaGenerationDraft = { providerId: "", model: "" };

/**
 * Media generation settings — the models the agent uses to generate images and
 * videos into the workspace. Self-contained: it loads + persists only the
 * `runtime.image_generation` / `runtime.video_generation` slices of the runtime
 * config, so it can render outside the Providers page (renders under
 * Settings → Agents).
 */
export function MediaGenerationSettings() {
  const { runtimeConfig: sharedRuntimeConfig } = useWorkspaceDesktop();
  const [runtimeConfig, setRuntimeConfig] =
    useState<RuntimeConfigPayload | null>(null);
  const [runtimeConfigDocument, setRuntimeConfigDocument] = useState("");
  const [documentLoaded, setDocumentLoaded] = useState(false);
  const [imageDraft, setImageDraft] = useState<MediaGenerationDraft>(EMPTY_DRAFT);
  const [videoDraft, setVideoDraft] = useState<MediaGenerationDraft>(EMPTY_DRAFT);
  const [error, setError] = useState("");

  const effectiveRuntimeConfig = sharedRuntimeConfig ?? runtimeConfig;

  // Load the config + its raw document once on mount.
  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }
    let cancelled = false;
    void Promise.all([
      window.electronAPI.runtime.getConfig(),
      window.electronAPI.runtime.getConfigDocument(),
    ]).then(([config, document]) => {
      if (cancelled) {
        return;
      }
      setRuntimeConfig(config);
      setRuntimeConfigDocument(document);
      setDocumentLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Track config changes — our own writes and any out-of-band edits — and
  // refetch the raw document so the drafts rehydrate from the source of truth.
  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }
    return window.electronAPI.runtime.onConfigChange((config) => {
      setRuntimeConfig(config);
      void window.electronAPI.runtime.getConfigDocument().then((document) => {
        setRuntimeConfigDocument(document);
        setDocumentLoaded(true);
      });
    });
  }, []);

  // `effectiveRuntimeConfig` only feeds the default-model fallback during
  // derivation; keep it out of the effect deps (via a ref) so an optimistic
  // pick isn't briefly clobbered by a config-change re-render before the
  // document refetch lands.
  const effectiveRuntimeConfigRef = useRef(effectiveRuntimeConfig);
  effectiveRuntimeConfigRef.current = effectiveRuntimeConfig;

  useEffect(() => {
    if (!documentLoaded) {
      return;
    }
    const document = parseRuntimeConfigDocument(runtimeConfigDocument);
    const config = effectiveRuntimeConfigRef.current;
    setImageDraft(deriveMediaGenerationDraft("image", document, config));
    setVideoDraft(deriveMediaGenerationDraft("video", document, config));
  }, [runtimeConfigDocument, documentLoaded]);

  const handleModelChange = useCallback(
    async (kind: MediaGenerationKind, value: string) => {
      // Optimistic: reflect the pick immediately in the control.
      const draft: MediaGenerationDraft = { providerId: "holaboss", model: value };
      if (kind === "image") {
        setImageDraft(draft);
      } else {
        setVideoDraft(draft);
      }
      try {
        const next = await persistMediaGenerationModel(kind, value);
        if (next) {
          setRuntimeConfig(next);
        }
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update model.");
      }
    },
    [],
  );

  const imageOptions = mediaGenerationModelOptions(
    "image",
    imageDraft,
    effectiveRuntimeConfig,
  );
  const videoOptions = mediaGenerationModelOptions(
    "video",
    videoDraft,
    effectiveRuntimeConfig,
  );

  return (
    <div className="grid gap-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Media generation
          </h2>
        </div>

        {error ? (
          <p className="text-xs leading-5 text-destructive">{error}</p>
        ) : null}

        <SettingsCard>
          <SettingsMenuSelectRow
            label="Image generation"
            description="Used when the agent generates new images into the workspace."
            value={imageDraft.model}
            onValueChange={(value) => {
              void handleModelChange("image", value);
            }}
            options={imageOptions.map((modelId) => ({
              value: modelId,
              label: modelId,
              keywords: [modelId],
            }))}
            disabled={imageOptions.length === 0}
            placeholder={mediaGenerationPlaceholder("image", effectiveRuntimeConfig)}
          />
          <SettingsMenuSelectRow
            label="Video generation"
            description="Used when the agent generates new videos into the workspace."
            value={videoDraft.model}
            onValueChange={(value) => {
              void handleModelChange("video", value);
            }}
            options={videoOptions.map((modelId) => ({
              value: modelId,
              label: modelId,
              keywords: [modelId],
            }))}
            disabled={videoOptions.length === 0}
            placeholder={mediaGenerationPlaceholder("video", effectiveRuntimeConfig)}
          />
        </SettingsCard>
    </div>
  );
}
