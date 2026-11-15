export interface BenchRecording {
  startedAt: number;
  stop: () => Promise<{ bytes: Uint8Array; extension: "mp4" | "webm" }>;
}

const MIME_PREFERENCE = ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
const VIDEO_BITS_PER_SECOND = 8_000_000;
const TIMESLICE_MS = 1000;

export function preferredRecordingMime(isSupported: (mime: string) => boolean = (mime) => MediaRecorder.isTypeSupported(mime)): string | null {
  return MIME_PREFERENCE.find((mime) => isSupported(mime)) ?? null;
}

/** Records this window only; the main process answers getDisplayMedia with the bench window's own frame. */
export async function startBenchRecording(): Promise<BenchRecording> {
  const mimeType = preferredRecordingMime();
  if (!mimeType) {
    throw new Error("This build cannot record video.");
  }
  // 1080p is what X and Shorts take; tab capture otherwise records at the display's full pixel density.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.start(TIMESLICE_MS);
  const startedAt = Date.now();
  return {
    startedAt,
    stop: () =>
      new Promise((resolve, reject) => {
        recorder.onstop = async () => {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          try {
            const blob = new Blob(chunks, { type: mimeType });
            resolve({
              bytes: new Uint8Array(await blob.arrayBuffer()),
              extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
            });
          } catch (error) {
            reject(error);
          }
        };
        recorder.stop();
      }),
  };
}
