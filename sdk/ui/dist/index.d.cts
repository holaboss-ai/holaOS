import * as _$class_variance_authority_types0 from "class-variance-authority/types";
import * as _$react_jsx_runtime0 from "react/jsx-runtime";
import * as React from "react";
import { ComponentProps, ReactNode } from "react";
import { VariantProps } from "class-variance-authority";
import { useRender } from "@base-ui/react/use-render";
import { Button as Button$1 } from "@base-ui/react/button";
import { Menu } from "@base-ui/react/menu";
import { LucideIcon } from "lucide-react";
import { Popover as Popover$1 } from "@base-ui/react/popover";
import { Select as Select$1 } from "@base-ui/react/select";
import { Switch as Switch$1 } from "@base-ui/react/switch";
import { Tabs as Tabs$1 } from "@base-ui/react/tabs";
import { Tooltip as Tooltip$1 } from "@base-ui/react/tooltip";
import { ClassValue } from "clsx";

//#region src/primitives/alert.d.ts
declare const alertVariants: (props?: ({
  variant?: "default" | "destructive" | null | undefined;
} & _$class_variance_authority_types0.ClassProp) | undefined) => string;
declare function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>): _$react_jsx_runtime0.JSX.Element;
declare function AlertTitle({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
declare function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
declare function AlertAction({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/badge.d.ts
declare const badgeVariants: (props?: ({
  variant?: "default" | "destructive" | "secondary" | "outline" | "ghost" | "link" | null | undefined;
} & _$class_variance_authority_types0.ClassProp) | undefined) => string;
declare function Badge({
  className,
  variant,
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>): React.ReactElement<unknown, string | React.JSXElementConstructor<any>>;
//#endregion
//#region src/primitives/button.d.ts
declare const buttonVariants: (props?: ({
  variant?: "default" | "destructive" | "secondary" | "outline" | "ghost" | "link" | "bordered" | null | undefined;
  size?: "default" | "sm" | "xs" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg" | null | undefined;
} & _$class_variance_authority_types0.ClassProp) | undefined) => string;
declare function Button({
  className,
  variant,
  size,
  ...props
}: Button$1.Props & VariantProps<typeof buttonVariants>): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/card.d.ts
declare function Card({
  className,
  size,
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm";
}): _$react_jsx_runtime0.JSX.Element;
declare function CardHeader({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
declare function CardTitle({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
declare function CardDescription({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
declare function CardAction({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
declare function CardContent({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
declare function CardFooter({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/dropdown-menu.d.ts
declare function DropdownMenu({
  ...props
}: Menu.Root.Props): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuPortal({
  ...props
}: Menu.Portal.Props): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuTrigger({
  ...props
}: Menu.Trigger.Props): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuContent({
  align,
  alignOffset,
  side,
  sideOffset,
  className,
  ...props
}: Menu.Popup.Props & Pick<Menu.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuGroup({
  ...props
}: Menu.Group.Props): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuLabel({
  className,
  inset,
  ...props
}: Menu.GroupLabel.Props & {
  inset?: boolean;
}): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuItem({
  className,
  inset,
  variant,
  ...props
}: Menu.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuSub({
  ...props
}: Menu.SubmenuRoot.Props): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: Menu.SubmenuTrigger.Props & {
  inset?: boolean;
}): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuSubContent({
  align,
  alignOffset,
  side,
  sideOffset,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: Menu.CheckboxItem.Props & {
  inset?: boolean;
}): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuRadioGroup({
  ...props
}: Menu.RadioGroup.Props): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: Menu.RadioItem.Props & {
  inset?: boolean;
}): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuSeparator({
  className,
  ...props
}: Menu.Separator.Props): _$react_jsx_runtime0.JSX.Element;
declare function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/empty-state.d.ts
/**
 * EmptyState — centered icon + title + optional description + optional
 * action. Replaces the multiple hand-rolled placeholder variants
 * scattered across panes (sidebar empties, dashboard "no rows",
 * automations "no schedules", etc.).
 *
 * Two visual presentations driven by `size`:
 *
 *  - `sm` (compact, default in dashboard panels) — small unframed icon
 *    at low opacity, `text-xs` copy. Good when the empty state shares
 *    a tight pane with chrome; was the original dashboard EmptyState.
 *
 *  - `md` (roomier, default for sidebar / list empties) — icon wrapped
 *    in a chip background, `text-sm` title + `text-xs` description.
 *    More presence for full-pane empties.
 *
 * Pass `action` to surface a CTA below the description.
 *
 * `minHeight` forces a min-height (used by chart panels so the panel
 * doesn't collapse when there's no data).
 */
interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  size?: "sm" | "md";
  /** Force min-height (px). Useful for chart cells that shouldn't collapse. */
  minHeight?: number;
  /**
   * Wrap the icon in a card-on-card chip framed by an Attio-style wide
   * hairline grid backdrop that fades to transparent at the outer
   * edges. Use for full-pane empties that need real presence
   * (Automations, primary list views). Default off so compact in-card
   * empties stay flat. Only applies when `size="md"`.
   */
  decorated?: boolean;
  /** Extra classes on the outer wrapper. */
  className?: string;
}
declare function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size,
  minHeight,
  decorated,
  className
}: EmptyStateProps): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/input.d.ts
declare function Input({
  className,
  type,
  ...props
}: React.ComponentProps<"input">): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/kbd.d.ts
/**
 * Kbd — keyboard shortcut hint. Inline `<kbd>` styled as a tiny pill.
 * Use in tooltip footers, menu trailing slots, and help text to teach
 * keyboard grammar continuously.
 *
 * Single-key glyphs (⌘, ⇧, ↑, K) auto-center via the square sizing.
 * For multi-key sequences, render multiple <Kbd> with a separator:
 *   <Kbd>⌘</Kbd><Kbd>K</Kbd>
 */
declare const kbdVariants: (props?: ({
  size?: "sm" | "md" | null | undefined;
} & _$class_variance_authority_types0.ClassProp) | undefined) => string;
type KbdProps = ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>;
declare function Kbd({
  className,
  size,
  ...props
}: KbdProps): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/label.d.ts
declare function Label({
  className,
  ...props
}: React.ComponentProps<"label">): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/popover.d.ts
declare function Popover({
  ...props
}: Popover$1.Root.Props): _$react_jsx_runtime0.JSX.Element;
declare function PopoverTrigger({
  ...props
}: Popover$1.Trigger.Props): _$react_jsx_runtime0.JSX.Element;
declare function PopoverContent({
  className,
  positionerClassName,
  align,
  alignOffset,
  side,
  sideOffset,
  ...props
}: Popover$1.Popup.Props & Pick<Popover$1.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> & {
  /** Override classes on the Positioner — needed when stacking above
      portals that already sit at high z-index (e.g. the workspace
      switcher pop-out at z-[80]). */
  positionerClassName?: string;
}): _$react_jsx_runtime0.JSX.Element;
declare function PopoverHeader({
  className,
  ...props
}: React.ComponentProps<"div">): _$react_jsx_runtime0.JSX.Element;
declare function PopoverTitle({
  className,
  ...props
}: Popover$1.Title.Props): _$react_jsx_runtime0.JSX.Element;
declare function PopoverDescription({
  className,
  ...props
}: Popover$1.Description.Props): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/select.d.ts
declare const Select: typeof Select$1.Root;
declare function SelectGroup({
  className,
  ...props
}: Select$1.Group.Props): _$react_jsx_runtime0.JSX.Element;
declare function SelectValue({
  className,
  ...props
}: Select$1.Value.Props): _$react_jsx_runtime0.JSX.Element;
declare function SelectTrigger({
  className,
  size,
  children,
  ...props
}: Select$1.Trigger.Props & {
  size?: "sm" | "default";
}): _$react_jsx_runtime0.JSX.Element;
declare function SelectContent({
  className,
  children,
  side,
  sideOffset,
  align,
  alignOffset,
  alignItemWithTrigger,
  ...props
}: Select$1.Popup.Props & Pick<Select$1.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger">): _$react_jsx_runtime0.JSX.Element;
declare function SelectLabel({
  className,
  ...props
}: Select$1.GroupLabel.Props): _$react_jsx_runtime0.JSX.Element;
declare function SelectItem({
  className,
  children,
  ...props
}: Select$1.Item.Props): _$react_jsx_runtime0.JSX.Element;
declare function SelectSeparator({
  className,
  ...props
}: Select$1.Separator.Props): _$react_jsx_runtime0.JSX.Element;
declare function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof Select$1.ScrollUpArrow>): _$react_jsx_runtime0.JSX.Element;
declare function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof Select$1.ScrollDownArrow>): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/status-dot.d.ts
/**
 * StatusDot — small colored dot signalling a state (running, error,
 * working, idle, etc.). Replaces ~18 hand-rolled
 * `<span className="size-X rounded-full bg-X" />` instances across the
 * shell so a single change here propagates everywhere.
 *
 * Default size = `sm` (6px) which matches the dominant existing usage
 * (status pip alongside text). Use `md` (8px) for slightly more
 * presence (sidebar entry status), `lg` (10px) for stand-alone
 * notification-style indicators.
 *
 * `withRing` adds a card-colored ring — used for badge dots that sit on
 * top of an icon and need to read against the underlying surface.
 */
declare const statusDotVariants: (props?: ({
  variant?: "destructive" | "success" | "warning" | "info" | "primary" | "muted" | "neutral" | null | undefined;
  size?: "sm" | "md" | "lg" | null | undefined;
  withRing?: boolean | null | undefined;
  pulse?: boolean | null | undefined;
} & _$class_variance_authority_types0.ClassProp) | undefined) => string;
type StatusDotProps = useRender.ComponentProps<"span"> & VariantProps<typeof statusDotVariants>;
declare function StatusDot({
  className,
  variant,
  size,
  withRing,
  pulse,
  render,
  ...props
}: StatusDotProps): React.ReactElement<unknown, string | React.JSXElementConstructor<any>>;
//#endregion
//#region src/primitives/switch.d.ts
declare function Switch({
  className,
  ...props
}: Switch$1.Root.Props): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/tabs.d.ts
declare function Tabs({
  className,
  orientation,
  ...props
}: Tabs$1.Root.Props): _$react_jsx_runtime0.JSX.Element;
declare const tabsListVariants: (props?: ({
  variant?: "default" | "line" | null | undefined;
} & _$class_variance_authority_types0.ClassProp) | undefined) => string;
declare function TabsList({
  className,
  variant,
  ...props
}: Tabs$1.List.Props & VariantProps<typeof tabsListVariants>): _$react_jsx_runtime0.JSX.Element;
declare function TabsTrigger({
  className,
  ...props
}: Tabs$1.Tab.Props): _$react_jsx_runtime0.JSX.Element;
declare function TabsContent({
  className,
  ...props
}: Tabs$1.Panel.Props): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/primitives/tooltip.d.ts
declare function TooltipProvider({
  delay,
  ...props
}: Tooltip$1.Provider.Props): _$react_jsx_runtime0.JSX.Element;
declare function Tooltip({
  ...props
}: Tooltip$1.Root.Props): _$react_jsx_runtime0.JSX.Element;
declare function TooltipTrigger({
  ...props
}: Tooltip$1.Trigger.Props): _$react_jsx_runtime0.JSX.Element;
declare function TooltipContent({
  className,
  side,
  sideOffset,
  align,
  alignOffset,
  children,
  ...props
}: Tooltip$1.Popup.Props & Pick<Tooltip$1.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/layouts/dashboard-shell.d.ts
/**
 * Canonical chrome for a workspace-pane dashboard. Two slots: a top bar
 * (header, actions) and a scrollable content region underneath. Apps
 * should wrap their dashboard root with this so density, padding, and
 * scroll behavior stay consistent across the workspace.
 *
 * The shell does not manage its own width; it fills its parent (the
 * pane). Vertical scroll lives on `content` so the header stays pinned.
 */
interface DashboardShellProps {
  /** Sticky top region. Typically a `<PageHeader>`. */
  header?: ReactNode;
  /** Main scrollable content. */
  children: ReactNode;
  /** Extra class on the outer flex container. */
  className?: string;
  /** Extra class on the scrollable content region. */
  contentClassName?: string;
}
declare function DashboardShell({
  header,
  children,
  className,
  contentClassName
}: DashboardShellProps): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/layouts/data-table.d.ts
interface DataTableColumn<Row> {
  /** Column key — must be unique within a table. */
  id: string;
  /** Header label. */
  header: ReactNode;
  /** Cell content; receives the full row. */
  cell: (row: Row) => ReactNode;
  /**
   * Cell alignment. `right` for numeric / monetary columns; `center`
   * for icons / status badges.
   */
  align?: "left" | "right" | "center";
  /** Hide on small viewports (< sm). */
  hideOnSmall?: boolean;
  /** Width hint in CSS units (e.g. `120px`, `20%`). */
  width?: string;
}
interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  /** Stable key per row. */
  rowKey: (row: Row) => string;
  /** Per-row click handler. Renders rows with hover affordance. */
  onRowClick?: (row: Row) => void;
  /** When true, body is replaced with a <LoadingState>. */
  isLoading?: boolean;
  /** Empty-state title (shown when not loading and rows is empty). */
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  className?: string;
}
declare function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  isLoading,
  emptyTitle,
  emptyDescription,
  className
}: DataTableProps<Row>): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/layouts/error-state.d.ts
/**
 * Centered error display with an optional retry action. Use for the
 * body of a pane when data fetch / mutation fails. Title is short, the
 * `detail` is the developer-relevant message (truncate-friendly).
 */
interface ErrorStateProps {
  title?: string;
  /** Concrete error description — the API error text, etc. */
  detail?: ReactNode;
  /** Click handler for the retry button. Omit to skip the button. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}
declare function ErrorState({
  title,
  detail,
  onRetry,
  retryLabel,
  className
}: ErrorStateProps): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/layouts/filter-bar.d.ts
/**
 * Search input + filter chip slot + right-aligned actions. Sits at the
 * top of a list / table to provide a consistent control row across
 * apps.
 */
interface FilterBarProps {
  /** Search input value (controlled). */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Filter chips / selects / segmented controls. */
  filters?: ReactNode;
  /** Right-aligned actions (e.g. "New", "Refresh"). */
  actions?: ReactNode;
  className?: string;
}
declare function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder,
  filters,
  actions,
  className
}: FilterBarProps): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/layouts/loading-state.d.ts
/**
 * Skeleton-style loading placeholder. Use for the body of a pane while
 * data is fetching. The default presentation is a vertical stack of
 * pulsing bars; `variant="list"` mimics a row list and `variant="card"`
 * mimics card-grid loading.
 *
 * Solid backgrounds + subtle pulse only. No shimmer gradients.
 */
interface LoadingStateProps {
  variant?: "rows" | "list" | "card";
  /** How many placeholder elements to render. Default 4. */
  count?: number;
  className?: string;
}
declare function LoadingState({
  variant,
  count,
  className
}: LoadingStateProps): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/layouts/page-header.d.ts
/**
 * Title + optional subtitle + optional right-aligned actions. The
 * canonical first child of `<DashboardShell header={...}>`. Density and
 * weight stay consistent regardless of which app drops it in.
 */
interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned action slot (typically buttons). */
  actions?: ReactNode;
  className?: string;
}
declare function PageHeader({
  title,
  description,
  actions,
  className
}: PageHeaderProps): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/layouts/section.d.ts
/**
 * Title + optional description over a content block. Use to group
 * related controls or stats inside a pane.
 */
interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned action slot next to the title. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}
declare function Section({
  title,
  description,
  actions,
  children,
  className,
  contentClassName
}: SectionProps): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/layouts/stat-pill.d.ts
/**
 * Small metric display — label on top, value below, optional icon and
 * trend chip. Use in a grid at the top of a dashboard. Stays tight; no
 * shadows or gradients.
 */
interface StatPillProps {
  label: ReactNode;
  value: ReactNode;
  icon?: LucideIcon;
  /** Optional trend / hint chip rendered next to the value. */
  trend?: ReactNode;
  /** Visual tone for the value. Default `neutral` (foreground). */
  tone?: "neutral" | "positive" | "negative";
  className?: string;
}
declare function StatPill({
  label,
  value,
  icon: Icon,
  trend,
  tone,
  className
}: StatPillProps): _$react_jsx_runtime0.JSX.Element;
//#endregion
//#region src/lib/utils.d.ts
declare function cn(...inputs: ClassValue[]): string;
//#endregion
export { Alert, AlertAction, AlertDescription, AlertTitle, Badge, Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, DashboardShell, type DashboardShellProps, DataTable, type DataTableColumn, type DataTableProps, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, EmptyState, type EmptyStateProps, ErrorState, type ErrorStateProps, FilterBar, type FilterBarProps, Input, Kbd, Label, LoadingState, type LoadingStateProps, PageHeader, type PageHeaderProps, Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger, Section, type SectionProps, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectScrollDownButton, SelectScrollUpButton, SelectSeparator, SelectTrigger, SelectValue, StatPill, type StatPillProps, StatusDot, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, badgeVariants, buttonVariants, cn, tabsListVariants };
//# sourceMappingURL=index.d.cts.map