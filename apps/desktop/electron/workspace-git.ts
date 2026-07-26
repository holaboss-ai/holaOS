import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WORKSPACE_GIT_BRANCH = "main";
const WORKSPACE_GIT_USER_NAME = "Holaboss Agent";
const WORKSPACE_GIT_USER_EMAIL = "agent@holaboss.local";
const WORKSPACE_GIT_INITIAL_COMMIT_MESSAGE = "agent: initialize workspace";
const WORKSPACE_GIT_EXCLUDE_PATTERNS = [
  ".DS_Store",
  ".holaboss/",
  ".opencode/",
  ".output/",
  ".turbo/",
  "build/",
  "coverage/",
  "dist/",
  "node_modules/",
  "workspace.json",
];

export interface WorkspaceGitBootstrapResult {
  available: boolean;
  initialized: boolean;
  initialCommitCreated: boolean;
  branch: string;
  gitDir: string;
  skippedReason?: string;
}

export interface WorkspaceGitBootstrapOptions {
  runGitCommand?: (
    workspaceDir: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function normalizeCommandError(
  args: string[],
  error: unknown,
): Error {
  if (!(error instanceof Error)) {
    return new Error(`git ${args.join(" ")} failed`);
  }

  const stdout =
    typeof (error as { stdout?: string }).stdout === "string"
      ? (error as { stdout?: string }).stdout?.trim()
      : "";
  const stderr =
    typeof (error as { stderr?: string }).stderr === "string"
      ? (error as { stderr?: string }).stderr?.trim()
      : "";
  const detail = stderr || stdout || error.message;
  return new Error(`git ${args.join(" ")} failed: ${detail}`);
}

function isGitUnavailableError(error: unknown): boolean {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: string }).code === "string"
      ? (error as { code?: string }).code?.toUpperCase()
      : "";
  if (code === "ENOENT") {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("xcode-select: note: no developer tools were found") ||
    message.includes("xcode-select: error: invalid active developer path") ||
    message.includes('xcrun: error: unable to find utility "git"') ||
    message.includes("spawn git enoent")
  );
}

async function runGit(
  workspaceDir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, {
      cwd: workspaceDir,
    });
  } catch (error) {
    throw normalizeCommandError(args, error);
  }
}

async function writeWorkspaceGitExcludeFile(workspaceDir: string): Promise<void> {
  const infoDir = path.join(workspaceDir, ".git", "info");
  await fs.mkdir(infoDir, { recursive: true });
  const excludePath = path.join(infoDir, "exclude");
  const content = [
    "# Holaboss workspace-local excludes",
    ...WORKSPACE_GIT_EXCLUDE_PATTERNS,
    "",
  ].join("\n");
  await fs.writeFile(excludePath, content, "utf8");
}

async function hasStagedChanges(workspaceDir: string): Promise<boolean> {
  const { stdout } = await runGit(workspaceDir, ["diff", "--cached", "--name-only"]);
  return stdout.trim().length > 0;
}

export async function ensureWorkspaceGitRepo(
  workspaceDir: string,
  options: WorkspaceGitBootstrapOptions = {},
): Promise<WorkspaceGitBootstrapResult> {
  const gitRunner = options.runGitCommand ?? runGit;
  const gitDir = path.join(workspaceDir, ".git");
  if (await pathExists(gitDir)) {
    return {
      available: true,
      initialized: false,
      initialCommitCreated: false,
      branch: WORKSPACE_GIT_BRANCH,
      gitDir,
    };
  }

  await fs.mkdir(workspaceDir, { recursive: true });
  try {
    await gitRunner(workspaceDir, ["init", "--initial-branch", WORKSPACE_GIT_BRANCH]);
  } catch (error) {
    if (isGitUnavailableError(error)) {
      return {
        available: false,
        initialized: false,
        initialCommitCreated: false,
        branch: WORKSPACE_GIT_BRANCH,
        gitDir,
        skippedReason:
          error instanceof Error ? error.message : "git is unavailable on this system.",
      };
    }
    throw error;
  }

  await gitRunner(workspaceDir, ["config", "user.name", WORKSPACE_GIT_USER_NAME]);
  await gitRunner(workspaceDir, ["config", "user.email", WORKSPACE_GIT_USER_EMAIL]);
  await writeWorkspaceGitExcludeFile(workspaceDir);
  await gitRunner(workspaceDir, ["add", "-A"]);

  let initialCommitCreated = false;
  if (await hasStagedChanges(workspaceDir)) {
    await gitRunner(workspaceDir, [
      "commit",
      "-m",
      WORKSPACE_GIT_INITIAL_COMMIT_MESSAGE,
    ]);
    initialCommitCreated = true;
  }

  return {
    available: true,
    initialized: true,
    initialCommitCreated,
    branch: WORKSPACE_GIT_BRANCH,
    gitDir,
  };
}
