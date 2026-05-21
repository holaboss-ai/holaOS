// =====================================================================
// Primitives — holaOS-locked shadcn-style components. Drop these in
// instead of redefining your own; they are guaranteed to match the
// workspace canvas (tokens, density, hover affordances).
// =====================================================================

export { Alert, AlertTitle, AlertDescription, AlertAction } from "./primitives/alert.js";
export { Badge, badgeVariants } from "./primitives/badge.js";
export { Button, buttonVariants } from "./primitives/button.js";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from "./primitives/card.js";
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./primitives/dropdown-menu.js";
export { EmptyState } from "./primitives/empty-state.js";
export type { EmptyStateProps } from "./primitives/empty-state.js";
export { Input } from "./primitives/input.js";
export { Kbd } from "./primitives/kbd.js";
export { Label } from "./primitives/label.js";
export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./primitives/popover.js";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./primitives/select.js";
export { StatusDot } from "./primitives/status-dot.js";
export { Switch } from "./primitives/switch.js";
export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  tabsListVariants,
} from "./primitives/tabs.js";
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./primitives/tooltip.js";

// =====================================================================
// Layouts — composition primitives. Use these for page chrome,
// loading / empty / error states, and dashboard structure. The
// majority of visual drift between agent-built apps happens at this
// layer, so reach for these before hand-rolling a similar layout.
// =====================================================================

export { DashboardShell } from "./layouts/dashboard-shell.js";
export type { DashboardShellProps } from "./layouts/dashboard-shell.js";
export { DataTable } from "./layouts/data-table.js";
export type {
  DataTableColumn,
  DataTableProps,
} from "./layouts/data-table.js";
export { ErrorState } from "./layouts/error-state.js";
export type { ErrorStateProps } from "./layouts/error-state.js";
export { FilterBar } from "./layouts/filter-bar.js";
export type { FilterBarProps } from "./layouts/filter-bar.js";
export { LoadingState } from "./layouts/loading-state.js";
export type { LoadingStateProps } from "./layouts/loading-state.js";
export { PageHeader } from "./layouts/page-header.js";
export type { PageHeaderProps } from "./layouts/page-header.js";
export { Section } from "./layouts/section.js";
export type { SectionProps } from "./layouts/section.js";
export { StatPill } from "./layouts/stat-pill.js";
export type { StatPillProps } from "./layouts/stat-pill.js";

// =====================================================================
// Utilities
// =====================================================================

export { cn } from "./lib/utils.js";
