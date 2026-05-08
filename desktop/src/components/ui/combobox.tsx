import { CheckIcon, ChevronDownIcon } from "lucide-react";
import * as React from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Plain-text keywords used by the fuzzy filter (cmdk). Falls back to
   *  the rendered text from `label` when absent. */
  keywords?: string[];
  disabled?: boolean;
}

export interface ComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: React.ReactNode;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Show the search input. Auto-enabled when options.length exceeds
   *  `searchThreshold` (default 8). */
  searchable?: boolean;
  searchThreshold?: number;
  menuWidth?: number;
  /** Fired with the value the cursor/keyboard is currently on, or null
   *  when nothing is hovered. Useful for live-preview pickers (theme,
   *  model). */
  onHover?: (value: string | null) => void;
  disabled?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
  align?: "start" | "center" | "end";
  sideOffset?: number;
}

export function Combobox({
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  searchable,
  searchThreshold = 8,
  menuWidth = 280,
  onHover,
  disabled,
  triggerClassName,
  contentClassName,
  align = "end",
  sideOffset = 6,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const showSearch = searchable ?? options.length > searchThreshold;
  const selected = options.find((o) => o.value === value);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      onHover?.(null);
    }
  }

  function handleSelect(next: string) {
    onValueChange(next);
    setOpen(false);
    onHover?.(null);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        data-slot="combobox-trigger"
        data-state={open ? "open" : "closed"}
        className={cn(
          "inline-flex h-8 w-fit items-center justify-between gap-1.5 rounded-lg bg-muted/50 py-1 pr-2 pl-2.5 text-sm text-foreground whitespace-nowrap select-none transition-colors outline-none hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-muted/70 [&>svg]:pointer-events-none [&>svg]:shrink-0",
          triggerClassName,
        )}
      >
        <span className="line-clamp-1 flex flex-1 items-center gap-1.5 text-left">
          {selected?.label ?? (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "overflow-hidden border-foreground/10 p-0 shadow-lg",
          contentClassName,
        )}
        style={{ width: menuWidth }}
      >
        <Command>
          {showSearch ? (
            <CommandInput placeholder={searchPlaceholder} />
          ) : null}
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup className="p-1">
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={option.keywords}
                    disabled={option.disabled}
                    onSelect={handleSelect}
                    onMouseEnter={() => onHover?.(option.value)}
                    onFocus={() => onHover?.(option.value)}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate">{option.label}</span>
                      {option.description ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </div>
                    <CheckIcon
                      className={cn(
                        "ml-2 size-4 shrink-0 text-foreground/80 transition-opacity",
                        isSelected ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
