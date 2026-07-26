import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Keyboard focus — opaque controls (buttons, switches, icon buttons). The
 *  offset ring reads against any fill, including the orange primary. */
export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
/** Keyboard focus — input fields. Border turns brand + a soft halo, no offset. */
export const focusRingField =
  "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30";
/** Keyboard focus — inline toggles/chips (tabs, badges). Tight inset ring. */
export const focusRingInset =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/55";
