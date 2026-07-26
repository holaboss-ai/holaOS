# Marketplace UI Design Spec

## Context

The desktop app currently has a minimal workspace creation experience: a form with 4 radio-button source options (Local, Marketplace dropdown, Empty, Empty + Onboarding). Users who want to browse marketplace templates see only a dropdown picker — no descriptions, no previews, no discovery. This makes the first-time experience feel flat and doesn't showcase what Holaboss can do.

**Goal**: Add a dedicated marketplace gallery with kit cards and detail views. It should be the primary experience for new users (onboarding) and also accessible as a left rail pane for browsing anytime.

**Non-goals**: Apps and Skills tabs (already have their own panes). Community submissions UI. Search/filter beyond client-side name matching.

## Architecture Overview

```
MarketplaceGallery (shared)
├── mode="pick" → FirstWorkspacePane (onboarding, no workspaces)
└── mode="browse" → MarketplacePane (left rail, with workspaces)

KitCard (reusable card)
KitDetail (reusable detail view)
```

Both contexts use the same data source: `useWorkspaceDesktop()` context, which already manages `marketplaceTemplates`, `selectedMarketplaceTemplate`, loading, and auth state.

## Components

### 1. `KitCard` — `desktop/src/components/marketplace/KitCard.tsx`

Renders a single kit as a clickable card.

**Props:**
```typescript
interface KitCardProps {
  template: TemplateMetadataPayload;
  onClick: (template: TemplateMetadataPayload) => void;
  selected?: boolean;
}
```

**Layout:**
- 3D emoji icon (40px, from Fluent CDN via `emoji` field, fallback to `icon`)
- Kit name (14px semibold)
- Short description (12px muted, 2-line clamp)
- Install count (10px dim)
- Coming-soon badge + reduced opacity when `is_coming_soon`

**Styling:** Follow existing desktop patterns — `theme-subtle-surface`, `border-panel-border/40`, `rounded-[18px]`, hover: `bg-[var(--theme-hover-bg)]`. No gradient backgrounds and no hover shadows.

### 2. `KitDetail` — `desktop/src/components/marketplace/KitDetail.tsx`

Expanded view of a single kit with all metadata.

**Props:**
```typescript
interface KitDetailProps {
  template: TemplateMetadataPayload;
  onBack: () => void;
  onSelect: (template: TemplateMetadataPayload) => void;
  selectLabel?: string; // default: "Use this kit"
  selectDisabled?: boolean; // e.g. when not authenticated
  selectDisabledReason?: string; // e.g. "Sign in required"
}
```

**Layout (top to bottom):**
1. Back button (`← Back to kits`)
2. Header: emoji (36px) + name (22px semibold) + description (13px muted) + badges (official/community, install count)
3. Included Apps section: pill list of `template.apps[]` names
4. Agents section: each `template.agents[]` with role + description
5. Views section (if any): list of `template.views[]`
6. CTA button: "Use this kit →" (holaboss brand accent)

### 3. `MarketplaceGallery` — `desktop/src/components/marketplace/MarketplaceGallery.tsx`

Grid of kit cards with optional header and search.

**Props:**
```typescript
interface MarketplaceGalleryProps {
  mode: "browse" | "pick";
  templates: TemplateMetadataPayload[];
  isLoading: boolean;
  error?: string;
  onSelectKit: (template: TemplateMetadataPayload) => void;
  // "pick" mode extras
  onStartFromScratch?: () => void;
  onUseLocalTemplate?: () => void;
}
```

**Layout:**
- Header: "Pick a kit to get started" (pick mode) or "Explore kits" (browse mode)
- Search input (client-side filter on name/description/tags)
- Grid: responsive, 2 cols on narrow, 3 cols on wide
- Loading state: 4 skeleton cards with pulse animation
- Error state: message + retry button
- Empty state: "No kits match your search"
- Footer (pick mode only): "Start from scratch" | "Use local template" links

### 4. `MarketplacePane` — `desktop/src/components/panes/MarketplacePane.tsx`

PaneCard wrapper for left rail browsing.

**Local state:**
```typescript
view: "gallery" | "detail"
detailKit: TemplateMetadataPayload | null
```

**Behavior:**
- gallery view: `<MarketplaceGallery mode="browse" onSelectKit={showDetail} />`
- detail view: `<KitDetail template={detailKit} onBack={backToGallery} onSelect={handleUseKit} />`
- `handleUseKit`: sets `selectedMarketplaceTemplate` in context, sets `templateSourceMode` to "marketplace", triggers `createWorkspace()` flow, or opens the create-workspace section in TopTabsBar

### 5. Modified `FirstWorkspacePane` — `desktop/src/components/layout/AppShell.tsx`

Replace current 4-option source selector with a stepped flow.

**Local state:**
```typescript
step: "gallery" | "detail" | "configure"
detailKit: TemplateMetadataPayload | null
```

**Step 1 — Gallery:**
`<MarketplaceGallery mode="pick" onSelectKit={showDetail} onStartFromScratch={...} onUseLocalTemplate={...} />`

**Step 2 — Detail:**
`<KitDetail template={detailKit} onBack={backToGallery} onSelect={goToConfigure} />`

**Step 3 — Configure:**
Compact form with:
- Selected kit summary card (emoji + name, "Change" link back to gallery)
- Workspace name input
- Harness selector
- "Create workspace" button
- This reuses the existing right-panel config UI from the current FirstWorkspacePane

**Secondary flows:**
- "Start from scratch" → jumps to step 3 with `templateSourceMode = "empty"` (or "empty_onboarding")
- "Use local template" → jumps to step 3 with `templateSourceMode = "local"` and triggers `chooseTemplateFolder()`

## Data Flow

```
FirstWorkspacePane / MarketplacePane
  ↓ reads
useWorkspaceDesktop() context
  ↓ provides
marketplaceTemplates (TemplateMetadataPayload[])
  ↓ fetched via
window.electronAPI.workspace.listMarketplaceTemplates()
  ↓ calls
Electron main process → marketplace API
  ↓ returns
{ templates: TemplateMetadataPayload[], spotlight: SpotlightItem[] }
```

**No new API endpoints needed.** All data comes from the existing `listMarketplaceTemplates()` electronAPI method. The `TemplateMetadataPayload` type already includes all fields needed for cards and detail views (name, description, emoji, apps, agents, views, tags, category, install_count, source, verified, is_coming_soon, is_hidden).

## Navigation Changes

**`LeftRailItem` type** — add `"marketplace"`:
```typescript
type LeftRailItem = "space" | "automations" | "skills" | "integrations" | "marketplace" | "app";
```

**`LeftNavigationRail`** — add marketplace button in PRIMARY_ITEMS:
- Icon: `LayoutGrid` from lucide-react (or `Store`)
- Position: after Integrations, before installed apps section
- Tooltip: "Marketplace"

**`AppShellContent`** — add rendering branch:
```typescript
if (activeLeftRailItem === "marketplace") {
  return <MarketplacePane />;
}
```

## Error & Edge Cases

| Scenario | Behavior |
|----------|----------|
| Not authenticated | Gallery visible, "Use this kit" disabled with "Sign in required" message |
| Loading | 4 skeleton cards with pulse animation |
| API error | "Could not load templates" + retry button |
| Empty list | "No kits available yet" message |
| Coming soon kits | Shown with 50% opacity, not clickable |
| Hidden kits | Filtered out (is_hidden === true) |
| Search with no results | "No kits match your search" |

## Files to Create

- `desktop/src/components/marketplace/KitCard.tsx`
- `desktop/src/components/marketplace/KitDetail.tsx`
- `desktop/src/components/marketplace/MarketplaceGallery.tsx`
- `desktop/src/components/panes/MarketplacePane.tsx`

## Files to Modify

- `desktop/src/components/layout/AppShell.tsx` — modify `FirstWorkspacePane`, add marketplace branch in `AppShellContent`, update `LeftRailItem` type
- `desktop/src/components/layout/LeftNavigationRail.tsx` — add marketplace button

## Verification

1. **New user flow**: Launch app with no workspaces → see kit gallery → click kit → see detail → "Use this kit" → config form → create workspace → provisioning
2. **Left rail pane**: With existing workspaces → click marketplace icon → browse kits → click kit → detail → "Use this kit" → workspace created
3. **Secondary flows**: "Start from scratch" → config form with empty template; "Use local template" → folder picker → config form
4. **Auth gate**: Without auth, gallery loads but "Use this kit" is disabled
5. **Loading/error**: Disconnect network → see error state; slow load → see skeleton cards
