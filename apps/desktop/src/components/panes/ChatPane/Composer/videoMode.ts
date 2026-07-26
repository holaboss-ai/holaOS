// Composer "Video mode" — turned on by a "Create video" action. While active,
// the composer bottom bar shows the video model + resolution/aspect/duration
// controls, and on send those choices ride along with the message so the video
// tool (which takes a `size` and `seconds`) honors them. Mirrors image mode.

import { atom } from "jotai";

export type VideoResolution = "auto" | "480p" | "720p" | "1080p";
export type VideoAspectRatio =
  | "auto"
  | "1:1"
  | "3:4"
  | "4:3"
  | "16:9"
  | "9:16"
  | "21:9";
export type VideoDuration = "auto" | "4s" | "6s" | "8s" | "12s";

export interface VideoGenParams {
  resolution: VideoResolution;
  aspectRatio: VideoAspectRatio;
  duration: VideoDuration;
}

export const VIDEO_RESOLUTION_OPTIONS: {
  value: VideoResolution;
  label: string;
}[] = [
  { value: "auto", label: "Auto" },
  { value: "480p", label: "480p" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
];

export const VIDEO_ASPECT_OPTIONS: {
  value: VideoAspectRatio;
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

export const VIDEO_DURATION_OPTIONS: { value: VideoDuration; label: string }[] =
  [
    { value: "auto", label: "Auto" },
    { value: "4s", label: "4s" },
    { value: "6s", label: "6s" },
    { value: "8s", label: "8s" },
    { value: "12s", label: "12s" },
  ];

// Whether the composer is in video-creation mode.
export const videoComposerModeAtom = atom(false);

// The current resolution + aspect-ratio + duration selection.
export const videoGenParamsAtom = atom<VideoGenParams>({
  resolution: "auto",
  aspectRatio: "auto",
  duration: "auto",
});

// The starter dropped into the composer when the user picks "Create video".
export const VIDEO_MODE_STARTER =
  "Create a video: describe the scene, subject, motion, and mood.";

// A one-line directive appended to the sent message while video mode is active.
// Unlike image mode (which quotes the image-generator skill to signal intent),
// video generation is a bare runtime tool, so this suffix carries BOTH the
// "generate a video" intent and any non-Auto resolution/aspect/duration the user
// picked — the agent only ever sees the text, not the composer's mode state.
export function videoSettingsSuffix(params: VideoGenParams): string {
  const parts: string[] = [];
  if (params.resolution !== "auto") {
    parts.push(`resolution ${params.resolution}`);
  }
  if (params.aspectRatio !== "auto") {
    parts.push(`aspect ratio ${params.aspectRatio}`);
  }
  if (params.duration !== "auto") {
    parts.push(`duration ${params.duration}`);
  }
  const settings = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `\n\n[Generate a video from the description above${settings}.]`;
}
