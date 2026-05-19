import { Command as CommandPrimitive } from "cmdk";
import * as React from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

/**
 * MentionPicker — cmdk-backed list of mentionable entities, designed
 * to sit inside a caret-anchored popover. Layout-agnostic: the host
 * composer owns positioning (textarea ref + caret coords).
 *
 * Why standalone (not wrapped in Popover): mentions are caret-anchored,
 * not button-anchored. The host composer fires the picker on every
 * keystroke after `@`, with `query` being the text typed since. We
 * mirror `query` into a screen-reader-only CommandInput so cmdk's
 * filter runs against it without rendering a visible search box —
 * the textarea is the visible input.
 */
export interface MentionItem {
  /** Stable identifier — what gets inserted into the composer. */
  id: string;
  /** Visible label. ReactNode to allow icon + name composition. */
  label: React.ReactNode;
  /** Optional secondary line shown below the label. */
  description?: React.ReactNode;
  /** Plain-text aliases for fuzzy match. Recommended when `label`
   *  is JSX (icon-wrapped name) since cmdk's text extraction can
   *  miss the name through nested elements. */
  keywords?: string[];
  /** Disable selection without removing from list. */
  disabled?: boolean;
}

export interface MentionGroup {
  heading?: React.ReactNode;
  items: MentionItem[];
}

export interface MentionPickerProps {
  /** Either a flat list (single implicit group) or pre-grouped. */
  items: MentionItem[] | MentionGroup[];
  /** Current search query — text after the trigger character. */
  query: string;
  /** Fires with the selected item's id. Caller inserts the mention
   *  and dismisses the picker. */
  onSelect: (id: string) => void;
  /** Empty-state label. */
  emptyText?: string;
  /** Width override; default 280px. */
  width?: number;
  className?: string;
}

function isGrouped(
  items: MentionItem[] | MentionGroup[],
): items is MentionGroup[] {
  return items.length > 0 && "items" in items[0];
}

export function MentionPicker({
  items,
  query,
  onSelect,
  emptyText = "No matches.",
  width = 280,
  className,
}: MentionPickerProps) {
  const groups: MentionGroup[] = isGrouped(items) ? items : [{ items }];

  return (
    <Command
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg",
        className,
      )}
      style={{ width }}
    >
      <CommandPrimitive.Input
        value={query}
        onValueChange={() => {
          /* host composer drives query via its textarea — we just mirror */
        }}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />
      <CommandList>
        <CommandEmpty>{emptyText}</CommandEmpty>
        {groups.map((group, groupIndex) => (
          <CommandGroup
            // biome-ignore lint/suspicious/noArrayIndexKey: groups are caller-defined and stable per render
            key={groupIndex}
            heading={group.heading}
            className="p-1"
          >
            {group.items.map((item) => (
              <CommandItem
                key={item.id}
                value={item.id}
                keywords={item.keywords}
                disabled={item.disabled}
                onSelect={() => onSelect(item.id)}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">{item.label}</span>
                  {item.description ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}
