import assert from "node:assert/strict";
import test from "node:test";

import {
  selectTurnResultCards,
  turnHasDisplayableOutputs,
} from "./turnResultCards";

function out(
  overrides: Partial<WorkspaceOutputRecordPayload> & { id: string },
): WorkspaceOutputRecordPayload {
  return {
    id: overrides.id,
    workspace_id: overrides.workspace_id ?? "ws-1",
    output_type: overrides.output_type ?? "file",
    title: overrides.title ?? "",
    status: overrides.status ?? "draft",
    module_id: overrides.module_id ?? null,
    module_resource_id: overrides.module_resource_id ?? null,
    file_path: overrides.file_path ?? null,
    html_content: overrides.html_content ?? null,
    session_id: overrides.session_id ?? null,
    project_id: overrides.project_id ?? null,
    input_id: overrides.input_id ?? null,
    artifact_id: overrides.artifact_id ?? null,
    folder_id: overrides.folder_id ?? null,
    platform: overrides.platform ?? null,
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
  };
}

test("keeps the deliverable, drops the process noise around it", () => {
  const outputs = [
    out({ id: "1", file_path: "outputs/销售助理.pptx" }),
    out({ id: "2", file_path: "outputs/browser-screenshots/shot-1.png" }),
    out({ id: "3", file_path: "outputs/scratch/notes.json" }),
    out({ id: "4", file_path: "outputs/tmp/build.lock" }),
  ];
  const { cards, totalCount } = selectTurnResultCards(outputs);
  // screenshots are managed noise and excluded; the .pptx, scratch json and
  // lockfile remain browsable.
  assert.equal(totalCount, 3);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    kind: "output",
    output: outputs[0],
  });
});

test("collapses apps/<id>/* source files into one app card", () => {
  const outputs = [
    out({ id: "1", file_path: "apps/github-tracker/main.tsx" }),
    out({ id: "2", file_path: "apps/github-tracker/package.json" }),
    out({ id: "3", file_path: "apps/github-tracker/bun.lock" }),
  ];
  const { cards } = selectTurnResultCards(outputs);
  assert.deepEqual(cards, [{ kind: "app", appId: "github-tracker" }]);
});

test("shows multiple deliverables; path-less report counts, agents.md/skills don't", () => {
  const outputs = [
    out({ id: "1", file_path: "outputs/a.docx" }),
    out({ id: "2", file_path: "outputs/b.xlsx" }),
    out({ id: "3", output_type: "document", html_content: "<h1>r</h1>" }),
    out({ id: "4", file_path: "AGENTS.md" }),
    out({ id: "5", file_path: "skills/foo/SKILL.md" }),
    out({ id: "6", file_path: "src/index.ts" }),
  ];
  const { cards } = selectTurnResultCards(outputs);
  assert.deepEqual(
    cards.map((c) => (c.kind === "output" ? c.output.id : `app:${c.appId}`)),
    ["1", "2", "3"],
  );
});

test("a markdown draft is hidden when the run also rendered a final doc", () => {
  const outputs = [
    out({ id: "1", file_path: "outputs/brief.md" }),
    out({ id: "2", file_path: "outputs/brief.docx" }),
  ];
  const { cards } = selectTurnResultCards(outputs);
  assert.deepEqual(cards, [{ kind: "output", output: outputs[1] }]);
});

test("a markdown is shown when it is the only result (no final format)", () => {
  const outputs = [
    out({ id: "1", file_path: "outputs/readme.md" }),
    out({ id: "2", file_path: "src/index.ts" }),
  ];
  const { cards } = selectTurnResultCards(outputs);
  assert.deepEqual(cards, [{ kind: "output", output: outputs[0] }]);
});

test("source drafts are also dropped when the run's result is an app", () => {
  const outputs = [
    out({ id: "1", file_path: "apps/tracker/main.tsx" }),
    out({ id: "2", file_path: "outputs/plan.md" }),
  ];
  const { cards } = selectTurnResultCards(outputs);
  assert.deepEqual(cards, [{ kind: "app", appId: "tracker" }]);
});

test("zero deliverables yields no cards but reports the total", () => {
  const outputs = [
    out({ id: "1", file_path: "src/index.ts" }),
    out({ id: "2", file_path: "outputs/browser-screenshots/x.png" }),
  ];
  const { cards, totalCount } = selectTurnResultCards(outputs);
  assert.equal(cards.length, 0);
  // src/index.ts stays browsable; the screenshot is managed noise.
  assert.equal(totalCount, 1);
});

test("an app build shows the app card and counts only user-facing files", () => {
  const outputs = [
    out({ id: "1", file_path: "apps/githubpulse/server.ts" }),
    out({ id: "2", file_path: "apps/githubpulse/src/client/routes/index.tsx" }),
    out({ id: "3", output_type: "document", file_path: "workspace.yaml" }),
  ];
  const { cards, totalCount } = selectTurnResultCards(outputs);
  assert.deepEqual(cards, [{ kind: "app", appId: "githubpulse" }]);
  assert.equal(totalCount, 1);
});

test("app card preserves the app id's original case", () => {
  const outputs = [out({ id: "1", file_path: "apps/MyApp/server.ts" })];
  const { cards } = selectTurnResultCards(outputs);
  assert.deepEqual(cards, [{ kind: "app", appId: "MyApp" }]);
});

test("a generated video clip renders as a final deliverable card", () => {
  const outputs = [out({ id: "1", file_path: "outputs/videos/cat_clip.mp4" })];
  const { cards, totalCount } = selectTurnResultCards(outputs);
  assert.equal(totalCount, 1);
  assert.deepEqual(cards, [{ kind: "output", output: outputs[0] }]);
  assert.equal(turnHasDisplayableOutputs(outputs), true);
});

test("a video deliverable suppresses a same-turn markdown draft", () => {
  const outputs = [
    out({ id: "1", file_path: "outputs/videos/clip.mov" }),
    out({ id: "2", file_path: "outputs/notes.md" }),
  ];
  const { cards } = selectTurnResultCards(outputs);
  assert.deepEqual(
    cards.map((c) => (c.kind === "output" ? c.output.id : `app:${c.appId}`)),
    ["1"],
  );
});

test("turnHasDisplayableOutputs: true for app/deliverable, false for managed-only", () => {
  assert.equal(
    turnHasDisplayableOutputs([out({ id: "1", file_path: "apps/x/server.ts" })]),
    true,
  );
  assert.equal(
    turnHasDisplayableOutputs([out({ id: "1", file_path: "outputs/a.docx" })]),
    true,
  );
  assert.equal(
    turnHasDisplayableOutputs([
      out({ id: "1", file_path: "AGENTS.md" }),
      out({ id: "2", file_path: "skills/foo/SKILL.md" }),
      out({ id: "3", file_path: "outputs/browser-screenshots/x.png" }),
    ]),
    false,
  );
  assert.equal(turnHasDisplayableOutputs([]), false);
});

test("renders a send_file delivery even when its extension isn't whitelisted", () => {
  const { cards } = selectTurnResultCards([
    out({
      id: "1",
      file_path: "outputs/docker-compose.yml",
      metadata: { tool_id: "send_file", change_type: "delivered" },
    }),
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.kind, "output");
});

test("a non-whitelisted file WITHOUT the delivery marker is still dropped", () => {
  const { cards } = selectTurnResultCards([
    out({ id: "1", file_path: "outputs/docker-compose.yml" }),
  ]);
  assert.equal(cards.length, 0);
});
