import { ReactNode } from "react";

import { focusRing } from "@/lib/utils";

interface IconButtonProps {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export function IconButton({
  icon,
  label,
  active = false,
  onClick,
  disabled = false,
  className = ""
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded-md border transition-[color,background-color,border-color,filter] duration-150 ease-out active:brightness-95 ${focusRing} ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""} ${className}`}
    >
      {icon}
    </button>
  );
}
