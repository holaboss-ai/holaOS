import type { ReactNode } from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { SettingsRow } from "./SettingsRow";

export interface SettingsMenuOption extends ComboboxOption {}

interface SettingsMenuSelectRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Optional leading visual (icon). */
  leading?: ReactNode;
  /** Currently selected value. */
  value: string;
  onValueChange: (value: string) => void;
  options: SettingsMenuOption[];
  /** Disable the whole control (read-only display). */
  disabled?: boolean;
  /** Empty-state placeholder shown when no value matches an option. */
  placeholder?: string;
  /** Force-enable the search input. Defaults to auto (>8 options). */
  searchable?: boolean;
  /** Override the default 280px menu width. */
  menuWidth?: number;
  /** Fires for live-preview pickers (theme, model) on cursor/keyboard hover. */
  onHover?: (value: string | null) => void;
  /** Override the default search placeholder. */
  searchPlaceholder?: string;
  /** Override the default empty-results text. */
  emptyText?: string;
}

export function SettingsMenuSelectRow({
  label,
  description,
  leading,
  value,
  onValueChange,
  options,
  disabled,
  placeholder,
  searchable,
  menuWidth,
  onHover,
  searchPlaceholder,
  emptyText,
}: SettingsMenuSelectRowProps) {
  return (
    <SettingsRow label={label} description={description} leading={leading}>
      <Combobox
        value={value}
        onValueChange={onValueChange}
        options={options}
        placeholder={placeholder}
        disabled={disabled}
        searchable={searchable}
        menuWidth={menuWidth}
        onHover={onHover}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
      />
    </SettingsRow>
  );
}
