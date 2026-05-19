import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "./SettingsRow";

interface SettingsToggleProps {
  label: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

/**
 * SettingsToggle
 *
 * SettingsRow + a switch on the right. Used for boolean preferences
 * (extended context, prompt cache, telemetry opt-in, etc.).
 */
export function SettingsToggle({
  label,
  description,
  leading,
  checked,
  onCheckedChange,
  disabled,
}: SettingsToggleProps) {
  return (
    <SettingsRow label={label} description={description} leading={leading}>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </SettingsRow>
  );
}
