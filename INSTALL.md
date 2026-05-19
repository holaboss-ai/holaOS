# Install Guide For Coding Agents

This file is a deterministic setup runbook for an agent working from a fresh machine or workspace.

## Goal

Bootstrap local Holaboss OSS desktop development, including provisioning `git` and Node.js `24`/`npm` when they are missing.

## Repository

Use this repository URL:

```bash
https://github.com/holaboss-ai/holaOS.git
```

## Quick Installer

For a fresh machine bootstrap, the repo ships an installer wrapper that can provision missing prerequisites before cloning and bootstrapping the desktop checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/holaboss-ai/holaOS/main/scripts/install.sh | bash
```

By default, that script:

- installs `git` if it is missing
- installs Node.js `24` plus `npm` if they are missing
- clones the repo into `~/holaboss-ai`
- creates `apps/desktop/.env` from `apps/desktop/.env.example` if needed
- runs `npm run desktop:install`
- runs `npm run desktop:prepare-runtime:local`
- runs `npm run desktop:typecheck`
- stops before launching Electron

If you want the installer to continue directly into the desktop dev environment after verification, use:

```bash
curl -fsSL https://raw.githubusercontent.com/holaboss-ai/holaOS/main/scripts/install.sh | bash -s -- --launch
```

Optional installer flags:

- `--dir <path>` to choose a different checkout directory
- `--ref <git-ref>` or `--branch <git-ref>` to install from a branch or tag other than `main`
- `--launch` to continue into `npm run desktop:dev`

If you are already inside a local checkout and want to reuse the same wrapper directly, run:

```bash
bash scripts/install.sh --dir "$PWD"
```

## Minimal Machine Requirements

Before running the installer, ensure the machine has:

- `curl`
- `bash`
- macOS, Linux, or WSL

If `git` is missing:

- on macOS, the installer uses Homebrew to install it
- on Linux, the installer uses the system package manager and may require `sudo`

## Prerequisites

For the manual path, ensure the machine has:

- `git`
- `node` version `24` or newer
- `npm`

Validate prerequisites:

```bash
git --version
node --version
npm --version
```

If `node --version` reports a major version lower than `24`, stop and upgrade Node.js before continuing.

## Clone The Repository

If the repository is not already present locally, clone it:

```bash
git clone https://github.com/holaboss-ai/holaOS.git
cd holaboss-ai
```

If the repository already exists locally, enter the repository root instead:

```bash
cd holaboss-ai
```

All commands below must be run from the repository root.

## Install Dependencies

Use the root wrapper script so installation stays aligned with the repo:

```bash
npm run desktop:install
```

This installs the dependencies for the Electron desktop app under `apps/desktop/`.

## Create The Desktop Environment File

If `apps/desktop/.env` does not exist yet, create it from the example file:

```bash
cp apps/desktop/.env.example apps/desktop/.env
```

The public OSS repository already includes default values in `apps/desktop/.env.example`. Copy it as-is unless a human operator gives you replacement environment values.

## Prepare The Local Runtime

Stage the local runtime bundle before verification:

```bash
npm run desktop:prepare-runtime:local
```

## Verify The Desktop Setup

Run the non-interactive desktop verification step before launching the app:

```bash
npm run desktop:typecheck
```

If it fails, stop and report the failure instead of continuing.

## Run The Desktop App

Start the local desktop development environment with:

```bash
npm run desktop:dev
```

This launches:

- the Vite renderer dev server
- the Electron main/preload watcher
- the Electron app

You do not need to run a manual `prepare` step for the normal dev path. `npm run desktop:dev` runs the desktop `predev` hook first, and that hook automatically checks for a staged runtime bundle under `apps/desktop/out/runtime-<platform>`. If the bundle is missing or stale relative to the local runtime sources, it automatically runs `npm run desktop:prepare-runtime:local`.

## Optional Runtime Validation

If you also need to validate the runtime packages on a fresh clone, prepare them first and then run the runtime test suite:

```bash
npm run runtime:state-store:install
npm run runtime:state-store:build
npm run runtime:harness-host:install
npm run runtime:harness-host:build
npm run runtime:api-server:install
npm run runtime:test
```

## Optional Manual Runtime Staging

If you want to stage the runtime from local source explicitly ahead of time, run:

```bash
npm run desktop:prepare-runtime:local
```

This builds the runtime bundle from your local source checkout and stages it into `apps/desktop/out/runtime-<platform>`.

If local runtime staging from source is not wanted and the environment should use the latest released runtime bundle for the current host platform instead, run:

```bash
npm run desktop:prepare-runtime
```

That command stages the latest published runtime bundle for the current platform from GitHub Releases into `apps/desktop/out/runtime-<platform>`.

Important:

- `npm run desktop:dev` is an interactive long-running process.
- It may fail in headless or GUI-less environments.
- If the execution environment cannot open Electron windows, stop after the desktop verification step and report that installation succeeded but interactive launch was not attempted.

## Minimal Command Sequence

If you want the one-command installer path, use:

```bash
curl -fsSL https://raw.githubusercontent.com/holaboss-ai/holaOS/main/scripts/install.sh | bash
```

For the equivalent manual fresh setup, the expected command sequence is:

```bash
git clone https://github.com/holaboss-ai/holaOS.git
cd holaboss-ai
npm run desktop:install
cp apps/desktop/.env.example apps/desktop/.env
npm run desktop:prepare-runtime:local
npm run desktop:typecheck
npm run desktop:dev
```
