import { useMemo, useState } from "react";
import { ChevronDown, Search } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { ModelCatalogRefreshButton } from "@/components/model/ModelCatalogRefreshButton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ProviderBrandIcon } from "@/lib/providerBrandIcon";
import { CHAT_MODEL_USE_RUNTIME_DEFAULT } from "../constants";
import { compactComposerModelLabel } from "../helpers";
import type { ChatModelOption, ChatModelOptionGroup } from "../types";

export function ModelCombobox({
  selectedModel,
  selectedModelLabel,
  runtimeDefaultModelLabel,
  runtimeDefaultModelAvailable,
  modelOptions,
  modelOptionGroups,
  disabled,
  compact = false,
  onModelChange,
}: {
  selectedModel: string;
  selectedModelLabel: string;
  runtimeDefaultModelLabel: string;
  runtimeDefaultModelAvailable: boolean;
  modelOptions: ChatModelOption[];
  modelOptionGroups: ChatModelOptionGroup[];
  disabled: boolean;
  compact?: boolean;
  onModelChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const autoOption = useMemo(
    () =>
      runtimeDefaultModelAvailable
        ? ({
            value: CHAT_MODEL_USE_RUNTIME_DEFAULT,
            label: `Auto (${runtimeDefaultModelLabel})`,
          } satisfies ChatModelOption)
        : null,
    [runtimeDefaultModelAvailable, runtimeDefaultModelLabel],
  );

  const filteredAutoOption = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!autoOption) {
      return null;
    }
    if (!q) {
      return autoOption;
    }
    return autoOption.label.toLowerCase().includes(q) ||
      autoOption.value.toLowerCase().includes(q)
      ? autoOption
      : null;
  }, [autoOption, query]);

  const filteredOptionGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sourceGroups =
      modelOptionGroups.length > 0
        ? modelOptionGroups
        : [{ label: "", options: modelOptions }];
    return sourceGroups
      .map((group) => ({
        ...group,
        options: q
          ? group.options.filter((option) => {
              const haystack = [
                option.label,
                option.selectedLabel,
                option.searchText,
                option.value,
                group.label,
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return haystack.includes(q);
            })
          : group.options,
      }))
      .filter((group) => group.options.length > 0);
  }, [modelOptionGroups, modelOptions, query]);

  const displayLabel =
    selectedModel === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? `Auto (${runtimeDefaultModelLabel})`
      : selectedModelLabel || "Select model";
  const compactLabel = compactComposerModelLabel(displayLabel);

  const hasFilteredOptions =
    Boolean(filteredAutoOption) ||
    filteredOptionGroups.some((group) => group.options.length > 0);

  const renderOption = (option: ChatModelOption) => {
    const active = option.value === selectedModel;
    const optionDisabled = Boolean(option.disabled);
    // Auto/runtime-default doesn't represent a single model — keep its
    // icon empty rather than guessing (the chosen runtime default still
    // ends up rendering with its real brand mark in the trigger).
    const isRuntimeDefault = option.value === CHAT_MODEL_USE_RUNTIME_DEFAULT;
    return (
      <button
        key={option.value}
        type="button"
        disabled={optionDisabled}
        aria-current={active ? "true" : undefined}
        onClick={() => {
          if (optionDisabled) {
            return;
          }
          onModelChange(option.value);
          setOpen(false);
          setQuery("");
        }}
        className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
          active
            ? "bg-foreground/[0.06] text-foreground"
            : optionDisabled
              ? "cursor-not-allowed text-foreground/40"
              : "text-foreground hover:bg-foreground/[0.04]"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {isRuntimeDefault ? (
            <span className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <ProviderBrandIcon
              modelToken={option.value}
              className="size-3.5 shrink-0"
            />
          )}
          <span className="truncate">{option.label}</span>
        </span>
        {!active && option.statusLabel ? (
          <span className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
            {option.statusLabel}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="sm"
            className={`min-w-0 gap-1.5 rounded-md text-xs font-medium ${
              compact ? "w-full justify-between px-2.5" : "px-2"
            }`}
          >
            {compact ? (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <ProviderBrandIcon
                    modelToken={selectedModel}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{compactLabel}</span>
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            ) : (
              <>
                <ProviderBrandIcon
                  modelToken={selectedModel}
                  className="size-3.5 shrink-0"
                />
                <span className="truncate">{displayLabel}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </Button>
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        // Premium pop: glassy backdrop, multi-layer shadow (outer 2xl
        // + inner 1px ring), softer border. Mirrors the cmd palette
        // surfaces in Linear / Claude.ai.
        className="w-[300px] gap-0 overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-0 shadow-2xl ring-1 ring-foreground/[0.04] backdrop-blur-xl"
      >
        <div className="border-b border-border/60 px-2.5 pt-2 pb-1.5">
          <div className="flex items-center gap-2">
            <Search className="size-3.5 shrink-0 text-foreground/40" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="embedded-input h-6 w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/35"
            />
            <ModelCatalogRefreshButton />
          </div>
        </div>
        <div className="chat-scrollbar-thin max-h-[280px] overflow-y-auto p-1">
          {!hasFilteredOptions ? (
            <div className="px-3 py-6 text-center text-xs text-foreground/55">
              No models found
            </div>
          ) : (
            <>
              {filteredAutoOption ? (
                <div className="pb-1">{renderOption(filteredAutoOption)}</div>
              ) : null}
              {filteredOptionGroups.map((group, idx) => (
                <div
                  key={group.label || "models"}
                  className={idx > 0 ? "mt-1.5" : ""}
                >
                  {group.label ? (
                    <div className="px-2.5 pt-1 pb-1 text-[10px] font-medium uppercase text-foreground/40">
                      {group.label}
                    </div>
                  ) : null}
                  {group.options.map((option) => renderOption(option))}
                </div>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
