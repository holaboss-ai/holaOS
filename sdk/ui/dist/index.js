// src/primitives/alert.tsx
import "react";
import { cva } from "class-variance-authority";

// src/lib/utils.ts
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// src/primitives/alert.tsx
import { jsx } from "react/jsx-runtime";
var alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive: "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);
function Alert({
  className,
  variant,
  ...props
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      "data-slot": "alert",
      role: "alert",
      className: cn(alertVariants({ variant }), className),
      ...props
    }
  );
}
function AlertTitle({ className, ...props }) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      "data-slot": "alert-title",
      className: cn(
        "font-heading font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      ),
      ...props
    }
  );
}
function AlertDescription({
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      "data-slot": "alert-description",
      className: cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      ),
      ...props
    }
  );
}
function AlertAction({ className, ...props }) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      "data-slot": "alert-action",
      className: cn("absolute top-2 right-2", className),
      ...props
    }
  );
}

// src/primitives/badge.tsx
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva as cva2 } from "class-variance-authority";
var badgeVariants = cva2(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive: "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline: "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted",
        link: "text-primary underline-offset-4 hover:underline"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);
function Badge({
  className,
  variant = "default",
  render,
  ...props
}) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps(
      {
        className: cn(badgeVariants({ variant }), className)
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant
    }
  });
}

// src/primitives/button.tsx
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva as cva3 } from "class-variance-authority";
import { jsx as jsx2 } from "react/jsx-runtime";
var buttonVariants = cva3(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
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
  }
);
function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}) {
  return /* @__PURE__ */ jsx2(
    ButtonPrimitive,
    {
      "data-slot": "button",
      className: cn(buttonVariants({ variant, size, className })),
      ...props
    }
  );
}

// src/primitives/card.tsx
import "react";
import { jsx as jsx3 } from "react/jsx-runtime";
function Card({
  className,
  size = "default",
  ...props
}) {
  return /* @__PURE__ */ jsx3(
    "div",
    {
      "data-slot": "card",
      "data-size": size,
      className: cn(
        // Hairline edge driven by shadow-sm (the new unified token —
        // 1px oklch-from-foreground ring with --hairline-alpha tuned per
        // mode). Replaces the explicit ring-1 ring-border so cards inherit
        // the same edge treatment as inputs/popovers/menus.
        "group/card flex flex-col gap-4 overflow-hidden rounded-xl bg-card py-4 text-sm text-card-foreground shadow-sm has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      ),
      ...props
    }
  );
}
function CardHeader({ className, ...props }) {
  return /* @__PURE__ */ jsx3(
    "div",
    {
      "data-slot": "card-header",
      className: cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3",
        className
      ),
      ...props
    }
  );
}
function CardTitle({ className, ...props }) {
  return /* @__PURE__ */ jsx3(
    "div",
    {
      "data-slot": "card-title",
      className: cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      ),
      ...props
    }
  );
}
function CardDescription({ className, ...props }) {
  return /* @__PURE__ */ jsx3(
    "div",
    {
      "data-slot": "card-description",
      className: cn("text-sm text-muted-foreground", className),
      ...props
    }
  );
}
function CardAction({ className, ...props }) {
  return /* @__PURE__ */ jsx3(
    "div",
    {
      "data-slot": "card-action",
      className: cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      ),
      ...props
    }
  );
}
function CardContent({ className, ...props }) {
  return /* @__PURE__ */ jsx3(
    "div",
    {
      "data-slot": "card-content",
      className: cn("px-4 group-data-[size=sm]/card:px-3", className),
      ...props
    }
  );
}
function CardFooter({ className, ...props }) {
  return /* @__PURE__ */ jsx3(
    "div",
    {
      "data-slot": "card-footer",
      className: cn(
        "flex items-center rounded-b-xl border-t bg-muted p-4 group-data-[size=sm]/card:p-3",
        className
      ),
      ...props
    }
  );
}

// src/primitives/dropdown-menu.tsx
import "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ChevronRightIcon, CheckIcon } from "lucide-react";
import { jsx as jsx4, jsxs } from "react/jsx-runtime";
function DropdownMenu({ ...props }) {
  return /* @__PURE__ */ jsx4(MenuPrimitive.Root, { "data-slot": "dropdown-menu", ...props });
}
function DropdownMenuPortal({ ...props }) {
  return /* @__PURE__ */ jsx4(MenuPrimitive.Portal, { "data-slot": "dropdown-menu-portal", ...props });
}
function DropdownMenuTrigger({ ...props }) {
  return /* @__PURE__ */ jsx4(MenuPrimitive.Trigger, { "data-slot": "dropdown-menu-trigger", ...props });
}
function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx4(MenuPrimitive.Portal, { children: /* @__PURE__ */ jsx4(
    MenuPrimitive.Positioner,
    {
      className: "isolate z-50 outline-none",
      align,
      alignOffset,
      side,
      sideOffset,
      children: /* @__PURE__ */ jsx4(
        MenuPrimitive.Popup,
        {
          "data-slot": "dropdown-menu-content",
          className: cn(
            "dark z-50 max-h-(--available-height) w-(--anchor-width) min-w-44 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg p-1 text-popover-foreground shadow-md ring-1 ring-border duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95 animate-none! relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 **:data-[slot$=-item]:not-data-[variant=destructive]:focus:bg-foreground/10 **:data-[slot$=-item]:not-data-[variant=destructive]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-fg-5 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10!",
            className
          ),
          ...props
        }
      )
    }
  ) });
}
function DropdownMenuGroup({ ...props }) {
  return /* @__PURE__ */ jsx4(MenuPrimitive.Group, { "data-slot": "dropdown-menu-group", ...props });
}
function DropdownMenuLabel({
  className,
  inset,
  ...props
}) {
  return /* @__PURE__ */ jsx4(
    MenuPrimitive.GroupLabel,
    {
      "data-slot": "dropdown-menu-label",
      "data-inset": inset,
      className: cn(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
        className
      ),
      ...props
    }
  );
}
function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}) {
  return /* @__PURE__ */ jsx4(
    MenuPrimitive.Item,
    {
      "data-slot": "dropdown-menu-item",
      "data-inset": inset,
      "data-variant": variant,
      className: cn(
        "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-2.5 py-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        className
      ),
      ...props
    }
  );
}
function DropdownMenuSub({ ...props }) {
  return /* @__PURE__ */ jsx4(MenuPrimitive.SubmenuRoot, { "data-slot": "dropdown-menu-sub", ...props });
}
function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}) {
  return /* @__PURE__ */ jsxs(
    MenuPrimitive.SubmenuTrigger,
    {
      "data-slot": "dropdown-menu-sub-trigger",
      "data-inset": inset,
      className: cn(
        "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      ),
      ...props,
      children: [
        children,
        /* @__PURE__ */ jsx4(ChevronRightIcon, { className: "ml-auto" })
      ]
    }
  );
}
function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx4(
    DropdownMenuContent,
    {
      "data-slot": "dropdown-menu-sub-content",
      className: cn(
        "dark w-auto min-w-[96px] rounded-lg p-1 text-popover-foreground shadow-lg ring-1 ring-border duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 animate-none! relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 **:data-[slot$=-item]:not-data-[variant=destructive]:focus:bg-foreground/10 **:data-[slot$=-item]:not-data-[variant=destructive]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-fg-5 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10!",
        className
      ),
      align,
      alignOffset,
      side,
      sideOffset,
      ...props
    }
  );
}
function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}) {
  return /* @__PURE__ */ jsxs(
    MenuPrimitive.CheckboxItem,
    {
      "data-slot": "dropdown-menu-checkbox-item",
      "data-inset": inset,
      className: cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      ),
      checked,
      ...props,
      children: [
        /* @__PURE__ */ jsx4(
          "span",
          {
            className: "pointer-events-none absolute right-2 flex items-center justify-center",
            "data-slot": "dropdown-menu-checkbox-item-indicator",
            children: /* @__PURE__ */ jsx4(MenuPrimitive.CheckboxItemIndicator, { children: /* @__PURE__ */ jsx4(CheckIcon, {}) })
          }
        ),
        children
      ]
    }
  );
}
function DropdownMenuRadioGroup({ ...props }) {
  return /* @__PURE__ */ jsx4(
    MenuPrimitive.RadioGroup,
    {
      "data-slot": "dropdown-menu-radio-group",
      ...props
    }
  );
}
function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}) {
  return /* @__PURE__ */ jsxs(
    MenuPrimitive.RadioItem,
    {
      "data-slot": "dropdown-menu-radio-item",
      "data-inset": inset,
      className: cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      ),
      ...props,
      children: [
        /* @__PURE__ */ jsx4(
          "span",
          {
            className: "pointer-events-none absolute right-2 flex items-center justify-center",
            "data-slot": "dropdown-menu-radio-item-indicator",
            children: /* @__PURE__ */ jsx4(MenuPrimitive.RadioItemIndicator, { children: /* @__PURE__ */ jsx4(CheckIcon, {}) })
          }
        ),
        children
      ]
    }
  );
}
function DropdownMenuSeparator({
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx4(
    MenuPrimitive.Separator,
    {
      "data-slot": "dropdown-menu-separator",
      className: cn("-mx-1 my-1 h-px bg-border", className),
      ...props
    }
  );
}
function DropdownMenuShortcut({
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx4(
    "span",
    {
      "data-slot": "dropdown-menu-shortcut",
      className: cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground",
        className
      ),
      ...props
    }
  );
}

// src/primitives/empty-state.tsx
import { jsx as jsx5, jsxs as jsxs2 } from "react/jsx-runtime";
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = "sm",
  minHeight,
  decorated = false,
  className
}) {
  const isMd = size === "md";
  const wrapperClass = cn(
    "flex flex-col items-center justify-center text-center",
    isMd ? "gap-3 px-4 py-14" : "gap-2 py-10 text-muted-foreground",
    className
  );
  const titleClass = isMd ? "text-sm font-medium text-foreground" : "text-xs";
  const descriptionClass = isMd ? "max-w-xs text-xs leading-5 text-muted-foreground" : "text-[11px] opacity-70";
  return /* @__PURE__ */ jsxs2(
    "div",
    {
      className: wrapperClass,
      style: minHeight ? { minHeight } : void 0,
      children: [
        Icon ? isMd ? decorated ? /* @__PURE__ */ jsxs2("div", { className: "relative flex h-24 w-72 items-center justify-center overflow-hidden", children: [
          /* @__PURE__ */ jsx5(
            "div",
            {
              "aria-hidden": "true",
              className: "pointer-events-none absolute inset-0",
              style: {
                backgroundImage: "linear-gradient(to right, var(--color-fg-8) 1px, transparent 1px), linear-gradient(to bottom, var(--color-fg-8) 1px, transparent 1px)",
                backgroundSize: "32px 32px",
                backgroundPosition: "center center",
                maskImage: "radial-gradient(ellipse at center, black 0%, black 38%, transparent 80%)",
                WebkitMaskImage: "radial-gradient(ellipse at center, black 0%, black 38%, transparent 80%)"
              }
            }
          ),
          /* @__PURE__ */ jsx5("div", { className: "relative grid size-12 place-items-center rounded-xl border border-border bg-card text-muted-foreground shadow-xs", children: /* @__PURE__ */ jsx5(Icon, { className: "size-[18px]", strokeWidth: 1.6 }) })
        ] }) : /* @__PURE__ */ jsx5("div", { className: "grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground", children: /* @__PURE__ */ jsx5(Icon, { className: "size-4", strokeWidth: 1.6 }) }) : /* @__PURE__ */ jsx5(Icon, { size: 22, strokeWidth: 1.5, className: "opacity-45" }) : null,
        /* @__PURE__ */ jsx5("p", { className: titleClass, children: title }),
        description ? /* @__PURE__ */ jsx5("p", { className: descriptionClass, children: description }) : null,
        action ? /* @__PURE__ */ jsx5("div", { className: isMd ? "mt-2" : "mt-1.5", children: action }) : null
      ]
    }
  );
}

// src/primitives/input.tsx
import "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { jsx as jsx6 } from "react/jsx-runtime";
function Input({ className, type, ...props }) {
  return /* @__PURE__ */ jsx6(
    InputPrimitive,
    {
      type,
      "data-slot": "input",
      className: cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      ),
      ...props
    }
  );
}

// src/primitives/kbd.tsx
import { cva as cva4 } from "class-variance-authority";
import { jsx as jsx7 } from "react/jsx-runtime";
var kbdVariants = cva4(
  "inline-flex items-center justify-center rounded border border-border bg-fg-2 font-mono text-[10px] font-medium text-muted-foreground tabular-nums",
  {
    variants: {
      size: {
        sm: "h-4 min-w-4 px-1",
        md: "h-5 min-w-5 px-1.5 text-[11px]"
      }
    },
    defaultVariants: { size: "sm" }
  }
);
function Kbd({ className, size, ...props }) {
  return /* @__PURE__ */ jsx7(
    "kbd",
    {
      "data-slot": "kbd",
      className: cn(kbdVariants({ size }), className),
      ...props
    }
  );
}

// src/primitives/label.tsx
import "react";
import { jsx as jsx8 } from "react/jsx-runtime";
function Label({ className, ...props }) {
  return /* @__PURE__ */ jsx8(
    "label",
    {
      "data-slot": "label",
      className: cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      ),
      ...props
    }
  );
}

// src/primitives/popover.tsx
import "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { jsx as jsx9 } from "react/jsx-runtime";
function Popover({ ...props }) {
  return /* @__PURE__ */ jsx9(PopoverPrimitive.Root, { "data-slot": "popover", ...props });
}
function PopoverTrigger({ ...props }) {
  return /* @__PURE__ */ jsx9(PopoverPrimitive.Trigger, { "data-slot": "popover-trigger", ...props });
}
function PopoverContent({
  className,
  positionerClassName,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  ...props
}) {
  return /* @__PURE__ */ jsx9(PopoverPrimitive.Portal, { children: /* @__PURE__ */ jsx9(
    PopoverPrimitive.Positioner,
    {
      align,
      alignOffset,
      side,
      sideOffset,
      className: cn("isolate z-50", positionerClassName),
      children: /* @__PURE__ */ jsx9(
        PopoverPrimitive.Popup,
        {
          "data-slot": "popover-content",
          className: cn(
            "z-50 flex w-72 origin-(--transform-origin) flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-2xl ring-0 ring-border outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          ),
          ...props
        }
      )
    }
  ) });
}
function PopoverHeader({ className, ...props }) {
  return /* @__PURE__ */ jsx9("div", { className: cn("flex flex-col gap-1", className), ...props });
}
function PopoverTitle({ className, ...props }) {
  return /* @__PURE__ */ jsx9(
    PopoverPrimitive.Title,
    {
      "data-slot": "popover-title",
      className: cn("text-base font-semibold", className),
      ...props
    }
  );
}
function PopoverDescription({
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx9(
    PopoverPrimitive.Description,
    {
      "data-slot": "popover-description",
      className: cn("text-muted-foreground", className),
      ...props
    }
  );
}

// src/primitives/select.tsx
import "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { ChevronDownIcon, CheckIcon as CheckIcon2, ChevronUpIcon } from "lucide-react";
import { jsx as jsx10, jsxs as jsxs3 } from "react/jsx-runtime";
var Select = SelectPrimitive.Root;
function SelectGroup({ className, ...props }) {
  return /* @__PURE__ */ jsx10(
    SelectPrimitive.Group,
    {
      "data-slot": "select-group",
      className: cn("scroll-my-1 p-1", className),
      ...props
    }
  );
}
function SelectValue({ className, ...props }) {
  return /* @__PURE__ */ jsx10(
    SelectPrimitive.Value,
    {
      "data-slot": "select-value",
      className: cn("flex flex-1 text-left", className),
      ...props
    }
  );
}
function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}) {
  return /* @__PURE__ */ jsxs3(
    SelectPrimitive.Trigger,
    {
      "data-slot": "select-trigger",
      "data-size": size,
      className: cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      ),
      ...props,
      children: [
        children,
        /* @__PURE__ */ jsx10(
          SelectPrimitive.Icon,
          {
            render: /* @__PURE__ */ jsx10(ChevronDownIcon, { className: "pointer-events-none size-4 text-muted-foreground" })
          }
        )
      ]
    }
  );
}
function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}) {
  return /* @__PURE__ */ jsx10(SelectPrimitive.Portal, { children: /* @__PURE__ */ jsx10(
    SelectPrimitive.Positioner,
    {
      side,
      sideOffset,
      align,
      alignOffset,
      alignItemWithTrigger,
      className: "isolate z-50",
      children: /* @__PURE__ */ jsxs3(
        SelectPrimitive.Popup,
        {
          "data-slot": "select-content",
          "data-align-trigger": alignItemWithTrigger,
          className: cn(
            "dark isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg text-popover-foreground shadow-md ring-1 ring-border duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 animate-none! relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-fg-5 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[variant=destructive]:focus:bg-foreground/10! **:data-[variant=destructive]:text-accent-foreground! **:data-[variant=destructive]:**:text-accent-foreground!",
            className
          ),
          ...props,
          children: [
            /* @__PURE__ */ jsx10(SelectScrollUpButton, {}),
            /* @__PURE__ */ jsx10(SelectPrimitive.List, { children }),
            /* @__PURE__ */ jsx10(SelectScrollDownButton, {})
          ]
        }
      )
    }
  ) });
}
function SelectLabel({
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx10(
    SelectPrimitive.GroupLabel,
    {
      "data-slot": "select-label",
      className: cn("px-1.5 py-1 text-xs text-muted-foreground", className),
      ...props
    }
  );
}
function SelectItem({
  className,
  children,
  ...props
}) {
  return /* @__PURE__ */ jsxs3(
    SelectPrimitive.Item,
    {
      "data-slot": "select-item",
      className: cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      ),
      ...props,
      children: [
        /* @__PURE__ */ jsx10(SelectPrimitive.ItemText, { className: "flex flex-1 shrink-0 items-center gap-2 whitespace-nowrap", children }),
        /* @__PURE__ */ jsx10(
          SelectPrimitive.ItemIndicator,
          {
            render: /* @__PURE__ */ jsx10("span", { className: "pointer-events-none absolute right-2 flex size-4 items-center justify-center" }),
            children: /* @__PURE__ */ jsx10(CheckIcon2, { className: "pointer-events-none" })
          }
        )
      ]
    }
  );
}
function SelectSeparator({
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx10(
    SelectPrimitive.Separator,
    {
      "data-slot": "select-separator",
      className: cn("pointer-events-none -mx-1 my-1 h-px bg-border", className),
      ...props
    }
  );
}
function SelectScrollUpButton({
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx10(
    SelectPrimitive.ScrollUpArrow,
    {
      "data-slot": "select-scroll-up-button",
      className: cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      ),
      ...props,
      children: /* @__PURE__ */ jsx10(
        ChevronUpIcon,
        {}
      )
    }
  );
}
function SelectScrollDownButton({
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx10(
    SelectPrimitive.ScrollDownArrow,
    {
      "data-slot": "select-scroll-down-button",
      className: cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      ),
      ...props,
      children: /* @__PURE__ */ jsx10(
        ChevronDownIcon,
        {}
      )
    }
  );
}

// src/primitives/status-dot.tsx
import { mergeProps as mergeProps2 } from "@base-ui/react/merge-props";
import { useRender as useRender2 } from "@base-ui/react/use-render";
import { cva as cva5 } from "class-variance-authority";
var statusDotVariants = cva5("inline-block shrink-0 rounded-full", {
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
function StatusDot({
  className,
  variant,
  size,
  withRing,
  pulse,
  render,
  ...props
}) {
  return useRender2({
    defaultTagName: "span",
    props: mergeProps2(
      {
        className: cn(
          statusDotVariants({ variant, size, withRing, pulse }),
          className
        ),
        "aria-hidden": true
      },
      props
    ),
    render,
    state: {
      slot: "status-dot",
      variant,
      size
    }
  });
}

// src/primitives/switch.tsx
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { jsx as jsx11 } from "react/jsx-runtime";
function Switch({ className, ...props }) {
  return /* @__PURE__ */ jsx11(
    SwitchPrimitive.Root,
    {
      className: cn(
        "group/switch inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary",
        className
      ),
      ...props,
      children: /* @__PURE__ */ jsx11(SwitchPrimitive.Thumb, { className: "pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform data-[checked]:translate-x-4 data-[unchecked]:translate-x-0" })
    }
  );
}

// src/primitives/tabs.tsx
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva as cva6 } from "class-variance-authority";
import { jsx as jsx12 } from "react/jsx-runtime";
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}) {
  return /* @__PURE__ */ jsx12(
    TabsPrimitive.Root,
    {
      "data-slot": "tabs",
      "data-orientation": orientation,
      className: cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      ),
      ...props
    }
  );
}
var tabsListVariants = cva6(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);
function TabsList({
  className,
  variant = "default",
  ...props
}) {
  return /* @__PURE__ */ jsx12(
    TabsPrimitive.List,
    {
      "data-slot": "tabs-list",
      "data-variant": variant,
      className: cn(tabsListVariants({ variant }), className),
      ...props
    }
  );
}
function TabsTrigger({ className, ...props }) {
  return /* @__PURE__ */ jsx12(
    TabsPrimitive.Tab,
    {
      "data-slot": "tabs-trigger",
      className: cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground transition-colors group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      ),
      ...props
    }
  );
}
function TabsContent({ className, ...props }) {
  return /* @__PURE__ */ jsx12(
    TabsPrimitive.Panel,
    {
      "data-slot": "tabs-content",
      className: cn("flex-1 text-sm outline-none", className),
      ...props
    }
  );
}

// src/primitives/tooltip.tsx
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { jsx as jsx13, jsxs as jsxs4 } from "react/jsx-runtime";
function TooltipProvider({
  delay = 0,
  ...props
}) {
  return /* @__PURE__ */ jsx13(
    TooltipPrimitive.Provider,
    {
      "data-slot": "tooltip-provider",
      delay,
      ...props
    }
  );
}
function Tooltip({ ...props }) {
  return /* @__PURE__ */ jsx13(TooltipPrimitive.Root, { "data-slot": "tooltip", ...props });
}
function TooltipTrigger({ ...props }) {
  return /* @__PURE__ */ jsx13(TooltipPrimitive.Trigger, { "data-slot": "tooltip-trigger", ...props });
}
function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}) {
  return /* @__PURE__ */ jsx13(TooltipPrimitive.Portal, { children: /* @__PURE__ */ jsx13(
    TooltipPrimitive.Positioner,
    {
      align,
      alignOffset,
      side,
      sideOffset,
      className: "isolate z-50",
      children: /* @__PURE__ */ jsxs4(
        TooltipPrimitive.Popup,
        {
          "data-slot": "tooltip-content",
          className: cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          ),
          ...props,
          children: [
            children,
            /* @__PURE__ */ jsx13(TooltipPrimitive.Arrow, { className: "z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" })
          ]
        }
      )
    }
  ) });
}

// src/layouts/dashboard-shell.tsx
import { jsx as jsx14, jsxs as jsxs5 } from "react/jsx-runtime";
function DashboardShell({
  header,
  children,
  className,
  contentClassName
}) {
  return /* @__PURE__ */ jsxs5("div", { className: cn("flex h-full min-h-0 flex-col bg-background", className), children: [
    header ? /* @__PURE__ */ jsx14("div", { className: "shrink-0 border-b border-border bg-background", children: header }) : null,
    /* @__PURE__ */ jsx14("div", { className: cn("min-h-0 flex-1 overflow-y-auto", contentClassName), children })
  ] });
}

// src/layouts/loading-state.tsx
import { jsx as jsx15, jsxs as jsxs6 } from "react/jsx-runtime";
function LoadingState({
  variant = "rows",
  count = 4,
  className
}) {
  const items = Array.from({ length: count }, (_, i) => i);
  if (variant === "card") {
    return /* @__PURE__ */ jsx15(
      "div",
      {
        className: cn(
          "grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3",
          className
        ),
        children: items.map((i) => /* @__PURE__ */ jsx15(
          "div",
          {
            className: "h-24 animate-pulse rounded-xl border border-border bg-muted"
          },
          i
        ))
      }
    );
  }
  if (variant === "list") {
    return /* @__PURE__ */ jsx15("div", { className: cn("flex flex-col divide-y divide-border", className), children: items.map((i) => /* @__PURE__ */ jsxs6("div", { className: "flex items-center gap-3 px-4 py-3", children: [
      /* @__PURE__ */ jsx15("div", { className: "size-8 shrink-0 animate-pulse rounded-full bg-muted" }),
      /* @__PURE__ */ jsxs6("div", { className: "min-w-0 flex-1 space-y-1.5", children: [
        /* @__PURE__ */ jsx15("div", { className: "h-3 w-1/3 animate-pulse rounded bg-muted" }),
        /* @__PURE__ */ jsx15("div", { className: "h-2.5 w-2/3 animate-pulse rounded bg-muted" })
      ] })
    ] }, i)) });
  }
  return /* @__PURE__ */ jsx15("div", { className: cn("flex flex-col gap-2 p-4", className), children: items.map((i) => /* @__PURE__ */ jsx15(
    "div",
    {
      className: "h-4 animate-pulse rounded bg-muted",
      style: { width: `${100 - i * 8}%` }
    },
    i
  )) });
}

// src/layouts/data-table.tsx
import { jsx as jsx16, jsxs as jsxs7 } from "react/jsx-runtime";
var alignClass = {
  left: "text-left",
  right: "text-right",
  center: "text-center"
};
function DataTable({
  columns,
  rows,
  rowKey,
  onRowClick,
  isLoading,
  emptyTitle = "No data yet",
  emptyDescription,
  className
}) {
  if (isLoading) {
    return /* @__PURE__ */ jsx16(LoadingState, { variant: "list" });
  }
  if (rows.length === 0) {
    return /* @__PURE__ */ jsx16(EmptyState, { title: emptyTitle, description: emptyDescription });
  }
  return /* @__PURE__ */ jsx16("div", { className: cn("w-full overflow-x-auto", className), children: /* @__PURE__ */ jsxs7("table", { className: "w-full table-fixed border-collapse text-sm", children: [
    /* @__PURE__ */ jsx16("thead", { className: "border-b border-border bg-background", children: /* @__PURE__ */ jsx16("tr", { children: columns.map((col) => /* @__PURE__ */ jsx16(
      "th",
      {
        className: cn(
          "px-3 py-2 text-xs font-medium text-muted-foreground",
          alignClass[col.align ?? "left"],
          col.hideOnSmall && "hidden sm:table-cell"
        ),
        style: col.width ? { width: col.width } : void 0,
        children: col.header
      },
      col.id
    )) }) }),
    /* @__PURE__ */ jsx16("tbody", { children: rows.map((row) => /* @__PURE__ */ jsx16(
      "tr",
      {
        onClick: onRowClick ? () => onRowClick(row) : void 0,
        className: cn(
          "border-b border-border last:border-b-0 transition-colors",
          onRowClick && "cursor-pointer hover:bg-accent"
        ),
        children: columns.map((col) => /* @__PURE__ */ jsx16(
          "td",
          {
            className: cn(
              "truncate px-3 py-2 text-sm text-foreground",
              alignClass[col.align ?? "left"],
              col.hideOnSmall && "hidden sm:table-cell"
            ),
            children: col.cell(row)
          },
          col.id
        ))
      },
      rowKey(row)
    )) })
  ] }) });
}

// src/layouts/error-state.tsx
import { AlertTriangle } from "lucide-react";
import { jsx as jsx17, jsxs as jsxs8 } from "react/jsx-runtime";
function ErrorState({
  title = "Something went wrong",
  detail,
  onRetry,
  retryLabel = "Try again",
  className
}) {
  return /* @__PURE__ */ jsxs8(
    "div",
    {
      className: cn(
        "flex flex-col items-center justify-center gap-3 px-4 py-14 text-center",
        className
      ),
      children: [
        /* @__PURE__ */ jsx17("div", { className: "grid size-10 place-items-center rounded-xl bg-destructive/10 text-destructive", children: /* @__PURE__ */ jsx17(AlertTriangle, { className: "size-4", strokeWidth: 1.6 }) }),
        /* @__PURE__ */ jsx17("p", { className: "text-sm font-medium text-foreground", children: title }),
        detail ? /* @__PURE__ */ jsx17("p", { className: "max-w-md text-xs leading-5 text-muted-foreground", children: detail }) : null,
        onRetry ? /* @__PURE__ */ jsx17(Button, { size: "sm", variant: "outline", onClick: onRetry, children: retryLabel }) : null
      ]
    }
  );
}

// src/layouts/filter-bar.tsx
import { Search } from "lucide-react";
import { jsx as jsx18, jsxs as jsxs9 } from "react/jsx-runtime";
function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder = "Search\u2026",
  filters,
  actions,
  className
}) {
  return /* @__PURE__ */ jsxs9(
    "div",
    {
      className: cn(
        "flex flex-wrap items-center gap-2 border-b border-border px-4 py-2",
        className
      ),
      children: [
        onSearchChange ? /* @__PURE__ */ jsxs9("div", { className: "relative min-w-[180px] flex-1", children: [
          /* @__PURE__ */ jsx18(Search, { className: "pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" }),
          /* @__PURE__ */ jsx18(
            Input,
            {
              className: "h-7 pl-7 text-sm",
              value: search ?? "",
              placeholder: searchPlaceholder,
              onChange: (event) => onSearchChange(event.target.value)
            }
          )
        ] }) : null,
        filters ? /* @__PURE__ */ jsx18("div", { className: "flex flex-wrap items-center gap-1.5", children: filters }) : null,
        actions ? /* @__PURE__ */ jsx18("div", { className: "ml-auto flex items-center gap-1.5", children: actions }) : null
      ]
    }
  );
}

// src/layouts/page-header.tsx
import { jsx as jsx19, jsxs as jsxs10 } from "react/jsx-runtime";
function PageHeader({
  title,
  description,
  actions,
  className
}) {
  return /* @__PURE__ */ jsxs10(
    "div",
    {
      className: cn(
        "flex items-start justify-between gap-4 px-4 py-3",
        className
      ),
      children: [
        /* @__PURE__ */ jsxs10("div", { className: "min-w-0 flex-1", children: [
          /* @__PURE__ */ jsx19("h1", { className: "truncate text-base font-semibold text-foreground", children: title }),
          description ? /* @__PURE__ */ jsx19("p", { className: "mt-0.5 text-xs text-muted-foreground", children: description }) : null
        ] }),
        actions ? /* @__PURE__ */ jsx19("div", { className: "flex shrink-0 items-center gap-1.5", children: actions }) : null
      ]
    }
  );
}

// src/layouts/section.tsx
import { jsx as jsx20, jsxs as jsxs11 } from "react/jsx-runtime";
function Section({
  title,
  description,
  actions,
  children,
  className,
  contentClassName
}) {
  return /* @__PURE__ */ jsxs11("section", { className: cn("px-4 py-3", className), children: [
    title || description || actions ? /* @__PURE__ */ jsxs11("header", { className: "mb-2 flex items-start justify-between gap-3", children: [
      /* @__PURE__ */ jsxs11("div", { className: "min-w-0 flex-1", children: [
        title ? /* @__PURE__ */ jsx20("h2", { className: "text-sm font-medium text-foreground", children: title }) : null,
        description ? /* @__PURE__ */ jsx20("p", { className: "mt-0.5 text-xs text-muted-foreground", children: description }) : null
      ] }),
      actions ? /* @__PURE__ */ jsx20("div", { className: "flex shrink-0 items-center gap-1.5", children: actions }) : null
    ] }) : null,
    /* @__PURE__ */ jsx20("div", { className: contentClassName, children })
  ] });
}

// src/layouts/stat-pill.tsx
import { jsx as jsx21, jsxs as jsxs12 } from "react/jsx-runtime";
var toneClass = {
  neutral: "text-foreground",
  positive: "text-emerald-600 dark:text-emerald-400",
  negative: "text-destructive"
};
function StatPill({
  label,
  value,
  icon: Icon,
  trend,
  tone = "neutral",
  className
}) {
  return /* @__PURE__ */ jsxs12(
    "div",
    {
      className: cn(
        "flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2",
        className
      ),
      children: [
        /* @__PURE__ */ jsxs12("div", { className: "flex items-center gap-1.5 text-xs text-muted-foreground", children: [
          Icon ? /* @__PURE__ */ jsx21(Icon, { className: "size-3", strokeWidth: 1.6 }) : null,
          /* @__PURE__ */ jsx21("span", { className: "truncate", children: label })
        ] }),
        /* @__PURE__ */ jsxs12("div", { className: "flex items-baseline gap-2", children: [
          /* @__PURE__ */ jsx21("span", { className: cn("text-lg font-semibold", toneClass[tone]), children: value }),
          trend ? /* @__PURE__ */ jsx21("span", { className: "text-xs text-muted-foreground", children: trend }) : null
        ] })
      ]
    }
  );
}
export {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  DashboardShell,
  DataTable,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  Kbd,
  Label,
  LoadingState,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Section,
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
  StatPill,
  StatusDot,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  badgeVariants,
  buttonVariants,
  cn,
  tabsListVariants
};
