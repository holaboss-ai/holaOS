// The identity badge for a HolaEmployee. The permanent preset "Hola" employee IS
// the product's own agent, so it wears the canonical Hola mascot (the same hosted
// image the ChatPane uses for the Hola brain, and the web roster uses for the preset
// card) rather than an arbitrary derived emoji — that's the "Hola icon" users expect
// to see, identical everywhere. Every other employee gets its deterministic color +
// emoji (or name initial). `className` carries size + rounding so callers keep their
// own dimensions/shape.

import { HOLA_AVATAR_URL } from "@/components/ui/agent-avatar";

type EmployeeAvatarProps = {
  avatar?: { color: string; emoji: string } | null;
  name: string;
  preset?: boolean;
  className?: string;
};

export function EmployeeAvatar({
  avatar,
  name,
  preset,
  className = "",
}: EmployeeAvatarProps) {
  if (preset) {
    return (
      <img
        alt="Hola"
        className={`shrink-0 select-none object-cover ${className}`}
        decoding="async"
        loading="lazy"
        src={HOLA_AVATAR_URL}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center leading-none ${className}`}
      style={{ backgroundColor: avatar?.color ?? "hsl(var(--muted))" }}
    >
      {avatar?.emoji ?? name.slice(0, 1).toUpperCase()}
    </span>
  );
}
