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

/**
 * Model picker for CLI harnesses that ship with their own model namespace
 * (claude-code, codex). Same visual language as the Hola ModelCombobox —
 * brand icon + label rows in the glassy popover — minus search and provider
 * grouping, which a 4-8 entry homogeneous list doesn't need. The raw model
 * id (what the host runner dispatches) lives in the row tooltip.
 */
export function HarnessModelPicker({
  value,
  models,
  disabled,
  onChange,
  className,
  triggerClassName,
}: {
  value: string | null;
  models: HarnessSupportedModelPayload[];
  disabled?: boolean;
  onChange: (modelId: string) => void;
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = models.find((m) => m.id === value) ?? models[0];
  const triggerLabel = selected?.label ?? value ?? "Default";
  const triggerToken = selected?.id ?? value ?? "";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled || models.length === 0}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "min-w-0 gap-1.5 rounded-md px-2 text-xs font-medium",
              triggerClassName,
              className,
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
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                  active
                    ? "bg-foreground/[0.06] text-foreground"
                    : "text-foreground hover:bg-foreground/[0.04]"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderBrandIcon
                    modelToken={model.id}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{model.label}</span>
                </span>
                {model.default && !active ? (
                  <span className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
                    Default
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
