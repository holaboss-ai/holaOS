# Holaboss Local - Neon AI Workspace Prototype

Desktop prototype inspired by a futuristic dark neon-green AI operating workspace with three docked panes:

1. File Explorer (left)
2. In-app Browser panel (center)
3. AI Chat assistant (right)

Built with Electron + React + TypeScript + Vite + Tailwind CSS.

## Features

- Electron main/preload/renderer separation with secure preload bridge
- Full-window dark neon-green visual system
- Global top tab bar with workspace controls
- Three-pane layout with draggable split handles
- Pane widths persist in local storage
- Real local file explorer (reads your filesystem via secure IPC)
- Real embedded Chromium browser (`<webview>`) with URL/home/back/forward/refresh
- AI chat panel with suggestion pills, composer, user/assistant bubbles, and local rule-based responses

## Tech Stack

- Electron
- React 19
- TypeScript
- Vite
- Tailwind CSS
- Lucide React icons

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

This launches:
- Vite dev server for the renderer (`http://localhost:5173`)
- TS build watcher for Electron main/preload (`out/dist-electron/*.cjs`)
- Electron desktop window with live restarts on main/preload changes

Internal backend preset entrypoints:

```bash
# internal-only preset hook for local backend env
npm run dev:cp:local

# internal-only preset hook for shared dev backend env
npm run dev:cp:dev

# production/default env
npm run dev:cp:prod
```

The repo does not ship remote endpoint URLs. Remote auth/backend access is configured entirely through environment variables outside the public repo. Local/dev backend overrides are only honored when `HOLABOSS_INTERNAL_DEV=1` is set or when running the unpackaged dev app through the internal preset scripts above.

Before running `npm run dev`, copy `desktop/.env.example` to `desktop/.env` and fill in the required remote values:

```bash
cp .env.example .env
```

`npm run dev` stages a runtime bundle before Electron starts. In this repo it prefers a locally built runtime when the runtime packager scripts are available.
Each staged runtime bundle is self-contained and carries the runtime API, bundled Node/npm, and bundled Python.

## Build

```bash
npm run build
```

This creates:
- Renderer production bundle in `out/dist/`
- Electron main/preload bundles in `out/dist-electron/`

## Runtime Bundle

Packaged desktop builds expect a staged runtime bundle at `out/runtime-<platform>/`:

```bash
npm run prepare:runtime
```

That stages the bundle for the current host platform from an explicit runtime source. If you need to target a specific platform explicitly:

```bash
npm run prepare:runtime:macos
npm run prepare:runtime:linux
npm run prepare:runtime:windows
```

For local development against unreleased `holaOS` runtime changes:

```bash
# optional when your OSS repo is not ../holaOS
export HOLABOSS_OSS_ROOT=/absolute/path/to/holaOS

# builds the runtime bundle for the current host platform and stages it into out/runtime-<platform>
npm run prepare:runtime:local
```

After `npm run prepare:runtime:local`, a normal `npm run dev` uses that staged local runtime bundle. Set `HOLABOSS_RUNTIME_PLATFORM=macos|linux|windows` if you need to override platform detection.

Or package directly with local runtime in one step:

```bash
npm run dist:mac
npm run dist:mac:dmg
npm run dist:win
```

The staging script accepts one of:
- `HOLABOSS_RUNTIME_DIR=/absolute/path/to/runtime-<platform>`
- `HOLABOSS_RUNTIME_TARBALL=/absolute/path/to/holaboss-runtime-<platform>-<sha>.tar.gz`
- `HOLABOSS_RUNTIME_BUNDLE_URL=https://.../holaboss-runtime-<platform>-<sha>.tar.gz`
- `HOLABOSS_RUNTIME_PLATFORM=macos|linux|windows` to override the auto-detected target platform when needed

Runtime packagers can also override the bundled Python source when needed:
- `HOLABOSS_RUNTIME_PYTHON_DIR=/absolute/path/to/extracted/python`
- `HOLABOSS_RUNTIME_PYTHON_TARBALL=/absolute/path/to/cpython-...tar.gz`
- `HOLABOSS_RUNTIME_PYTHON_URL=https://.../cpython-...tar.gz`
- `HOLABOSS_RUNTIME_PYTHON_VERSION`, `HOLABOSS_RUNTIME_PYTHON_RELEASE`, `HOLABOSS_RUNTIME_PYTHON_VARIANT`, and `HOLABOSS_RUNTIME_PYTHON_TARGET_TRIPLE`

If none are set, it falls back to the host temp directory, for example `${TMPDIR:-/tmp}/holaboss-runtime-<platform>-full`, or you can run `npm run prepare:runtime:local` first.

To build a mac app bundle with the runtime embedded in Electron resources:

```bash
npm run dist:mac
```

Use `dist:mac` for the default local-runtime packaging flow. Use `prepare:runtime` with explicit runtime source env vars when you need to package against a prebuilt runtime bundle instead.

This produces an unsigned local mac app bundle with `runtime-macos` embedded in `Contents/Resources/`.

For Windows packaging:

```bash
npm run dist:win
```

Use `dist:win` on a Windows host to build and stage a native local runtime bundle first, then produce a Windows NSIS installer.

The Windows packaging command also writes `out/holaboss-config.json` from your configured desktop environment before building the installer.

This produces a Windows NSIS installer `.exe` in `out/release/`.

Output:
- [holaOS.app](/Users/jeffrey/Desktop/holaOS/desktop/out/release/mac-arm64/holaOS.app)

Run packaged app with endpoint presets:

```bash
# internal-only local override
npm run packaged:run:local

# internal-only dev override
npm run packaged:run:dev

# production default
npm run packaged:run:prod
```

Remote configuration:
- `HOLABOSS_AUTH_BASE_URL` for Better Auth session endpoint
- `HOLABOSS_AUTH_SIGN_IN_URL` for the hosted sign-in page
- `HOLABOSS_BACKEND_BASE_URL` for the Holaboss backend base URL used by the desktop
- `HOLABOSS_INTERNAL_DEV=1` to allow non-production backend overrides in packaged runs
- `HOLABOSS_PACKAGED_APP_BIN` for an explicit packaged binary path

Start by copying the template:

```bash
cp .env.example .env
```

Optional internal-only overrides:
- `HOLABOSS_PROJECTS_URL`
- `HOLABOSS_MARKETPLACE_URL`
- `HOLABOSS_PROACTIVE_URL`

The preset scripts no longer embed concrete URLs. Internal developers are expected to source the backend URL from a private shell profile, `.envrc`, CI secret, or another non-public config mechanism before running the preset scripts.

To build a mac installer image:

```bash
npm run dist:mac:dmg
```

This produces a local-use `.dmg` installer in `out/release/`.

Notes:
- `dist:mac` builds an unpacked `.app`
- `dist:mac:dmg` builds a `.dmg` installer
- both local mac packaging commands force ad-hoc signing for local smoke testing via `--config.mac.identity=-`
- production signing and notarization are handled in GitHub Actions once the Apple secrets are configured

### Signed Product Release

Desktop validation and desktop release packaging now share the single `.github/workflows/ci.yml` workflow, whose display name is `CI`.

On pull requests and pushes to `main`, `CI` runs the normal validation jobs only. On manual dispatch, that same workflow:
- checks out the requested `ref`
- creates the requested GitHub release in `holaboss-ai/holaOS-releases`
- builds the signed and notarized macOS app, then uploads the DMG, ZIP, blockmaps, and `latest-mac.yml`
- builds the signed Windows NSIS installer, then uploads the installer, blockmap, and channel manifest

Release channel policy:
- there are no standalone runtime-only GitHub releases anymore
- desktop releases do not publish standalone runtime tarballs
- desktop-shippable releases publish to `holaboss-ai/holaOS-releases`
- the in-app desktop updater is still intended to track desktop releases, not arbitrary runtime assets

Desktop release versioning:
- use stable semver in `YYYY.MDD.R` format
- `YYYY` = year, `MDD` = month without a leading zero plus a two-digit day, `R` = release number for that date
- examples: `2026.410.1`, `2026.410.2`, `2026.1113.1`
- do not zero-pad the month in the middle segment; `2026.0410.1` is not valid semver
- desktop GitHub release tags must be `holaOS-YYYY.MDD.R`
- the desktop packager derives the app update version from the trailing `X.Y.Z` suffix in `release_tag`, so tags should end with the same `YYYY.MDD.R` value
- to print a version for today, run `npm --prefix desktop run release:version`
- to print the full desktop release tag for today, run `npm --prefix desktop run release:tag`
- to print the second release for a specific day, run `npm --prefix desktop run release:version -- 2 --date 2026-04-10`
- to print the second release tag for a specific day, run `npm --prefix desktop run release:tag -- 2 --date 2026-04-10`

The manual `CI` release path requires these repository secrets and fails fast when any of them are missing:

- `MAC_CERTIFICATE`: base64-encoded `Developer ID Application` `.p12`
- `MAC_CERTIFICATE_PASSWORD`: password for the `.p12`
- `APPLE_ID`: Apple Developer account email
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password from Apple ID settings
- `APPLE_TEAM_ID`: Apple Developer Team ID
- `AZURE_TENANT_ID`: Microsoft Entra tenant ID for the Windows signing service principal
- `AZURE_CLIENT_ID`: client ID for the Windows signing service principal
- `AZURE_CLIENT_SECRET`: client secret value for the Windows signing service principal; use the secret `Value`, not the secret ID
- `HOLABOSS_RELEASES_REPO_TOKEN`: token with read access to the private source repo and write access to `holaboss-ai/holaOS-releases`

The manual `CI` release path also requires these repository variables for Azure Trusted Signing:

- `WINDOWS_SIGNING_ENDPOINT`: Azure Trusted Signing endpoint for the account region
- `WINDOWS_SIGNING_ACCOUNT_NAME`: Trusted Signing account name
- `WINDOWS_SIGNING_CERTIFICATE_PROFILE_NAME`: certificate profile name
- `WINDOWS_SIGNING_PUBLISHER_NAME`: publisher name exactly as it appears in the certificate profile

The Windows signing service principal must have the `Artifact Signing Certificate Profile Signer` role on the Trusted Signing account or certificate profile.
The Windows CI release job validates this before the build by requesting a Trusted Signing token and signing a small probe executable, so role-assignment or propagation failures fail before the expensive installer build.

When manually triggering `CI`, provide:

- `ref`: the branch, tag, or commit you want to ship
- `release_tag`: the GitHub release tag to create or update, in `holaOS-YYYY.MDD.R` format
- `release_title`: optional display title for the GitHub release
- `prerelease`: whether the GitHub release should be marked as a prerelease when first created

The workflow stages the runtime bundle needed for each desktop build inside the runner, maps the Apple signing secrets and Azure Trusted Signing settings to `electron-builder`, and uploads the desktop release assets to the chosen GitHub release. The desktop build config uses `hardenedRuntime` plus an explicit mac entitlements plist at `resources/entitlements.mac.plist`.

Docs publishing remains separate in `.github/workflows/deploy-docs.yml` and automatically runs only for docs changes.

After a signed build, validate the produced app locally with:

```bash
codesign --verify --deep --strict --verbose=2 /path/to/holaOS.app
spctl -a -vv -t exec /path/to/holaOS.app
xcrun stapler validate /path/to/holaOS.app
```

## Project Structure

```text
electron/
  main.ts
  preload.ts
src/
  components/
    layout/
      AppShell.tsx
      TopTabsBar.tsx
      SplitPaneLayout.tsx
    panes/
      FileExplorerPane.tsx
      BrowserPane.tsx
      ChatPane.tsx
    ui/
      PaneCard.tsx
      IconButton.tsx
  data/
    mockFiles.ts
    mockBrowser.ts
  utils/
    mockAssistant.ts
  types/
    electron.d.ts
    webview.d.ts
  App.tsx
  main.tsx
  index.css
```

## Browser Notes

The center pane uses a real Electron `webview`:
- Source is set in `src/components/panes/BrowserPane.tsx`
- Navigation controls call real webview methods (`goBack`, `goForward`, `reload`, `loadURL`)
- Main process enables and guards webview attachment in `electron/main.ts`

If you later want a multi-tab browser architecture, keep the current `BrowserPane` control surface and swap to a tab manager that creates one webview per tab.

## File Explorer Notes

The left pane reads real directories from your machine:
- IPC handler lives in `electron/main.ts` (`fs:listDirectory`)
- Renderer call lives in preload bridge (`window.electronAPI.fs.listDirectory`)
- UI and navigation are in `src/components/panes/FileExplorerPane.tsx`

The explorer currently supports:
- folder open (double-click or “Open Selected Folder”)
- back/forward/up/home navigation
- search/filter in current directory
- grouped rendering by modified date (Today / This Week / This Year / Earlier)

### AI assistant

Current chat replies are local rule-based mocks (no backend/LLM):
- Rules and canned responses live in `src/utils/mockAssistant.ts`
- `ChatPane.tsx` handles message rendering and send flow

Replace point for real AI backend:
- Hook send flow in `src/components/panes/ChatPane.tsx` where `generateMockReply` is called
- Replace timeout mock with API call and stream/append tokens as needed

## Security

Renderer runs with:
- `contextIsolation: true`
- `nodeIntegration: false`
- `webviewTag: true` (enabled intentionally for embedded browser pane)

Preload bridge exposes runtime info and a constrained filesystem API via `window.electronAPI`.

## Stretch Goals Ready

Codebase is structured to support later additions such as:
- draggable top tabs
- command palette
- collapsible icon rail
- tokenized theme switching
