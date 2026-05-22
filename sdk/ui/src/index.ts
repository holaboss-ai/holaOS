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

// ---------------------------------------------------------------------
// Expanded primitive coverage — full shadcn (base-ui) catalog. The bare
// `export *` keeps the per-component named export list canonical with
// the source file, so adding a sub-component upstream lands here for
// free. ScrollArea is intentionally omitted in favour of native
// `overflow-y-auto` per design policy.
// ---------------------------------------------------------------------

export * from "./primitives/accordion.js";
export * from "./primitives/alert-dialog.js";
export * from "./primitives/aspect-ratio.js";
export * from "./primitives/avatar.js";
export * from "./primitives/breadcrumb.js";
export * from "./primitives/button-group.js";
export * from "./primitives/calendar.js";
export * from "./primitives/carousel.js";
export * from "./primitives/chart.js";
export * from "./primitives/checkbox.js";
export * from "./primitives/collapsible.js";
export * from "./primitives/combobox.js";
export * from "./primitives/command.js";
export * from "./primitives/context-menu.js";
export * from "./primitives/dialog.js";
export * from "./primitives/direction.js";
export * from "./primitives/drawer.js";
export * from "./primitives/field.js";
export * from "./primitives/hover-card.js";
export * from "./primitives/input-group.js";
export * from "./primitives/input-otp.js";
export * from "./primitives/item.js";
export * from "./primitives/menubar.js";
export * from "./primitives/native-select.js";
export * from "./primitives/navigation-menu.js";
export * from "./primitives/pagination.js";
export * from "./primitives/progress.js";
export * from "./primitives/radio-group.js";
export * from "./primitives/resizable.js";
export * from "./primitives/separator.js";
export * from "./primitives/sheet.js";
export * from "./primitives/sidebar.js";
export * from "./primitives/skeleton.js";
export * from "./primitives/slider.js";
export * from "./primitives/sonner.js";
export * from "./primitives/spinner.js";
export * from "./primitives/table.js";
export * from "./primitives/textarea.js";
export * from "./primitives/toggle-group.js";
export * from "./primitives/toggle.js";

// =====================================================================
// Utilities
// =====================================================================

export { cn } from "./lib/utils.js";
