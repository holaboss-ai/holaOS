import { useState } from "react";
import { Lightbulb } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function displayThinkingValueLabel(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return "Thinking";
  }

  if (normalizedValue === "xhigh") {
    return "Extra High";
  }
  if (
    normalizedValue === "none" ||
    normalizedValue === "minimal" ||
    normalizedValue === "low" ||
    normalizedValue === "medium" ||
    normalizedValue === "high" ||
    normalizedValue === "max"
  ) {
    return `${normalizedValue[0]?.toUpperCase() ?? ""}${normalizedValue.slice(1)}`;
  }
  if (/^-?\d+$/.test(normalizedValue)) {
    return Number(normalizedValue).toLocaleString();
  }
  return normalizedValue
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function ThinkingValueSelect({
  selectedThinkingValue,
  thinkingValues,
  disabled,
  compact = false,
  compactWidth,
  onThinkingValueChange,
}: {
  selectedThinkingValue: string | null;
  thinkingValues: string[];
  disabled: boolean;
  compact?: boolean;
  compactWidth?: number;
  onThinkingValueChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  if (thinkingValues.length === 0 || !selectedThinkingValue) {
    return null;
  }
  const selectedThinkingLabel = displayThinkingValueLabel(
    selectedThinkingValue,
  );
  const showCompactLabel = !compact || typeof compactWidth !== "number";

  const renderOption = (value: string) => {
    const active = value === selectedThinkingValue;
    return (
      <button
        key={value}
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => {
          onThinkingValueChange(value);
          setOpen(false);
        }}
        className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
          active
            ? "bg-accent text-foreground"
            : "text-foreground hover:bg-accent"
        }`}
      >
        <span className="truncate">{displayThinkingValueLabel(value)}</span>
      </button>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              disabled={disabled}
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={
                    compact
                      ? `Reasoning effort: ${selectedThinkingLabel}`
                      : undefined
                  }
                  // size-7 square in icon-only compact mode so the
                  // trigger matches the +/Skills ComposerIconButton
                  // glyphs sitting on the same toolbar row. Other modes
                  // keep their gap-1.5 + px-2 / px-2.5 padding for the
                  // inline label layout.
                  className={`gap-1.5 rounded-md text-xs font-medium ${
                    compact
                      ? showCompactLabel
                        ? "w-full min-w-0 justify-between px-2.5"
                        : "size-7 min-w-0 justify-center !p-0"
                      : "px-2"
                  }`}
                />
              }
            />
          }
        >
          {compact ? (
            showCompactLabel ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <Lightbulb className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{selectedThinkingLabel}</span>
              </span>
            ) : (
              <Lightbulb className="size-3.5 shrink-0 text-muted-foreground" />
            )
          ) : (
            <span className="whitespace-nowrap">{selectedThinkingLabel}</span>
          )}
        </TooltipTrigger>
        <TooltipContent>Reasoning effort · {selectedThinkingLabel}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="max-w-40 gap-0 rounded-lg p-1 shadow-xs ring-0"
      >
        <div className="px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase text-muted-foreground">
          Reasoning effort
        </div>
        {thinkingValues.map((value) => renderOption(value))}
      </PopoverContent>
    </Popover>
  );
}
