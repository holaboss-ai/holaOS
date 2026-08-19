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

test("an interleaved turn that ends with its answer yields no anchor", () => {
  // Was "yields one Worked-for anchor". The collapse-to-one-anchor intent is
  // unchanged — it is pinned by the next test — but a turn that ends with its
  // streamed answer now shows no anchor in EITHER state, so nothing appears
  // when it settles and the layout stays put.
  const segments = [
    exec([step({ id: "a" })]),
    out("没找到你的 GitHub 用户名。"),
    exec([step({ id: "b" }), step({ id: "c" })]),
    out("GitHub 已连接。"),
  ];
  assert.equal(resolveTurnStatus(segments, { live: false, workedMs: 40_000 }), null);
});

test("a turn that ends on an execution segment still gets exactly one anchor", () => {
  // The original point of the test above: a turn interleaves tool phases with
  // narration, and the anchor collapses that to one turn-wide fact rather than
  // repeating per phase.
  const segments = [
    exec([step({ id: "a" })]),
    out("没找到你的 GitHub 用户名。"),
    exec([step({ id: "b" }), step({ id: "c" })]),
  ];
  assert.deepEqual(resolveTurnStatus(segments, { live: false, workedMs: 40_000 }), {
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

test("a turn that ends with its answer shows no anchor, streaming or settled", () => {
  // The end-of-turn drift. The anchor used to be absent while the answer
  // streamed and present once the turn settled ("Worked for Ns"), so a row
  // appeared the instant the agent stopped typing and pushed the answer, its
  // timestamp and everything below it down.
  const segments = [exec([step({ id: "a" })]), out("后台已开始拉")];
  assert.equal(resolveTurnStatus(segments, { live: true }), null);
  assert.equal(
    resolveTurnStatus(segments, { live: false, workedMs: 9000 }),
    null,
    "the duration is not worth moving the layout for; the trace is still under Details",
  );
});

test("anchor presence never changes when a turn settles", () => {
  // The property that actually matters: whatever the anchor does, it must do
  // the same thing on both sides of the live -> settled flip, or the layout
  // shifts by a row at that exact moment.
  const cases = [
    ["ends with its answer", [exec([step({ id: "a" })]), out("done")]],
    ["plain text reply", [out("hi there")]],
    ["ends on an execution segment", [out("working"), exec([step({ id: "b" })])]],
  ] as const;

  for (const [name, segments] of cases) {
    const streaming = resolveTurnStatus([...segments], { live: true });
    const settled = resolveTurnStatus([...segments], {
      live: false,
      workedMs: 9000,
    });
    assert.equal(
      streaming === null,
      settled === null,
      `${name}: anchor presence changed when the turn settled`,
    );
  }
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
