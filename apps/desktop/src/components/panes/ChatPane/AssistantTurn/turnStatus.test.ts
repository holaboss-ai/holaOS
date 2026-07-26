import test from "node:test";
import assert from "node:assert/strict";
import { formatWorkedDuration, resolveTurnStatus } from "./turnStatus";
import type { ChatAssistantSegment, ChatTraceStep } from "../types";

const out = (text: string): ChatAssistantSegment => ({ kind: "output", text });
const step = (partial: Partial<ChatTraceStep>): ChatTraceStep => ({
  id: "s",
  kind: "tool",
  title: "tool",
  status: "completed",
  details: [],
  order: 0,
  ...partial,
});
const exec = (steps: ChatTraceStep[]): ChatAssistantSegment => ({
  kind: "execution",
  items: steps.map((s, i) => ({
    id: `${s.id}-${i}`,
    kind: "trace_step",
    step: s,
    order: i,
  })),
});

test("interleaved completed turn yields one Worked-for anchor", () => {
  const segments = [
    exec([step({ id: "a" })]),
    out("没找到你的 GitHub 用户名。"),
    exec([step({ id: "b" }), step({ id: "c" })]),
    out("GitHub 已连接。"),
  ];
  const status = resolveTurnStatus(segments, { live: false, workedMs: 40_000 });
  assert.deepEqual(status, {
    label: "Worked for 40s",
    spinning: false,
    tone: "default",
  });
});

test("plain text reply gets no duration anchor", () => {
  const status = resolveTurnStatus([out("hi there")], {
    live: false,
    workedMs: 3000,
  });
  assert.equal(status, null);
});

test("live turn shows the active step, spinning, once", () => {
  const segments = [
    exec([step({ id: "a" })]),
    out("正在拉取。"),
    exec([step({ id: "b", status: "running", title: "fetch commits" })]),
  ];
  const status = resolveTurnStatus(segments, { live: true });
  assert.deepEqual(status, {
    label: "fetch commits",
    spinning: true,
    tone: "default",
  });
});

test("live streaming of the final answer hides the top anchor", () => {
  const segments = [exec([step({ id: "a" })]), out("后台已开始拉")];
  assert.equal(resolveTurnStatus(segments, { live: true }), null);
});

test("terminal error wins over duration", () => {
  const segments = [
    exec([
      step({ id: "p", kind: "phase", status: "error", recoverable: false }),
    ]),
  ];
  const status = resolveTurnStatus(segments, { live: false, workedMs: 5000 });
  assert.deepEqual(status, {
    label: "Run failed",
    spinning: false,
    tone: "error",
  });
});

test("recoverable phase error does not fail the turn", () => {
  const segments = [
    exec([
      step({ id: "p", kind: "phase", status: "error", recoverable: true }),
      step({ id: "q" }),
    ]),
  ];
  const status = resolveTurnStatus(segments, { live: false, workedMs: 5000 });
  assert.equal(status?.tone, "default");
  assert.equal(status?.label, "Worked for 5s");
});

test("awaiting-user phase reads as waiting, not worked", () => {
  const segments = [
    exec([
      step({ id: "phase:awaiting-user", kind: "phase", status: "waiting" }),
    ]),
  ];
  const status = resolveTurnStatus(segments, { live: false, workedMs: 5000 });
  assert.equal(status?.label, "Waiting for your input");
});

test("formatWorkedDuration formats seconds, minutes, hours", () => {
  assert.equal(formatWorkedDuration(1000), "1s");
  assert.equal(formatWorkedDuration(40_000), "40s");
  assert.equal(formatWorkedDuration(172_000), "2m 52s");
  assert.equal(formatWorkedDuration(120_000), "2m");
  assert.equal(formatWorkedDuration(3_660_000), "1h 1m");
});
