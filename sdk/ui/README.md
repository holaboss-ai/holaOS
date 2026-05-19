# @holaboss/ui

Shared UI library for holaOS — primitives, layouts, and CSS tokens used by [app-builder-sdk](https://github.com/holaboss-ai/holaOS/tree/main/sdk/app-builder-sdk) dashboards.

The goal is **visual consistency across agent-built apps**. Tokens already keep colors and radii in sync; this library adds the composition layer — page chrome, empty states, loading skeletons, data-table density — so every dashboard built in a workspace looks like it belongs to the same product.

## Install

```bash
bun add @holaboss/ui
# or: npm install @holaboss/ui
# or: pnpm add @holaboss/ui
```

Peer deps: `react ^19`, `react-dom ^19`.

## Mount the styles

At the root of your app (e.g. `routes/__root.tsx`):

```tsx
import "@holaboss/ui/styles.css";
```

That one import covers everything: the design tokens, the default theme, and every Tailwind utility class the library's primitives + layouts use (pre-compiled at build time, so you do **not** need to add `@holaboss/ui` to your own Tailwind `@source` list).

If you want just the raw tokens without the baked-in utility set, the escape hatch is:

```tsx
import "@holaboss/ui/tokens.css";
import "@holaboss/ui/themes/holaos.css";
```

But the recommended path is the single `styles.css` import.

## What ships

### Primitives

Drop-in shadcn-style components on top of `@base-ui/react`. They match the holaOS desktop's canonical style exactly.

`Alert` · `Badge` · `Button` · `Card` (+ `CardHeader/Title/Description/Content/Footer/Action`) · `DropdownMenu` family · `EmptyState` · `Input` · `Kbd` · `Label` · `Popover` family · `Select` family · `StatusDot` · `Switch` · `Tabs` family · `Tooltip` family

### Layouts

Composition primitives that solve the actual dashboard-drift problem. Reach for these instead of hand-rolling a similar shape.

- **`DashboardShell`** — sticky-header chrome + scrollable content
- **`PageHeader`** — title + description + action row
- **`Section`** — title + description over a content block
- **`FilterBar`** — search input + filter chip slot + actions
- **`DataTable`** — typed columns, optional row click, built-in loading + empty states
- **`StatPill`** — small metric (label + value + tone + optional trend / icon)
- **`LoadingState`** — skeleton variants: `rows` / `list` / `card`
- **`ErrorState`** — error display with optional retry button

### Utility

- **`cn(...inputs)`** — class merging via `clsx` + `tailwind-merge`

## Minimal example

```tsx
import {
  Badge,
  Button,
  DashboardShell,
  DataTable,
  FilterBar,
  PageHeader,
  Section,
  StatPill,
  type DataTableColumn,
} from "@holaboss/ui";

const columns: DataTableColumn<Issue>[] = [
  { id: "title", header: "Title", cell: (row) => row.title },
  { id: "status", header: "Status", width: "120px", cell: (row) => <Badge>{row.status}</Badge> },
];

export default function Dashboard() {
  return (
    <DashboardShell
      header={
        <>
          <PageHeader
            title="Issues"
            description="GitHub issues synced into the workspace"
            actions={<Button size="sm">Refresh</Button>}
          />
          <FilterBar search={search} onSearchChange={setSearch} />
        </>
      }
    >
      <Section title="Overview">
        <div className="grid grid-cols-3 gap-3">
          <StatPill label="Open" value={open} tone="positive" />
          <StatPill label="In progress" value={inProgress} />
          <StatPill label="Closed" value={closed} />
        </div>
      </Section>
      <Section title="Issues">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => String(r.id)}
          isLoading={isLoading}
          emptyTitle="No issues yet"
        />
      </Section>
    </DashboardShell>
  );
}
```

## What this is **not**

- A replacement for Tailwind. The library expects Tailwind in the consuming app (the tokens compile against Tailwind's CSS-variable layer).
- A theming system. Themes are workspace-level; a single app does not get a theme toggle.
- A "ship raw shadcn" library. The primitives are pinned to the holaOS-canonical version — if shadcn's upstream changes, this package updates first.

## Release

`@holaboss/ui` lives in the [holaOS monorepo](https://github.com/holaboss-ai/holaOS/tree/main/sdk/ui) but ships to npm as an independent package. Releases run through the shared `.github/workflows/publish-sdk.yml` workflow.

### One-time setup

GitHub repo → Settings → Environments → `npm-publish` → Environment secrets:
- `NPM_TOKEN` — npm Granular Access Token with read+write on `@holaboss/*`. Generate it at https://www.npmjs.com/settings/<user>/tokens.
- Optional: enable **Required reviewers** so each publish needs a human approval before the job continues.

### Per-release flow (tag-based, recommended)

```bash
# 1. Bump version
cd sdk/ui
# edit package.json: "version": "0.1.x" → "0.1.x+1"
# (or `npm version patch | minor | major` to bump + write back automatically)

# 2. Commit + push to whatever branch you're shipping from
cd ../..
git add sdk/ui/package.json
git commit -m "release(ui): bump @holaboss/ui to 0.1.x+1"
git push

# 3. Tag the just-pushed commit and push the tag
git tag @holaboss/ui@0.1.x+1
git push upstream @holaboss/ui@0.1.x+1
```

The tag pattern is a monorepo convention — Git tags are repo-wide, so the package name lives in the tag string. The `publish-sdk.yml` workflow filters on `@holaboss/ui@*` tag pushes and the validate job parses the package + version back out of the tag.

CI then runs:

```
validate (~5s)
  ├─ parse package=ui, version=0.1.x+1 from the tag
  └─ verify sdk/ui/package.json version matches the tag

test (~30s)
  └─ bun install + bun run test (tsc --noEmit)

build (~1min)
  ├─ bun run build (tsdown + Tailwind CLI emits dist/styles.css)
  ├─ verify every path in package.json `exports` exists in dist/
  └─ npm pack --dry-run (shows tarball contents)

publish (~10s, may pause for environment approval)
  └─ npm publish --access public --provenance
```

The `--provenance` flag uses GitHub Actions OIDC to attach a verifiable [npm provenance](https://docs.npmjs.com/generating-provenance-statements) statement — the npm page for this version will show a "Built and signed on GitHub Actions" badge linking back to the workflow run.

### Manual trigger (workflow_dispatch)

Use this when you want to dry-run a publish before tagging, or when the npm registry is misbehaving and you want to retry.

GitHub repo → Actions → **Publish SDK** → Run workflow:

| Input | Value |
|---|---|
| Package to publish | `ui` |
| Dry run | ☐ unchecked = real publish · ☑ checked = `npm pack --dry-run` only |

The dry-run path runs validate / test / build identically to a real release but skips the final `npm publish`. Use it before the first publish from a new branch or after a non-trivial config change.

### Local publish (escape hatch)

Use only when CI is unavailable. Provenance is **not** generated for local publishes (npm requires OIDC, which only works in a supported CI environment):

```bash
cd sdk/ui
npm publish --access public
# enter 2FA OTP when prompted
```

Local publishes won't be reflected as a Git tag; remember to tag + push afterwards so the CI history stays consistent.

### SemVer policy

| Change | Bump |
|---|---|
| New primitive / new layout / new optional prop | minor (`0.x.y` → `0.x+1.0`) |
| Token default tweak / style fix / bug fix | patch (`0.x.y` → `0.x.y+1`) |
| Removed prop / renamed export / removed primitive | major (`0.x.y` → `1.0.0`) |

Until `1.0.0`, `0.x` releases can carry breaking changes — but bump to a new minor when they do (`0.1.x` → `0.2.0`).

### Troubleshooting

- **`code EUSAGE: Automatic provenance generation not supported for provider: null`** — you're running `npm publish` locally with `publishConfig.provenance: true` set. Provenance only works in a supported CI environment. Either remove `provenance` from `publishConfig` (it's already removed in this package — CI passes `--provenance` as a CLI flag instead), or run `npm publish --provenance=false`.
- **`404 Not Found - PUT https://registry.npmjs.org/@holaboss/ui`** — the `@holaboss` scope doesn't exist on npm or your token lacks write access to it. Confirm at https://www.npmjs.com/settings/holaboss-ai/packages.
- **`403 Forbidden`** on first publish of a new package — scoped packages default to private. The first publish needs `--access public` (already in our `publishConfig` and the workflow's publish step).
- **Tag points at the wrong commit / wrong version** — delete and recreate:
  ```bash
  git tag -d @holaboss/ui@0.1.x
  git push upstream :refs/tags/@holaboss/ui@0.1.x
  # then re-tag the correct commit and push again
  ```
  If CI already published, you can't unpublish the same version on npm; bump and release a new patch instead.

## License

Apache-2.0. See [LICENSE](https://github.com/holaboss-ai/holaOS/blob/main/LICENSE).
