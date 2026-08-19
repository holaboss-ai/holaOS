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

test("live streaming of the final answer keeps the anchor but stops it spinning", () => {
  // It used to return null here. That removed the row while the answer streamed
  // and restored it as "Worked for Ns" on completion — inserting a line into a
  // settled turn and shoving everything below it down the instant the agent
  // stopped typing.
  const segments = [exec([step({ id: "a" })]), out("后台已开始拉")];
  assert.deepEqual(resolveTurnStatus(segments, { live: true }), {
    label: "Working",
    spinning: false,
    tone: "default",
  });
});

test("the anchor does not appear or vanish between streaming and settled", () => {
  // The actual regression guard: whether a turn shows an anchor must not change
  // when `live` flips, or the layout shifts by one row at that exact moment.
  const withTools = [exec([step({ id: "a" })]), out("done")];
  const plainReply = [out("hi there")];

  for (const [name, segments] of [
    ["a turn that ran tools", withTools],
    ["a plain text reply", plainReply],
  ] as const) {
    const streaming = resolveTurnStatus(segments, { live: true });
    const settled = resolveTurnStatus(segments, { live: false, workedMs: 9000 });
    assert.equal(
      streaming === null,
      settled === null,
      `${name}: anchor presence changed when the turn settled`,
    );
  }
});

test("the settled anchor is the one the streaming anchor becomes", () => {
  const segments = [exec([step({ id: "a" })]), out("done")];
  assert.equal(resolveTurnStatus(segments, { live: true })?.label, "Working");
  assert.equal(
    resolveTurnStatus(segments, { live: false, workedMs: 9000 })?.label,
    "Worked for 9s",
  );
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
