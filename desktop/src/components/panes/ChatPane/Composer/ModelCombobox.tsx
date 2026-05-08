import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
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
            ? "bg-accent text-foreground"
            : optionDisabled
              ? "cursor-not-allowed text-muted-foreground"
              : "text-foreground hover:bg-accent"
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
            className={`gap-1.5 rounded-md text-xs font-medium ${
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
                <span className="whitespace-nowrap">{displayLabel}</span>
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
        className="p-0 gap-0"
      >
        <div className="border-b border-border p-1.5">
          <div className="relative flex h-7 items-center rounded-md border border-border bg-background px-2.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              className="embedded-input h-full w-full bg-transparent pl-2 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {!hasFilteredOptions ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
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
                  className={idx > 0 ? "mt-2" : ""}
                >
                  {group.label ? (
                    <div className="px-2.5 pb-1 text-[10px] font-medium uppercase text-muted-foreground">
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
