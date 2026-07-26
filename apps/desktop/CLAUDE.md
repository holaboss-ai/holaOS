# Desktop (Electron App)

## Icons — always go through `components/ui/icons.tsx`

Every icon in the renderer is rendered through
`@hugeicons/core-free-icons` via the central wrappers in
`apps/desktop/src/components/ui/icons.tsx`. Feature code keeps the
lucide-style call shape (`<Home className="size-3.5" />`) — only the
import source changes.

**Rules:**

- Import from `@/components/ui/icons`. **Never** import from
  `lucide-react` (the package is removed) and **never** reach into
  `@hugeicons/core-free-icons` directly from feature files.
- Need an icon that isn't exported yet? Add the wrapper to
  `ui/icons.tsx` using the project's `makeIcon(SomeHugeicon)` helper,
  then import the wrapper. Keeping the vocabulary in one file is
  what lets future icon swaps stay a one-file edit.
- **Sidebar & nav-chrome icons use the FILLED variants** — solid glyphs
  read as recessed chrome and stay legible at rail size (outline strokes
  get thin and muddy there). Filled icons are made from `reicon-react`
  (reicon.dev) via `makeFilledIcon(...)` and named `*Filled` (`HomeFilled`,
  `FolderFilled`, `SettingsFilled`, `GridFilled`, `GlobeFilled`,
  `BuildingFilled`, …). Reserve the outline HugeIcons (`makeIcon`) for
  content / inline use. Need a filled icon that isn't exported yet? Import
  the reicon-react glyph as `Foo as FooFilled_re` and add
  `export const FooFilled = makeFilledIcon(FooFilled_re)` — never reach into
  `reicon-react` from feature files.
- Use `IconType` (exported from `ui/icons.tsx`) for type slots that
  expect "an icon component" — it's the project's stand-in for
  lucide's `LucideIcon`.
- Default `strokeWidth` is `1.75`. The sidebar nav rail rebinds to
  `2` locally for nav-rail presence. Per-call `strokeWidth` always
  wins.
- For "more / overflow" affordances, the project icon is the plain
  `MoreHorizontal` (`MoreHorizontalIcon` underneath — three dots, no
  surrounding circle).

## Marketplace

The `Marketplace` overlay only lists **workspace templates**. The earlier
`Marketplace → Apps` sub-tab and its tarball-install flow are retired:
apps now ship with workspace templates (see `LOCAL_TEMPLATE_APP_BINDINGS`
in `electron/main.ts`) or via backend provisioning — not via the
sidebar/marketplace UI. The runtime's `/api/v1/apps/install-archive`
endpoint still exists for legacy / programmatic flows but no desktop UI
calls it.

## Server data fetching (Remote API)

Standard for runtime/server data in the renderer:

- **Request/response runtime data** (reads + writes through the Remote API) →
  **TanStack Query** via `@/lib/remoteApiQuery` (`remoteApiQuery.<domain>.<op>
  .queryOptions(...)` / `.mutationOptions(...)`). These come from the oRPC
  contract client (`@/lib/remoteApiClient`), so options + query keys are
  end-to-end typed and consistent. The `QueryClientProvider` is already mounted
  in `App.tsx`.
- **UI / selection state** (which file/node is open, view mode, expanded paths)
  → `useState` / Jotai.
- **Event-pushed state** (e.g. `runtime:state`) → preload subscriptions / Jotai,
  not Query.

Invalidate related queries after a mutation, e.g.
`queryClient.invalidateQueries({ queryKey: remoteApiQuery.memory.key() })`.

Panes migrate to this pattern opportunistically — don't batch-convert. When
converting a pane whose imperative loads are intertwined (e.g. one read keyed by
two selection sources), verify the result by running the desktop, not just
typecheck — the brittle source-snapshot tests don't cover data-flow behavior.
