/** What the kit's short videos show, decided from the Run Record and the run's events. No drawing here. */

import type { BenchEvent } from "@holaboss/remote-api/contract";
import { type RunRecordView, TASK_INFO, formatMs, formatTps, speedResult, taskResults } from "./record";

export interface Segment {
  /** Seconds into the full recording. */
  start: number;
  end: number;
  task: string;
}

/** The unscored generation recorded for the video; the timed speed requests run with recording off. */
export const SHOWCASE = "showcase";

const LEAD_S = 1.5;
const TAIL_S = 2;
const TASK_LEAD_S = 5;
const TASK_TAIL_S = 2;
/** The cut plus a 4-second end card stays within 60 seconds. */
export const END_CARD_S = 4;
const MAX_CUT_S = 56;
const MIN_SHOWCASE_SEGMENT_S = 6;
const RATE_WINDOW_MS = 1000;

export function parseEvents(jsonl: string): BenchEvent[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as BenchEvent);
}

/** When the recording started, in event time: anchored on a highlight so the overlay lands on the frame it describes. */
export function recordingStartAt(events: BenchEvent[], record: RunRecordView): number | null {
  for (const highlight of record.artifacts.highlights) {
    if (highlight.label !== "first_token" || !highlight.task) {
      continue;
    }
    const first = events.find((event) => event.type === "text" && event.task === highlight.task);
    if (first) {
      return first.at - highlight.t * 1000;
    }
  }
  return null;
}

function highlightTime(record: RunRecordView, task: string, label: string): number | null {
  return record.artifacts.highlights.find((h) => h.task === task && h.label === label)?.t ?? null;
}

/** The showcase from its first token to just after it finishes, then each graded task's finish, within 60 seconds. */
export function planSegments(record: RunRecordView, durationS: number): Segment[] {
  const segments: Segment[] = [];
  const first = highlightTime(record, SHOWCASE, "first_token");
  const done = highlightTime(record, SHOWCASE, "task_done");
  if (first !== null && done !== null && done > first) {
    segments.push({ start: Math.max(0, first - LEAD_S), end: Math.min(durationS, done + TAIL_S), task: SHOWCASE });
  }
  for (const task of taskResults(record)) {
    const finished = highlightTime(record, task.task, "task_done");
    if (finished !== null) {
      segments.push({ start: Math.max(0, finished - TASK_LEAD_S), end: Math.min(durationS, finished + TASK_TAIL_S), task: task.task });
    }
  }
  const length = (list: Segment[]) => list.reduce((sum, s) => sum + (s.end - s.start), 0);
  // Over budget: shorten the showcase from its start, keeping the end where its result shows.
  const showcase = segments.find((s) => s.task === SHOWCASE);
  if (showcase && length(segments) > MAX_CUT_S) {
    showcase.start = Math.min(showcase.end - MIN_SHOWCASE_SEGMENT_S, showcase.start + (length(segments) - MAX_CUT_S));
  }
  // Tasks close together would otherwise repeat footage; the showcase leads the cut, so it stays whole.
  const tasks = segments.filter((s) => s.task !== SHOWCASE).sort((a, b) => a.start - b.start);
  for (let i = 1; i < tasks.length; i += 1) {
    tasks[i].start = Math.max(tasks[i].start, tasks[i - 1].end);
  }
  return [...segments.filter((s) => s.task === SHOWCASE), ...tasks.filter((s) => s.end > s.start)];
}

/** Tokens per stream chunk for a task's latest request, from the engine's own count; 1 before it is known. */
export function tokensPerChunk(events: BenchEvent[], task: string): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "request_done" && event.task === task) {
      const tokens = Number(event.eval_count);
      const chunks = Number(event.chunks);
      return tokens > 0 && chunks > 0 ? tokens / chunks : 1;
    }
  }
  return 1;
}

/** The live decode rate at this moment: tokens over the last second of the task's own text events. */
export function liveRate(events: BenchEvent[], task: string, atMs: number): number | null {
  const recent = events.filter(
    (event) => event.type === "text" && event.task === task && event.at <= atMs && event.at >= atMs - RATE_WINDOW_MS,
  );
  if (recent.length < 2) {
    return null;
  }
  const span = (recent[recent.length - 1].at - recent[0].at) / 1000;
  const chunks = recent.slice(1).reduce((sum, event) => sum + (typeof event.n === "number" ? event.n : 1), 0);
  return span > 0.3 ? (chunks * tokensPerChunk(events, task)) / span : null;
}

/** The showcase's own decode rate, on the same formula as the scored runs. */
export function clipRate(events: BenchEvent[]): number | null {
  const done = events.find((event) => event.type === "request_done" && event.task === SHOWCASE);
  return typeof done?.decode_tps === "number" ? done.decode_tps : null;
}

function finishedAt(events: BenchEvent[], task: string): number | null {
  return events.find((event) => event.type === "task_done" && event.task === task)?.at ?? null;
}

/** The measured result for a task, exactly as the Run Record has it, once the task is done. */
export function resultLine(record: RunRecordView, task: string, events: BenchEvent[] = []): string | null {
  if (task === SHOWCASE) {
    const clip = clipRate(events);
    return clip === null ? null : `In this clip: ${formatTps(clip)} tok/s with screen recording`;
  }
  if (task === "speed@0" || task === "speed@8k") {
    const speed = speedResult(record, task);
    if (!speed) {
      return null;
    }
    const label = task === "speed@0" ? "Decode speed" : "With 8K of context";
    return `${label} ${formatTps(speed.decode_tps)} tok/s · average of 3 runs · first token ${formatMs(speed.ttft_ms)}`;
  }
  const result = taskResults(record).find((entry) => entry.task === task);
  if (!result) {
    return null;
  }
  const title = TASK_INFO[task]?.title ?? task;
  return result.status === "unsupported" ? `${title}: not supported on Ollama` : `${title} ${result.passed}/${result.samples}`;
}

export interface OverlayState {
  task: string;
  title: string;
  live: number | null;
  result: string | null;
}

export function overlayAt(record: RunRecordView, events: BenchEvent[], startAt: number, segment: Segment, mediaTime: number): OverlayState {
  const atMs = startAt + mediaTime * 1000;
  const done = finishedAt(events, segment.task);
  const isShowcase = segment.task === SHOWCASE;
  return {
    task: segment.task,
    title: isShowcase ? "Live in this clip · screen recording on" : (TASK_INFO[segment.task]?.title ?? segment.task),
    live: isShowcase && (done === null || atMs < done) ? liveRate(events, segment.task, atMs) : null,
    result: done !== null && atMs >= done ? resultLine(record, segment.task, events) : null,
  };
}

/** The end card's lines: the clip's rate beside the measured one, then the rest as the run page has them. */
export function endCardLines(record: RunRecordView, events: BenchEvent[]): string[] {
  const clip = clipRate(events);
  const measured = speedResult(record, "speed@0")?.decode_tps;
  const lead =
    clip !== null && measured !== undefined
      ? `In this clip: ${formatTps(clip)} tok/s with screen recording · Measured: ${formatTps(measured)} tok/s with recording off, average of 3`
      : resultLine(record, "speed@0");
  return [lead, ...["speed@8k", ...taskResults(record).map((task) => task.task)].map((task) => resultLine(record, task))].filter(
    (line): line is string => line !== null,
  );
}
