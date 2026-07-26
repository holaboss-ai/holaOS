import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ensureWorkspaceGitRepo } from "./workspace-git.ts";

const execFileAsync = promisify(execFile);

async function runGit(workspaceDir, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceDir,
  });
  return stdout.trim();
}

test("ensureWorkspaceGitRepo initializes a workspace repo with an initial agent commit", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-workspace-git-"),
  );

  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "# Workspace\n", "utf8");
  await fs.writeFile(
    path.join(workspaceDir, "workspace.yaml"),
    "agent:\n  model: gpt-5.4\n",
    "utf8",
  );
  await fs.mkdir(path.join(workspaceDir, ".holaboss"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, ".holaboss", "state"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, ".holaboss", "state", "workspace_id"),
    "workspace-1\n",
    "utf8",
  );
  await fs.mkdir(path.join(workspaceDir, "node_modules"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "node_modules", "ignored.js"),
    "console.log('ignore');\n",
    "utf8",
  );

  const result = await ensureWorkspaceGitRepo(workspaceDir);

  assert.equal(result.available, true);
  assert.equal(result.initialized, true);
  assert.equal(result.initialCommitCreated, true);
  assert.equal(await runGit(workspaceDir, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.equal(
    await runGit(workspaceDir, ["log", "-1", "--pretty=%s"]),
    "agent: initialize workspace",
  );

  const trackedFiles = await runGit(workspaceDir, ["ls-files"]);
  assert.match(trackedFiles, /AGENTS\.md/);
  assert.match(trackedFiles, /workspace\.yaml/);
  assert.doesNotMatch(trackedFiles, /\.holaboss/);
  assert.doesNotMatch(trackedFiles, /node_modules/);

  const excludeContent = await fs.readFile(
    path.join(workspaceDir, ".git", "info", "exclude"),
    "utf8",
  );
  assert.match(excludeContent, /\.holaboss\//);
  assert.match(excludeContent, /node_modules\//);
});

test("ensureWorkspaceGitRepo is idempotent when the workspace is already initialized", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-workspace-git-"),
  );

  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "# Workspace\n", "utf8");
  await ensureWorkspaceGitRepo(workspaceDir);
  const firstCommit = await runGit(workspaceDir, ["rev-parse", "HEAD"]);

  const result = await ensureWorkspaceGitRepo(workspaceDir);

  assert.equal(result.available, true);
  assert.equal(result.initialized, false);
  assert.equal(result.initialCommitCreated, false);
  assert.equal(await runGit(workspaceDir, ["rev-parse", "HEAD"]), firstCommit);
});

test("ensureWorkspaceGitRepo skips initialization when system git is unavailable", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "holaboss-workspace-git-"),
  );

  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "# Workspace\n", "utf8");

  const result = await ensureWorkspaceGitRepo(workspaceDir, {
    runGitCommand: async (_targetDir, args) => {
      if (args[0] === "init") {
        throw new Error(
          "git init --initial-branch main failed: xcode-select: note: No developer tools were found, requesting install.",
        );
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    },
  });

  assert.equal(result.available, false);
  assert.equal(result.initialized, false);
  assert.equal(result.initialCommitCreated, false);
  assert.match(result.skippedReason ?? "", /xcode-select: note: No developer tools were found/i);
  await assert.rejects(fs.access(path.join(workspaceDir, ".git")));
});
