import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ChevronDown } from "@/components/ui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ProviderBrandIcon } from "@/lib/providerBrandIcon";
import { cn } from "@/lib/utils";

/** A model option — the shared shape used by both harness `supported_models`
 *  (claude-code/codex) and the pi/Hola runtime catalogue, mapped to `{id,label}`. */
export interface ChannelModelOption {
  id: string;
  label: string;
}

/**
 * Per-channel model picker. Like {@link HarnessModelPicker}, but the top row is an
 * explicit "Default" that CLEARS the override (`onChange(null)`) — a channel with no
 * override inherits its harness/workspace default, which can change over time, so
 * inherit is a first-class, distinct state from pinning the current default.
 *
 * `value === null` means inherit; the trigger then shows the default's label.
 */
export function ChannelModelPicker({
  value,
  models,
  defaultLabel,
  disabled,
  onChange,
  triggerClassName,
}: {
  value: string | null;
  models: ChannelModelOption[];
  /** Label of the inherited default, shown on the "Default" row + when value is null. */
  defaultLabel: string;
  disabled?: boolean;
  onChange: (modelId: string | null) => void;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? models.find((m) => m.id === value) : null;
  // When pinned but the id isn't in the list (e.g. a stale/unknown model), still
  // show the raw id so the user sees what's set rather than a silent fallback.
  const triggerLabel = value
    ? (selected?.label ?? value)
    : `Default · ${defaultLabel}`;
  const triggerToken = value ?? "";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "min-w-0 gap-1.5 rounded-md px-2 text-xs font-medium",
              triggerClassName,
            )}
          >
            <ProviderBrandIcon
              modelToken={triggerToken}
              className="size-3.5 shrink-0"
            />
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-[260px] gap-0 overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-0 shadow-2xl ring-1 ring-foreground/[0.04] backdrop-blur-xl"
      >
        <div className="chat-scrollbar-thin max-h-[280px] overflow-y-auto p-1">
          <button
            type="button"
            aria-current={value === null ? "true" : undefined}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              value === null
                ? "bg-foreground/[0.06] text-foreground"
                : "text-foreground hover:bg-foreground/[0.04]"
            }`}
          >
            <span className="truncate">Default · {defaultLabel}</span>
            <span className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
              Inherit
            </span>
          </button>
          {models.map((model) => {
            const active = model.id === value;
            return (
              <button
                key={model.id}
                type="button"
                title={model.id}
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onChange(model.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                  active
                    ? "bg-foreground/[0.06] text-foreground"
                    : "text-foreground hover:bg-foreground/[0.04]"
                }`}
              >
                <ProviderBrandIcon
                  modelToken={model.id}
                  className="size-3.5 shrink-0"
                />
                <span className="truncate">{model.label}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
