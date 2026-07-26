// Composer "Image mode" — turned on by a "Create image" action. While active,
// the composer bottom bar shows the image model + quality/aspect controls, and
// on send those choices ride along with the message so the image-generator skill
// (and the underlying image tool, which takes a `size`) honor them.

import { atom } from "jotai";

export type ImageQuality = "auto" | "high" | "medium" | "low";
export type ImageAspectRatio =
  | "auto"
  | "1:1"
  | "3:4"
  | "4:3"
  | "16:9"
  | "9:16"
  | "21:9";

export interface ImageGenParams {
  quality: ImageQuality;
  aspectRatio: ImageAspectRatio;
}

export const IMAGE_QUALITY_OPTIONS: { value: ImageQuality; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export const IMAGE_ASPECT_OPTIONS: {
  value: ImageAspectRatio;
  label: string;
}[] = [
  { value: "auto", label: "Auto" },
  { value: "1:1", label: "1:1" },
  { value: "3:4", label: "3:4" },
  { value: "4:3", label: "4:3" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "21:9", label: "21:9" },
];

// Whether the composer is in image-creation mode.
export const imageComposerModeAtom = atom(false);

// The current image quality + aspect-ratio selection.
export const imageGenParamsAtom = atom<ImageGenParams>({
  quality: "auto",
  aspectRatio: "auto",
});

// The starter dropped into the composer when the user picks "Create image".
export const IMAGE_MODE_STARTER =
  "Create an image: describe what you want — subject, style, mood, colors.";

// A one-line settings suffix appended to the sent message so the image skill +
// tool pick up the quality/aspect the user chose (only when non-Auto). Returns
// "" when both are Auto (nothing to add).
export function imageSettingsSuffix(params: ImageGenParams): string {
  const parts: string[] = [];
  if (params.aspectRatio !== "auto") {
    parts.push(`aspect ratio ${params.aspectRatio}`);
  }
  if (params.quality !== "auto") {
    parts.push(`${params.quality} quality`);
  }
  return parts.length > 0 ? `\n\n[Image settings — ${parts.join(", ")}.]` : "";
}
