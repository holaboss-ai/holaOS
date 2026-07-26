// The composer bottom bar while Image mode is active: an "Image" mode pill, a
// real image-model dropdown (the same runtime.image_generation config the Media
// settings pane writes), and a quality + aspect-ratio popover. Mirrors the
// reference layout: [🖼 Image] [Model ▾] [Quality · Aspect ▾].

import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Image as ImageIcon, X } from "@/components/ui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  deriveMediaGenerationDraft,
  type MediaGenerationDraft,
  mediaGenerationDefaultModel,
  mediaGenerationModelOptions,
  parseRuntimeConfigDocument,
  persistMediaGenerationModel,
} from "@/lib/mediaGenerationConfig";
import { cn } from "@/lib/utils";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import {
  IMAGE_ASPECT_OPTIONS,
  type ImageAspectRatio,
  IMAGE_QUALITY_OPTIONS,
  imageComposerModeAtom,
  imageGenParamsAtom,
} from "./imageMode";

const EMPTY_DRAFT: MediaGenerationDraft = { providerId: "", model: "" };

function shortModelLabel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return "Default model";
  }
  return trimmed.split("/").pop() ?? trimmed;
}

// Tiny proportional rectangle for the aspect-ratio buttons (like the reference).
const ASPECT_DIMS: Record<ImageAspectRatio, { w: number; h: number }> = {
  auto: { w: 12, h: 10 },
  "1:1": { w: 11, h: 11 },
  "3:4": { w: 9, h: 12 },
  "4:3": { w: 12, h: 9 },
  "16:9": { w: 14, h: 8 },
  "9:16": { w: 8, h: 14 },
  "21:9": { w: 14, h: 6 },
};

function AspectGlyph({ ratio }: { ratio: ImageAspectRatio }) {
  const { w, h } = ASPECT_DIMS[ratio];
  return (
    <span aria-hidden className="grid h-4 place-items-center">
      <span
        className="rounded-[2px] border border-current"
        style={{ width: w, height: h }}
      />
    </span>
  );
}

export function ImageComposerControls() {
  const setImageMode = useSetAtom(imageComposerModeAtom);
  const [params, setParams] = useAtom(imageGenParamsAtom);
  const { runtimeConfig } = useWorkspaceDesktop();
  const [document, setDocument] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<MediaGenerationDraft>(EMPTY_DRAFT);

  // Load the config document (holds the current image model) + keep it fresh.
  useEffect(() => {
    let alive = true;
    void window.electronAPI?.runtime.getConfigDocument().then((doc) => {
      if (alive) {
        setDocument(doc);
        setLoaded(true);
      }
    });
    const off = window.electronAPI?.runtime.onConfigChange(() => {
      void window.electronAPI?.runtime.getConfigDocument().then((doc) => {
        if (alive) {
          setDocument(doc);
        }
      });
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (!loaded) {
      return;
    }
    const parsed = parseRuntimeConfigDocument(document);
    setDraft(deriveMediaGenerationDraft("image", parsed, runtimeConfig ?? null));
  }, [document, loaded, runtimeConfig]);

  const options = useMemo(
    () => mediaGenerationModelOptions("image", draft, runtimeConfig ?? null),
    [draft, runtimeConfig],
  );
  // Fall back to the configured default so the pill always shows a real model.
  const currentModel =
    draft.model.trim() ||
    mediaGenerationDefaultModel("image", runtimeConfig ?? null);

  const selectModel = useCallback(async (model: string) => {
    setDraft({ providerId: "holaboss", model });
    try {
      await persistMediaGenerationModel("image", model);
    } catch {
      // keep the optimistic selection; the next config-change reconciles it
    }
  }, []);

  const qualityLabel =
    IMAGE_QUALITY_OPTIONS.find((o) => o.value === params.quality)?.label ??
    "Auto";
  const aspectLabel =
    IMAGE_ASPECT_OPTIONS.find((o) => o.value === params.aspectRatio)?.label ??
    "Auto";

  const chip =
    "flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-foreground text-xs transition-colors hover:bg-foreground/6";

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 font-medium text-primary text-xs transition-colors hover:bg-primary/15"
        onClick={() => setImageMode(false)}
        title="Exit image mode"
        type="button"
      >
        <ImageIcon className="size-3.5" />
        Image
        <X className="size-3 opacity-70" />
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button className={cn(chip, "min-w-0")} title="Image model" type="button">
              <span className="max-w-[130px] truncate">
                {shortModelLabel(currentModel)}
              </span>
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </button>
          }
        />
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-56 overflow-y-auto"
        >
          {options.length === 0 ? (
            <DropdownMenuItem disabled>
              No image models configured
            </DropdownMenuItem>
          ) : (
            options.map((model) => (
              <DropdownMenuItem
                className={
                  model === currentModel ? "bg-foreground/6" : undefined
                }
                key={model}
                onClick={() => void selectModel(model)}
              >
                <span className="truncate">{model}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover>
        <PopoverTrigger
          render={
            <button className={chip} title="Image quality & aspect ratio" type="button">
              <span className="truncate">
                {qualityLabel} · {aspectLabel}
              </span>
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </button>
          }
        />
        <PopoverContent align="start" className="w-72">
          <div className="mb-1.5 font-medium text-sm">Image quality</div>
          <div className="mb-4 flex rounded-lg bg-foreground/5 p-0.5">
            {IMAGE_QUALITY_OPTIONS.map((o) => (
              <button
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-xs transition-colors",
                  params.quality === o.value
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={o.value}
                onClick={() => setParams((p) => ({ ...p, quality: o.value }))}
                type="button"
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="mb-1.5 font-medium text-sm">Aspect ratio</div>
          <div className="grid grid-cols-4 gap-1.5">
            {IMAGE_ASPECT_OPTIONS.map((o) => (
              <button
                className={cn(
                  "flex flex-col items-center justify-center gap-1 rounded-lg border py-2 text-xs transition-colors",
                  params.aspectRatio === o.value
                    ? "border-foreground/40 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                key={o.value}
                onClick={() =>
                  setParams((p) => ({ ...p, aspectRatio: o.value }))
                }
                type="button"
              >
                <AspectGlyph ratio={o.value} />
                {o.label}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
