Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#endregion
require("react");
let class_variance_authority = require("class-variance-authority");
let clsx = require("clsx");
let tailwind_merge = require("tailwind-merge");
let react_jsx_runtime = require("react/jsx-runtime");
let _base_ui_react_merge_props = require("@base-ui/react/merge-props");
let _base_ui_react_use_render = require("@base-ui/react/use-render");
let _base_ui_react_button = require("@base-ui/react/button");
let _base_ui_react_menu = require("@base-ui/react/menu");
let lucide_react = require("lucide-react");
let _base_ui_react_input = require("@base-ui/react/input");
let _base_ui_react_popover = require("@base-ui/react/popover");
let _base_ui_react_select = require("@base-ui/react/select");
let _base_ui_react_switch = require("@base-ui/react/switch");
let _base_ui_react_tabs = require("@base-ui/react/tabs");
let _base_ui_react_tooltip = require("@base-ui/react/tooltip");
//#region src/lib/utils.ts
function cn(...inputs) {
	return (0, tailwind_merge.twMerge)((0, clsx.clsx)(inputs));
}
//#endregion
//#region src/primitives/alert.tsx
const alertVariants = (0, class_variance_authority.cva)("group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4", {
	variants: { variant: {
		default: "bg-card text-card-foreground",
		destructive: "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current"
	} },
	defaultVariants: { variant: "default" }
});
function Alert({ className, variant, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "alert",
		role: "alert",
		className: cn(alertVariants({ variant }), className),
		...props
	});
}
function AlertTitle({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "alert-title",
		className: cn("font-heading font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground", className),
		...props
	});
}
function AlertDescription({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "alert-description",
		className: cn("text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4", className),
		...props
	});
}
function AlertAction({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "alert-action",
		className: cn("absolute top-2 right-2", className),
		...props
	});
}
//#endregion
//#region src/primitives/badge.tsx
const badgeVariants = (0, class_variance_authority.cva)("group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!", {
	variants: { variant: {
		default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
		secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
		destructive: "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
		outline: "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
		ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted",
		link: "text-primary underline-offset-4 hover:underline"
	} },
	defaultVariants: { variant: "default" }
});
function Badge({ className, variant = "default", render, ...props }) {
	return (0, _base_ui_react_use_render.useRender)({
		defaultTagName: "span",
		props: (0, _base_ui_react_merge_props.mergeProps)({ className: cn(badgeVariants({ variant }), className) }, props),
		render,
		state: {
			slot: "badge",
			variant
		}
	});
}
//#endregion
//#region src/primitives/button.tsx
const buttonVariants = (0, class_variance_authority.cva)("group/button inline-flex shrink-0 items-center justify-center rounded-lg text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", {
	variants: {
		variant: {
			default: "bg-primary text-primary-foreground hover:bg-primary/90 [a]:hover:bg-primary/90",
			bordered: "border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
			outline: "border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
			secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
			ghost: "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted",
			destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
			link: "text-primary underline-offset-4 hover:underline"
		},
		size: {
			default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
			xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
			sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
			lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
			icon: "size-8",
			"icon-xs": "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
			"icon-sm": "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
			"icon-lg": "size-9"
		}
	},
	defaultVariants: {
		variant: "default",
		size: "default"
	}
});
function Button({ className, variant = "default", size = "default", ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_button.Button, {
		"data-slot": "button",
		className: cn(buttonVariants({
			variant,
			size,
			className
		})),
		...props
	});
}
//#endregion
//#region src/primitives/card.tsx
function Card({ className, size = "default", ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "card",
		"data-size": size,
		className: cn("group/card flex flex-col gap-4 overflow-hidden rounded-xl bg-card py-4 text-sm text-card-foreground shadow-sm has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl", className),
		...props
	});
}
function CardHeader({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "card-header",
		className: cn("group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3", className),
		...props
	});
}
function CardTitle({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "card-title",
		className: cn("font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm", className),
		...props
	});
}
function CardDescription({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "card-description",
		className: cn("text-sm text-muted-foreground", className),
		...props
	});
}
function CardAction({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "card-action",
		className: cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className),
		...props
	});
}
function CardContent({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "card-content",
		className: cn("px-4 group-data-[size=sm]/card:px-3", className),
		...props
	});
}
function CardFooter({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-slot": "card-footer",
		className: cn("flex items-center rounded-b-xl border-t bg-muted p-4 group-data-[size=sm]/card:p-3", className),
		...props
	});
}
//#endregion
//#region src/primitives/dropdown-menu.tsx
function DropdownMenu({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.Root, {
		"data-slot": "dropdown-menu",
		...props
	});
}
function DropdownMenuPortal({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.Portal, {
		"data-slot": "dropdown-menu-portal",
		...props
	});
}
function DropdownMenuTrigger({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.Trigger, {
		"data-slot": "dropdown-menu-trigger",
		...props
	});
}
function DropdownMenuContent({ align = "start", alignOffset = 0, side = "bottom", sideOffset = 4, className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.Portal, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.Positioner, {
		className: "isolate z-50 outline-none",
		align,
		alignOffset,
		side,
		sideOffset,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.Popup, {
			"data-slot": "dropdown-menu-content",
			className: cn("dark z-50 max-h-(--available-height) w-(--anchor-width) min-w-44 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg p-1 text-popover-foreground shadow-md ring-1 ring-border duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95 animate-none! relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 **:data-[slot$=-item]:not-data-[variant=destructive]:focus:bg-foreground/10 **:data-[slot$=-item]:not-data-[variant=destructive]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-fg-5 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10!", className),
			...props
		})
	}) });
}
function DropdownMenuGroup({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.Group, {
		"data-slot": "dropdown-menu-group",
		...props
	});
}
function DropdownMenuLabel({ className, inset, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.GroupLabel, {
		"data-slot": "dropdown-menu-label",
		"data-inset": inset,
		className: cn("px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7", className),
		...props
	});
}
function DropdownMenuItem({ className, inset, variant = "default", ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.Item, {
		"data-slot": "dropdown-menu-item",
		"data-inset": inset,
		"data-variant": variant,
		className: cn("group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-2.5 py-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive", className),
		...props
	});
}
function DropdownMenuSub({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.SubmenuRoot, {
		"data-slot": "dropdown-menu-sub",
		...props
	});
}
function DropdownMenuSubTrigger({ className, inset, children, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_base_ui_react_menu.Menu.SubmenuTrigger, {
		"data-slot": "dropdown-menu-sub-trigger",
		"data-inset": inset,
		className: cn("flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", className),
		...props,
		children: [children, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(lucide_react.ChevronRightIcon, { className: "ml-auto" })]
	});
}
function DropdownMenuSubContent({ align = "start", alignOffset = -3, side = "right", sideOffset = 0, className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DropdownMenuContent, {
		"data-slot": "dropdown-menu-sub-content",
		className: cn("dark w-auto min-w-[96px] rounded-lg p-1 text-popover-foreground shadow-lg ring-1 ring-border duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 animate-none! relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 **:data-[slot$=-item]:not-data-[variant=destructive]:focus:bg-foreground/10 **:data-[slot$=-item]:not-data-[variant=destructive]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-fg-5 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10!", className),
		align,
		alignOffset,
		side,
		sideOffset,
		...props
	});
}
function DropdownMenuCheckboxItem({ className, children, checked, inset, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_base_ui_react_menu.Menu.CheckboxItem, {
		"data-slot": "dropdown-menu-checkbox-item",
		"data-inset": inset,
		className: cn("relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", className),
		checked,
		...props,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "pointer-events-none absolute right-2 flex items-center justify-center",
			"data-slot": "dropdown-menu-checkbox-item-indicator",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.CheckboxItemIndicator, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(lucide_react.CheckIcon, {}) })
		}), children]
	});
}
function DropdownMenuRadioGroup({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.RadioGroup, {
		"data-slot": "dropdown-menu-radio-group",
		...props
	});
}
function DropdownMenuRadioItem({ className, children, inset, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_base_ui_react_menu.Menu.RadioItem, {
		"data-slot": "dropdown-menu-radio-item",
		"data-inset": inset,
		className: cn("relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", className),
		...props,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "pointer-events-none absolute right-2 flex items-center justify-center",
			"data-slot": "dropdown-menu-radio-item-indicator",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.RadioItemIndicator, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(lucide_react.CheckIcon, {}) })
		}), children]
	});
}
function DropdownMenuSeparator({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_menu.Menu.Separator, {
		"data-slot": "dropdown-menu-separator",
		className: cn("-mx-1 my-1 h-px bg-border", className),
		...props
	});
}
function DropdownMenuShortcut({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		"data-slot": "dropdown-menu-shortcut",
		className: cn("ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground", className),
		...props
	});
}
//#endregion
//#region src/primitives/empty-state.tsx
function EmptyState({ icon: Icon, title, description, action, size = "sm", minHeight, decorated = false, className }) {
	const isMd = size === "md";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: cn("flex flex-col items-center justify-center text-center", isMd ? "gap-3 px-4 py-14" : "gap-2 py-10 text-muted-foreground", className),
		style: minHeight ? { minHeight } : void 0,
		children: [
			Icon ? isMd ? decorated ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "relative flex h-24 w-72 items-center justify-center overflow-hidden",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					"aria-hidden": "true",
					className: "pointer-events-none absolute inset-0",
					style: {
						backgroundImage: "linear-gradient(to right, var(--color-fg-8) 1px, transparent 1px), linear-gradient(to bottom, var(--color-fg-8) 1px, transparent 1px)",
						backgroundSize: "32px 32px",
						backgroundPosition: "center center",
						maskImage: "radial-gradient(ellipse at center, black 0%, black 38%, transparent 80%)",
						WebkitMaskImage: "radial-gradient(ellipse at center, black 0%, black 38%, transparent 80%)"
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "relative grid size-12 place-items-center rounded-xl border border-border bg-card text-muted-foreground shadow-xs",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
						className: "size-[18px]",
						strokeWidth: 1.6
					})
				})]
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					className: "size-4",
					strokeWidth: 1.6
				})
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
				size: 22,
				strokeWidth: 1.5,
				className: "opacity-45"
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: isMd ? "text-sm font-medium text-foreground" : "text-xs",
				children: title
			}),
			description ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: isMd ? "max-w-xs text-xs leading-5 text-muted-foreground" : "text-[11px] opacity-70",
				children: description
			}) : null,
			action ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: isMd ? "mt-2" : "mt-1.5",
				children: action
			}) : null
		]
	});
}
//#endregion
//#region src/primitives/input.tsx
function Input({ className, type, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_input.Input, {
		type,
		"data-slot": "input",
		className: cn("h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40", className),
		...props
	});
}
//#endregion
//#region src/primitives/kbd.tsx
/**
* Kbd — keyboard shortcut hint. Inline `<kbd>` styled as a tiny pill.
* Use in tooltip footers, menu trailing slots, and help text to teach
* keyboard grammar continuously.
*
* Single-key glyphs (⌘, ⇧, ↑, K) auto-center via the square sizing.
* For multi-key sequences, render multiple <Kbd> with a separator:
*   <Kbd>⌘</Kbd><Kbd>K</Kbd>
*/
const kbdVariants = (0, class_variance_authority.cva)("inline-flex items-center justify-center rounded border border-border bg-fg-2 font-mono text-[10px] font-medium text-muted-foreground tabular-nums", {
	variants: { size: {
		sm: "h-4 min-w-4 px-1",
		md: "h-5 min-w-5 px-1.5 text-[11px]"
	} },
	defaultVariants: { size: "sm" }
});
function Kbd({ className, size, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("kbd", {
		"data-slot": "kbd",
		className: cn(kbdVariants({ size }), className),
		...props
	});
}
//#endregion
//#region src/primitives/label.tsx
function Label({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
		"data-slot": "label",
		className: cn("flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50", className),
		...props
	});
}
//#endregion
//#region src/primitives/popover.tsx
function Popover({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_popover.Popover.Root, {
		"data-slot": "popover",
		...props
	});
}
function PopoverTrigger({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_popover.Popover.Trigger, {
		"data-slot": "popover-trigger",
		...props
	});
}
function PopoverContent({ className, positionerClassName, align = "center", alignOffset = 0, side = "bottom", sideOffset = 6, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_popover.Popover.Portal, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_popover.Popover.Positioner, {
		align,
		alignOffset,
		side,
		sideOffset,
		className: cn("isolate z-50", positionerClassName),
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_popover.Popover.Popup, {
			"data-slot": "popover-content",
			className: cn("z-50 flex w-72 origin-(--transform-origin) flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-2xl ring-0 ring-border outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className),
			...props
		})
	}) });
}
function PopoverHeader({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: cn("flex flex-col gap-1", className),
		...props
	});
}
function PopoverTitle({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_popover.Popover.Title, {
		"data-slot": "popover-title",
		className: cn("text-base font-semibold", className),
		...props
	});
}
function PopoverDescription({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_popover.Popover.Description, {
		"data-slot": "popover-description",
		className: cn("text-muted-foreground", className),
		...props
	});
}
//#endregion
//#region src/primitives/select.tsx
const Select = _base_ui_react_select.Select.Root;
function SelectGroup({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.Group, {
		"data-slot": "select-group",
		className: cn("scroll-my-1 p-1", className),
		...props
	});
}
function SelectValue({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.Value, {
		"data-slot": "select-value",
		className: cn("flex flex-1 text-left", className),
		...props
	});
}
function SelectTrigger({ className, size = "default", children, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_base_ui_react_select.Select.Trigger, {
		"data-slot": "select-trigger",
		"data-size": size,
		className: cn("flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", className),
		...props,
		children: [children, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.Icon, { render: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(lucide_react.ChevronDownIcon, { className: "pointer-events-none size-4 text-muted-foreground" }) })]
	});
}
function SelectContent({ className, children, side = "bottom", sideOffset = 4, align = "center", alignOffset = 0, alignItemWithTrigger = true, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.Portal, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.Positioner, {
		side,
		sideOffset,
		align,
		alignOffset,
		alignItemWithTrigger,
		className: "isolate z-50",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_base_ui_react_select.Select.Popup, {
			"data-slot": "select-content",
			"data-align-trigger": alignItemWithTrigger,
			className: cn("dark isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg text-popover-foreground shadow-md ring-1 ring-border duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 animate-none! relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-fg-5 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[variant=destructive]:focus:bg-foreground/10! **:data-[variant=destructive]:text-accent-foreground! **:data-[variant=destructive]:**:text-accent-foreground!", className),
			...props,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectScrollUpButton, {}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.List, { children }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectScrollDownButton, {})
			]
		})
	}) });
}
function SelectLabel({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.GroupLabel, {
		"data-slot": "select-label",
		className: cn("px-1.5 py-1 text-xs text-muted-foreground", className),
		...props
	});
}
function SelectItem({ className, children, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_base_ui_react_select.Select.Item, {
		"data-slot": "select-item",
		className: cn("relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2", className),
		...props,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.ItemText, {
			className: "flex flex-1 shrink-0 items-center gap-2 whitespace-nowrap",
			children
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.ItemIndicator, {
			render: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "pointer-events-none absolute right-2 flex size-4 items-center justify-center" }),
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(lucide_react.CheckIcon, { className: "pointer-events-none" })
		})]
	});
}
function SelectSeparator({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.Separator, {
		"data-slot": "select-separator",
		className: cn("pointer-events-none -mx-1 my-1 h-px bg-border", className),
		...props
	});
}
function SelectScrollUpButton({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.ScrollUpArrow, {
		"data-slot": "select-scroll-up-button",
		className: cn("top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4", className),
		...props,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(lucide_react.ChevronUpIcon, {})
	});
}
function SelectScrollDownButton({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_select.Select.ScrollDownArrow, {
		"data-slot": "select-scroll-down-button",
		className: cn("bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4", className),
		...props,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(lucide_react.ChevronDownIcon, {})
	});
}
//#endregion
//#region src/primitives/status-dot.tsx
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
const statusDotVariants = (0, class_variance_authority.cva)("inline-block shrink-0 rounded-full", {
	variants: {
		variant: {
			success: "bg-success",
			destructive: "bg-destructive",
			warning: "bg-warning",
			info: "bg-info",
			primary: "bg-primary",
			muted: "bg-muted-foreground",
			neutral: "bg-fg-24"
		},
		size: {
			sm: "size-1.5",
			md: "size-2",
			lg: "size-2.5"
		},
		withRing: {
			true: "border-2 border-card",
			false: ""
		},
		pulse: {
			true: "animate-pulse",
			false: ""
		}
	},
	defaultVariants: {
		variant: "info",
		size: "sm",
		withRing: false,
		pulse: false
	}
});
function StatusDot({ className, variant, size, withRing, pulse, render, ...props }) {
	return (0, _base_ui_react_use_render.useRender)({
		defaultTagName: "span",
		props: (0, _base_ui_react_merge_props.mergeProps)({
			className: cn(statusDotVariants({
				variant,
				size,
				withRing,
				pulse
			}), className),
			"aria-hidden": true
		}, props),
		render,
		state: {
			slot: "status-dot",
			variant,
			size
		}
	});
}
//#endregion
//#region src/primitives/switch.tsx
function Switch({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_switch.Switch.Root, {
		className: cn("group/switch inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary", className),
		...props,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_switch.Switch.Thumb, { className: "pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform data-[checked]:translate-x-4 data-[unchecked]:translate-x-0" })
	});
}
//#endregion
//#region src/primitives/tabs.tsx
function Tabs({ className, orientation = "horizontal", ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tabs.Tabs.Root, {
		"data-slot": "tabs",
		"data-orientation": orientation,
		className: cn("group/tabs flex gap-2 data-horizontal:flex-col", className),
		...props
	});
}
const tabsListVariants = (0, class_variance_authority.cva)("group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none", {
	variants: { variant: {
		default: "bg-muted",
		line: "gap-1 bg-transparent"
	} },
	defaultVariants: { variant: "default" }
});
function TabsList({ className, variant = "default", ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tabs.Tabs.List, {
		"data-slot": "tabs-list",
		"data-variant": variant,
		className: cn(tabsListVariants({ variant }), className),
		...props
	});
}
function TabsTrigger({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tabs.Tabs.Tab, {
		"data-slot": "tabs-trigger",
		className: cn("relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground transition-colors group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent", "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground", "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100", className),
		...props
	});
}
function TabsContent({ className, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tabs.Tabs.Panel, {
		"data-slot": "tabs-content",
		className: cn("flex-1 text-sm outline-none", className),
		...props
	});
}
//#endregion
//#region src/primitives/tooltip.tsx
function TooltipProvider({ delay = 0, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tooltip.Tooltip.Provider, {
		"data-slot": "tooltip-provider",
		delay,
		...props
	});
}
function Tooltip({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tooltip.Tooltip.Root, {
		"data-slot": "tooltip",
		...props
	});
}
function TooltipTrigger({ ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tooltip.Tooltip.Trigger, {
		"data-slot": "tooltip-trigger",
		...props
	});
}
function TooltipContent({ className, side = "top", sideOffset = 4, align = "center", alignOffset = 0, children, ...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tooltip.Tooltip.Portal, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tooltip.Tooltip.Positioner, {
		align,
		alignOffset,
		side,
		sideOffset,
		className: "isolate z-50",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_base_ui_react_tooltip.Tooltip.Popup, {
			"data-slot": "tooltip-content",
			className: cn("z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className),
			...props,
			children: [children, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_base_ui_react_tooltip.Tooltip.Arrow, { className: "z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" })]
		})
	}) });
}
//#endregion
//#region src/layouts/dashboard-shell.tsx
function DashboardShell({ header, children, className, contentClassName }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: cn("flex h-full min-h-0 flex-col bg-background", className),
		children: [header ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "shrink-0 border-b border-border bg-background",
			children: header
		}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: cn("min-h-0 flex-1 overflow-y-auto", contentClassName),
			children
		})]
	});
}
//#endregion
//#region src/layouts/loading-state.tsx
function LoadingState({ variant = "rows", count = 4, className }) {
	const items = Array.from({ length: count }, (_, i) => i);
	if (variant === "card") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: cn("grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3", className),
		children: items.map((i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "h-24 animate-pulse rounded-xl border border-border bg-muted" }, i))
	});
	if (variant === "list") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: cn("flex flex-col divide-y divide-border", className),
		children: items.map((i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-3 px-4 py-3",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "size-8 shrink-0 animate-pulse rounded-full bg-muted" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "min-w-0 flex-1 space-y-1.5",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "h-3 w-1/3 animate-pulse rounded bg-muted" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "h-2.5 w-2/3 animate-pulse rounded bg-muted" })]
			})]
		}, i))
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: cn("flex flex-col gap-2 p-4", className),
		children: items.map((i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "h-4 animate-pulse rounded bg-muted",
			style: { width: `${100 - i * 8}%` }
		}, i))
	});
}
//#endregion
//#region src/layouts/data-table.tsx
const alignClass = {
	left: "text-left",
	right: "text-right",
	center: "text-center"
};
function DataTable({ columns, rows, rowKey, onRowClick, isLoading, emptyTitle = "No data yet", emptyDescription, className }) {
	if (isLoading) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadingState, { variant: "list" });
	if (rows.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, {
		title: emptyTitle,
		description: emptyDescription
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: cn("w-full overflow-x-auto", className),
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
			className: "w-full table-fixed border-collapse text-sm",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", {
				className: "border-b border-border bg-background",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: columns.map((col) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					className: cn("px-3 py-2 text-xs font-medium text-muted-foreground", alignClass[col.align ?? "left"], col.hideOnSmall && "hidden sm:table-cell"),
					style: col.width ? { width: col.width } : void 0,
					children: col.header
				}, col.id)) })
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", {
				onClick: onRowClick ? () => onRowClick(row) : void 0,
				className: cn("border-b border-border last:border-b-0 transition-colors", onRowClick && "cursor-pointer hover:bg-accent"),
				children: columns.map((col) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: cn("truncate px-3 py-2 text-sm text-foreground", alignClass[col.align ?? "left"], col.hideOnSmall && "hidden sm:table-cell"),
					children: col.cell(row)
				}, col.id))
			}, rowKey(row))) })]
		})
	});
}
//#endregion
//#region src/layouts/error-state.tsx
function ErrorState({ title = "Something went wrong", detail, onRetry, retryLabel = "Try again", className }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: cn("flex flex-col items-center justify-center gap-3 px-4 py-14 text-center", className),
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "grid size-10 place-items-center rounded-xl bg-destructive/10 text-destructive",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(lucide_react.AlertTriangle, {
					className: "size-4",
					strokeWidth: 1.6
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "text-sm font-medium text-foreground",
				children: title
			}),
			detail ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "max-w-md text-xs leading-5 text-muted-foreground",
				children: detail
			}) : null,
			onRetry ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
				size: "sm",
				variant: "outline",
				onClick: onRetry,
				children: retryLabel
			}) : null
		]
	});
}
//#endregion
//#region src/layouts/filter-bar.tsx
function FilterBar({ search, onSearchChange, searchPlaceholder = "Search…", filters, actions, className }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: cn("flex flex-wrap items-center gap-2 border-b border-border px-4 py-2", className),
		children: [
			onSearchChange ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "relative min-w-[180px] flex-1",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(lucide_react.Search, { className: "pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
					className: "h-7 pl-7 text-sm",
					value: search ?? "",
					placeholder: searchPlaceholder,
					onChange: (event) => onSearchChange(event.target.value)
				})]
			}) : null,
			filters ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "flex flex-wrap items-center gap-1.5",
				children: filters
			}) : null,
			actions ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "ml-auto flex items-center gap-1.5",
				children: actions
			}) : null
		]
	});
}
//#endregion
//#region src/layouts/page-header.tsx
function PageHeader({ title, description, actions, className }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: cn("flex items-start justify-between gap-4 px-4 py-3", className),
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "min-w-0 flex-1",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
				className: "truncate text-base font-semibold text-foreground",
				children: title
			}), description ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "mt-0.5 text-xs text-muted-foreground",
				children: description
			}) : null]
		}), actions ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "flex shrink-0 items-center gap-1.5",
			children: actions
		}) : null]
	});
}
//#endregion
//#region src/layouts/section.tsx
function Section({ title, description, actions, children, className, contentClassName }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: cn("px-4 py-3", className),
		children: [title || description || actions ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
			className: "mb-2 flex items-start justify-between gap-3",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "min-w-0 flex-1",
				children: [title ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
					className: "text-sm font-medium text-foreground",
					children: title
				}) : null, description ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "mt-0.5 text-xs text-muted-foreground",
					children: description
				}) : null]
			}), actions ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "flex shrink-0 items-center gap-1.5",
				children: actions
			}) : null]
		}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: contentClassName,
			children
		})]
	});
}
//#endregion
//#region src/layouts/stat-pill.tsx
const toneClass = {
	neutral: "text-foreground",
	positive: "text-emerald-600 dark:text-emerald-400",
	negative: "text-destructive"
};
function StatPill({ label, value, icon: Icon, trend, tone = "neutral", className }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: cn("flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2", className),
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-1.5 text-xs text-muted-foreground",
			children: [Icon ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
				className: "size-3",
				strokeWidth: 1.6
			}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "truncate",
				children: label
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "flex items-baseline gap-2",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: cn("text-lg font-semibold", toneClass[tone]),
				children: value
			}), trend ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "text-xs text-muted-foreground",
				children: trend
			}) : null]
		})]
	});
}
//#endregion
exports.Alert = Alert;
exports.AlertAction = AlertAction;
exports.AlertDescription = AlertDescription;
exports.AlertTitle = AlertTitle;
exports.Badge = Badge;
exports.Button = Button;
exports.Card = Card;
exports.CardAction = CardAction;
exports.CardContent = CardContent;
exports.CardDescription = CardDescription;
exports.CardFooter = CardFooter;
exports.CardHeader = CardHeader;
exports.CardTitle = CardTitle;
exports.DashboardShell = DashboardShell;
exports.DataTable = DataTable;
exports.DropdownMenu = DropdownMenu;
exports.DropdownMenuCheckboxItem = DropdownMenuCheckboxItem;
exports.DropdownMenuContent = DropdownMenuContent;
exports.DropdownMenuGroup = DropdownMenuGroup;
exports.DropdownMenuItem = DropdownMenuItem;
exports.DropdownMenuLabel = DropdownMenuLabel;
exports.DropdownMenuPortal = DropdownMenuPortal;
exports.DropdownMenuRadioGroup = DropdownMenuRadioGroup;
exports.DropdownMenuRadioItem = DropdownMenuRadioItem;
exports.DropdownMenuSeparator = DropdownMenuSeparator;
exports.DropdownMenuShortcut = DropdownMenuShortcut;
exports.DropdownMenuSub = DropdownMenuSub;
exports.DropdownMenuSubContent = DropdownMenuSubContent;
exports.DropdownMenuSubTrigger = DropdownMenuSubTrigger;
exports.DropdownMenuTrigger = DropdownMenuTrigger;
exports.EmptyState = EmptyState;
exports.ErrorState = ErrorState;
exports.FilterBar = FilterBar;
exports.Input = Input;
exports.Kbd = Kbd;
exports.Label = Label;
exports.LoadingState = LoadingState;
exports.PageHeader = PageHeader;
exports.Popover = Popover;
exports.PopoverContent = PopoverContent;
exports.PopoverDescription = PopoverDescription;
exports.PopoverHeader = PopoverHeader;
exports.PopoverTitle = PopoverTitle;
exports.PopoverTrigger = PopoverTrigger;
exports.Section = Section;
exports.Select = Select;
exports.SelectContent = SelectContent;
exports.SelectGroup = SelectGroup;
exports.SelectItem = SelectItem;
exports.SelectLabel = SelectLabel;
exports.SelectScrollDownButton = SelectScrollDownButton;
exports.SelectScrollUpButton = SelectScrollUpButton;
exports.SelectSeparator = SelectSeparator;
exports.SelectTrigger = SelectTrigger;
exports.SelectValue = SelectValue;
exports.StatPill = StatPill;
exports.StatusDot = StatusDot;
exports.Switch = Switch;
exports.Tabs = Tabs;
exports.TabsContent = TabsContent;
exports.TabsList = TabsList;
exports.TabsTrigger = TabsTrigger;
exports.Tooltip = Tooltip;
exports.TooltipContent = TooltipContent;
exports.TooltipProvider = TooltipProvider;
exports.TooltipTrigger = TooltipTrigger;
exports.badgeVariants = badgeVariants;
exports.buttonVariants = buttonVariants;
exports.cn = cn;
exports.tabsListVariants = tabsListVariants;
