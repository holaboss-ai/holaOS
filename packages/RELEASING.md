# Releasing Holaboss SDK Packages

This document covers the release process for all `@holaboss/*` npm packages under `sdk/`.

Currently released from this repo:
- [`@holaboss/app-sdk`](./app-sdk) — generated TypeScript client, TanStack Query hooks, and Zod schemas for the Holaboss product API
- [`@holaboss/ui`](./ui) — shared UI primitives used across Holaboss surfaces

## Prerequisites

- npm org `@holaboss` registered at [npmjs.com](https://www.npmjs.com)
- GitHub repository secret `NPM_TOKEN` configured (see [Setup](#setup) below)
- GitHub environment `npm-publish` created with required reviewers (recommended)

## Setup

### 1. Create an npm access token

1. Log in to [npmjs.com](https://www.npmjs.com)
2. Go to **Access Tokens** → **Generate New Token** → **Granular Access Token**
3. Configure:
   - **Token name**: `holaboss-oss-github-actions`
   - **Expiration**: 365 days (set a calendar reminder to rotate)
   - **Packages and scopes**: Read and write, scoped to `@holaboss`
   - **Organizations**: No access (unless needed)
4. Copy the token

### 2. Add the secret to GitHub

1. Go to the repository **Settings** → **Secrets and variables** → **Actions**
2. Create a new repository secret:
   - **Name**: `NPM_TOKEN`
   - **Value**: the token from step 1

### 3. Create the `npm-publish` environment (recommended)

1. Go to **Settings** → **Environments** → **New environment**
2. Name it `npm-publish`
3. Enable **Required reviewers** and add yourself
4. This adds a manual approval gate before any package is published

## Release workflow

### Tag-triggered release (recommended)

The standard release flow for production versions:

```bash
cd sdk/app-sdk

# Patch release: 0.1.0 → 0.1.1
npm version patch

# Minor release: 0.1.1 → 0.2.0
npm version minor

# Major release: 0.2.0 → 1.0.0
npm version major

# Push commit + tag
git push origin main --tags
```

`npm version <patch|minor|major>` does three things automatically:
1. Bumps the version in `package.json`
2. Creates a commit: `v0.1.1`
3. Creates a git tag: `v0.1.1`

We override the default tag format so the workflow can identify which package the tag belongs to. Each package's `.npmrc` carries its own prefix, e.g. `sdk/app-sdk/.npmrc`:

```
tag-version-prefix = @holaboss/app-sdk@
```

This makes `npm version patch` produce a tag like `@holaboss/app-sdk@0.1.1` instead of `v0.1.1`.

The `publish-sdk` workflow triggers automatically on tags matching the patterns listed in `.github/workflows/publish-sdk.yml` (e.g. `@holaboss/app-sdk@*`, `@holaboss/ui@*`).

**Tag format**: `@holaboss/<package>@<semver>` — e.g. `@holaboss/app-sdk@0.1.0`, `@holaboss/ui@0.2.0`

### Manual release

For ad-hoc or emergency releases:

1. Go to **Actions** → **Publish SDK**
2. Click **Run workflow**
3. Select the package and optionally enable dry run
4. The workflow uses the version already in `package.json`

### Dry run

Always do a dry run first for major releases:

1. **Actions** → **Publish SDK** → **Run workflow**
2. Select the package, check **Dry run**
3. Inspect the workflow output to verify the package contents

## What the workflow does

```
Tag push or manual trigger
  │
  ├── Validate: resolve package name, version, verify directory exists
  │
  ├── Test: bun install → bun test
  │
  ├── Build: bun install → tsdown → verify dist/ contents → upload artifact
  │
  └── Publish: npm publish --access public --provenance
               (requires npm-publish environment approval)
```

**Provenance**: Published packages include [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestations, linking each published version to the exact commit and workflow run that produced it. This is enabled by the `--provenance` flag and `id-token: write` permission.

## Adding a new SDK package

When adding a new package (e.g. `@holaboss/mcp`):

1. Create the package under `sdk/mcp/` following the same structure as one of the existing packages (`sdk/app-sdk/` or `sdk/ui/`)
2. Add the package name as a new option in `.github/workflows/publish-sdk.yml`:
   ```yaml
   options:
     - app-sdk
     - ui
     - mcp    # add here
   ```
3. Add a CI job in `.github/workflows/ci.yml` (copy an existing per-package job pattern)
4. Add root scripts in `package.json`:
   ```json
   "sdk:mcp:install": "bun install --cwd sdk/mcp",
   "sdk:mcp:build": "bun --cwd sdk/mcp run build",
   "sdk:mcp:test": "bun --cwd sdk/mcp test"
   ```
5. Tag and release: `git tag @holaboss/mcp@0.1.0`

## Versioning policy

- Follow [Semantic Versioning](https://semver.org/)
- `0.x.y` — initial development, breaking changes allowed in minor bumps
- `1.0.0` — first stable release, breaking changes require major bump
- Each package is versioned independently

## Troubleshooting

### `npm ERR! 403 Forbidden`

- Verify `NPM_TOKEN` secret is set and not expired
- Verify the token has write access to the `@holaboss` scope
- Verify the `@holaboss` npm org exists and your account is an owner

### `npm ERR! 402 Payment Required`

- Run `npm publish --access public` — scoped packages default to private
- The workflow already includes `--access public`

### Version already exists

- npm does not allow republishing the same version
- Bump the version in `package.json`, commit, and create a new tag

### Provenance fails

- Ensure the workflow has `id-token: write` permission
- Provenance only works in GitHub Actions, not from local machines
