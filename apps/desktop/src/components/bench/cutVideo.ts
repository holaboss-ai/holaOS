/** Cuts the run recording into the kit's 16:9 and 9:16 videos: WebCodecs H.264 into an MP4, no ffmpeg. */

import type { BenchEvent } from "@holaboss/remote-api/contract";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import {
  END_CARD_S,
  type OverlayState,
  SHOWCASE,
  type Segment,
  endCardLines,
  overlayAt,
  planSegments,
  recordingStartAt,
} from "./cutPlan";
import { type RunRecordView, engineLabel, formatTps, hardwareLabel } from "./record";

const FPS = 30;
const FRAME_WATCHDOG_MS = 5000;
const KEYFRAME_EVERY = FPS * 2;
const CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42001f"];
const BITRATE = { landscape: 10_000_000, portrait: 8_000_000 };
const MARK = "holaOS · hub.holaos.ai";
const INK = "#ffffff";
const INK_MUTED = "rgba(255,255,255,0.7)";
const PANEL = "rgba(16,14,12,0.78)";
const BACKDROP = "#151311";
const ACCENT = "#ff6421";
const WARN = "#f5b14c";

type Layout = "landscape" | "portrait";
const SIZE: Record<Layout, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};

export interface CutVideos {
  landscape: Uint8Array;
  portrait: Uint8Array;
}

async function supportedCodec(layout: Layout): Promise<string | null> {
  if (typeof VideoEncoder === "undefined") {
    return null;
  }
  for (const codec of CODECS) {
    const { supported } = await VideoEncoder.isConfigSupported({ codec, ...SIZE[layout], bitrate: BITRATE[layout], framerate: FPS });
    if (supported) {
      return codec;
    }
  }
  return null;
}

interface Track {
  layout: Layout;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  encoder: VideoEncoder;
  muxer: Muxer<ArrayBufferTarget>;
  frames: number;
  status: { failure: Error | null };
}

function makeTrack(layout: Layout, codec: string): Track {
  const { width, height } = SIZE[layout];
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("No 2D canvas for the kit video.");
  }
  // A segment's first presented frame lands just after its start, so the first timestamp is rarely exactly 0.
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  const status: Track["status"] = { failure: null };
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (error) {
        status.failure ??= error instanceof Error ? error : new Error(String(error));
      }
    },
    error: (error) => {
      status.failure = error instanceof Error ? error : new Error(String(error));
    },
  });
  encoder.configure({ codec, width, height, bitrate: BITRATE[layout], framerate: FPS });
  return { layout, canvas, ctx, encoder, muxer, frames: 0, status };
}

function encode(track: Track, timestampS: number): void {
  const frame = new VideoFrame(track.canvas, { timestamp: Math.round(timestampS * 1_000_000), duration: Math.round(1_000_000 / FPS) });
  track.encoder.encode(frame, { keyFrame: track.frames % KEYFRAME_EVERY === 0 });
  frame.close();
  track.frames += 1;
}

function fitText(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number, weight: number, size: number): void {
  let px = size;
  ctx.font = `${weight} ${px}px Inter, -apple-system, system-ui, sans-serif`;
  while (ctx.measureText(text).width > maxWidth && px > 12) {
    px -= 2;
    ctx.font = `${weight} ${px}px Inter, -apple-system, system-ui, sans-serif`;
  }
}

function text(ctx: OffscreenCanvasRenderingContext2D, value: string, x: number, y: number, opts: { size: number; weight?: number; color?: string; align?: CanvasTextAlign; maxWidth?: number }): void {
  fitText(ctx, value, opts.maxWidth ?? 10_000, opts.weight ?? 500, opts.size);
  ctx.fillStyle = opts.color ?? INK;
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(value, x, y);
}

interface Labels {
  model: string;
  machine: string;
  suite: string;
}

function liveText(state: OverlayState): string {
  return state.live === null ? "–" : formatTps(state.live);
}

/** The clip's rate and the measured one read as two lines on a narrow card. */
function endCardRows(lines: string[]): string[] {
  return lines.flatMap((line) => line.split(" · Measured: ").map((part, index) => (index === 0 ? part : `Measured: ${part}`)));
}

function rowColor(line: string, index: number): string {
  if (line.startsWith("Other programs used")) {
    return WARN;
  }
  return index < 2 ? INK : INK_MUTED;
}

function drawEndLandscape(track: Track, labels: Labels, end: string[]): void {
  const { ctx } = track;
  const { width, height } = SIZE.landscape;
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, width, height);
  text(ctx, labels.model, width / 2, 190, { size: 72, weight: 700, align: "center", maxWidth: width - 160 });
  text(ctx, labels.suite, width / 2, 250, { size: 30, color: INK_MUTED, align: "center" });
  const rows = endCardRows(end);
  const top = (height - rows.length * 62) / 2 + 60;
  rows.forEach((line, index) => {
    text(ctx, line, width / 2, top + index * 62, { size: 38, weight: 600, align: "center", maxWidth: width - 200, color: rowColor(line, index) });
  });
  text(ctx, labels.machine, width / 2, height - 110, { size: 32, weight: 600, align: "center", maxWidth: width - 160 });
  text(ctx, MARK, width / 2, height - 60, { size: 26, color: INK_MUTED, align: "center" });
}

function drawLandscape(track: Track, source: CanvasImageSource | null, state: OverlayState | null, labels: Labels, end: string[] | null): void {
  if (end) {
    drawEndLandscape(track, labels, end);
    return;
  }
  const { ctx } = track;
  const { width, height } = SIZE.landscape;
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, width, height);
  if (source) {
    ctx.drawImage(source, 0, 0, width, height);
  }
  ctx.fillStyle = PANEL;
  ctx.fillRect(0, height - 150, width, 150);
  text(ctx, labels.model, 48, height - 88, { size: 44, weight: 700, maxWidth: 760 });
  text(ctx, labels.machine, 48, height - 40, { size: 28, color: INK_MUTED, maxWidth: 760 });
  if (state) {
    if (state.result) {
      text(ctx, state.result, width - 48, height - 62, { size: 32, weight: 700, align: "right", maxWidth: 1050 });
    } else if (state.task === SHOWCASE) {
      text(ctx, `${liveText(state)} tok/s`, width - 48, height - 64, { size: 64, weight: 700, align: "right" });
      text(ctx, state.title, width - 48, height - 26, { size: 24, color: INK_MUTED, align: "right" });
    } else {
      text(ctx, state.title, width - 48, height - 62, { size: 34, weight: 600, align: "right" });
    }
  }
  ctx.fillStyle = PANEL;
  ctx.fillRect(width - 560, 24, 536, 54);
  text(ctx, `${labels.suite} · ${MARK}`, width - 42, 61, { size: 22, color: INK, align: "right", maxWidth: 500 });
}

function drawPortrait(track: Track, source: CanvasImageSource | null, state: OverlayState | null, labels: Labels, end: string[] | null): void {
  const { ctx } = track;
  const { width, height } = SIZE.portrait;
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, width, height);
  text(ctx, labels.model, width / 2, 250, { size: 84, weight: 700, align: "center", maxWidth: width - 120 });
  text(ctx, labels.suite, width / 2, 320, { size: 34, color: INK_MUTED, align: "center" });
  const videoTop = 420;
  const videoHeight = Math.round((width * 9) / 16);
  if (source && !end) {
    ctx.drawImage(source, 0, videoTop, width, videoHeight);
  }
  const below = videoTop + videoHeight;
  if (end) {
    endCardRows(end).forEach((line, index) => {
      text(ctx, line, width / 2, videoTop + 120 + index * 84, { size: 44, weight: 600, align: "center", maxWidth: width - 100, color: rowColor(line, index) });
    });
  } else if (state) {
    if (state.task === SHOWCASE && !state.result) {
      text(ctx, liveText(state), width / 2, below + 300, { size: 220, weight: 800, align: "center", color: ACCENT });
      text(ctx, "tokens per second", width / 2, below + 380, { size: 40, color: INK_MUTED, align: "center" });
      text(ctx, state.title, width / 2, below + 450, { size: 36, color: INK_MUTED, align: "center" });
    } else {
      text(ctx, state.title, width / 2, below + 200, { size: 52, weight: 700, align: "center", maxWidth: width - 100 });
      if (state.result) {
        text(ctx, state.result, width / 2, below + 290, { size: 44, weight: 600, align: "center", color: ACCENT, maxWidth: width - 100 });
      }
    }
  }
  text(ctx, labels.machine, width / 2, height - 170, { size: 40, weight: 600, align: "center", maxWidth: width - 100 });
  text(ctx, MARK, width / 2, height - 100, { size: 32, color: INK_MUTED, align: "center" });
}

function waitFor(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
      resolve();
    };
    const fail = () => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
      reject(new Error(`The recording could not be read (${event}).`));
    };
    target.addEventListener(event, done);
    target.addEventListener("error", fail);
  });
}

/** Plays one segment at normal speed and draws every presented frame into both tracks, timed by the frame's own media time. */
function playSegment(video: HTMLVideoElement, segment: Segment, offsetS: number, draw: (mediaTime: number, outputS: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    let last = segment.start;
    let settled = false;
    let watchdog = setTimeout(() => reject(new Error("The recording stopped presenting frames.")), FRAME_WATCHDOG_MS);
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      video.removeEventListener("ended", finish);
      video.pause();
      resolve(offsetS + (last - segment.start));
    };
    // The showcase runs to the end of the recording, and no frame callback follows the last frame.
    video.addEventListener("ended", finish);
    const step = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (settled) {
        return;
      }
      clearTimeout(watchdog);
      watchdog = setTimeout(() => reject(new Error("The recording stopped presenting frames.")), FRAME_WATCHDOG_MS);
      const mediaTime = meta.mediaTime;
      if (mediaTime >= segment.end || video.ended) {
        finish();
        return;
      }
      if (mediaTime >= segment.start) {
        last = mediaTime;
        draw(mediaTime, offsetS + (mediaTime - segment.start));
      }
      video.requestVideoFrameCallback(step);
    };
    video.requestVideoFrameCallback(step);
    video.play().catch(reject);
  });
}

/** Both kit videos, or null when this machine can't encode H.264 (the kit then ships the full recording instead). */
export async function cutVideos(input: {
  recording: Uint8Array<ArrayBuffer>;
  mime: string;
  events: BenchEvent[];
  record: RunRecordView;
  onProgress?: (fraction: number) => void;
}): Promise<CutVideos | null> {
  const [landscapeCodec, portraitCodec] = await Promise.all([supportedCodec("landscape"), supportedCodec("portrait")]);
  if (!landscapeCodec || !portraitCodec) {
    return null;
  }
  const startAt = recordingStartAt(input.events, input.record);
  if (startAt === null) {
    throw new Error("the recording has no first-token moment to line the numbers up with");
  }
  const url = URL.createObjectURL(new Blob([input.recording], { type: input.mime }));
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // Frame callbacks only fire for a video that is on the page and presenting frames.
  video.style.cssText = "position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
  document.body.append(video);
  video.src = url;
  try {
    await waitFor(video, "loadeddata");
    const segments = planSegments(input.record, video.duration);
    if (segments.length === 0) {
      throw new Error("the run has no highlights to cut around");
    }
    const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0) + END_CARD_S;
    const tracks = [makeTrack("landscape", landscapeCodec), makeTrack("portrait", portraitCodec)];
    const labels: Labels = {
      model: `${input.record.subject.name} · ${input.record.subject.quant}`,
      machine: `${hardwareLabel(input.record)} · ${engineLabel(input.record)}`,
      suite: `${input.record.suite.id}@${input.record.suite.version}`,
    };
    const drawAll = (source: CanvasImageSource | null, state: OverlayState | null, end: string[] | null, outputS: number) => {
      drawLandscape(tracks[0], source, state, labels, end);
      drawPortrait(tracks[1], source, state, labels, end);
      for (const track of tracks) {
        encode(track, outputS);
      }
      input.onProgress?.(Math.min(1, outputS / total));
    };
    let offset = 0;
    for (const segment of segments) {
      video.currentTime = segment.start;
      await waitFor(video, "seeked");
      offset = await playSegment(video, segment, offset, (mediaTime, outputS) =>
        drawAll(video, overlayAt(input.record, input.events, startAt, segment, mediaTime), null, outputS),
      );
      offset += 1 / FPS;
    }
    const ending = endCardLines(input.record, input.events);
    for (let i = 0; i < END_CARD_S * FPS; i += 1) {
      drawAll(null, null, ending, offset + i / FPS);
    }
    const out: Uint8Array[] = [];
    for (const track of tracks) {
      await track.encoder.flush();
      if (track.status.failure) {
        throw track.status.failure;
      }
      track.muxer.finalize();
      out.push(new Uint8Array(track.muxer.target.buffer));
      track.encoder.close();
    }
    return { landscape: out[0], portrait: out[1] };
  } finally {
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
