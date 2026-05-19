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

## Mount the tokens

At the root of your app (e.g. `routes/__root.tsx`):

```tsx
import "@holaboss/ui/tokens.css";
import "@holaboss/ui/themes/holaos.css";
```

Both stylesheets ship inside the npm package and are required — without them the CSS variables (`--background`, `--primary`, `--border`, `--radius`, etc.) fall back to defaults and every primitive renders wrong.

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

## License

Apache-2.0. See [LICENSE](https://github.com/holaboss-ai/holaOS/blob/main/LICENSE).
