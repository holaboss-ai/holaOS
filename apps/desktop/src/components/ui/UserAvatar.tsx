import { User2 } from "lucide-react";
import type { CSSProperties } from "react";

interface UserAvatarUser {
  id?: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

interface UserAvatarProps {
  user: UserAvatarUser | null;
  className?: string;
}

// Deterministic 8-color gradient palette. Each entry is [c1, c2, angle°].
// First one is the brand gradient so the product color makes an appearance.
const GRADIENT_PALETTE: ReadonlyArray<readonly [string, string, number]> = [
  ["#F58419", "#F12711", 135],
  ["#667EEA", "#764BA2", 135],
  ["#11998E", "#38EF7D", 135],
  ["#FC466B", "#3F5EFB", 135],
  ["#FDBB2D", "#22C1C3", 135],
  ["#EB3349", "#F45C43", 135],
  ["#3494E6", "#EC6EAD", 135],
  ["#00B09B", "#96C93D", 135],
];

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function pickGradient(seed: string) {
  return GRADIENT_PALETTE[hashSeed(seed) % GRADIENT_PALETTE.length];
}

export function UserAvatar({ user, className = "" }: UserAvatarProps) {
  if (!user || (!user.id && !user.image && !user.email)) {
    // Empty fallback: fill the parent + center an appropriately-sized
    // icon so callers that wrap us in a 28-40px circle don't get a tiny
    // 24px lucide default sitting top-left of an empty disk.
    return (
      <div
        className={`flex size-full items-center justify-center text-muted-foreground ${className}`.trim()}
      >
        <User2 className="size-1/2" />
      </div>
    );
  }

  if (user.image) {
    return (
      <img
        src={user.image}
        alt={user.name ?? "User avatar"}
        className={`size-full rounded-full object-cover ${className}`.trim()}
      />
    );
  }

  const seed = user.id || user.email || "anonymous";
  const [c1, c2, angle] = pickGradient(seed);
  const style: CSSProperties = {
    background: [
      "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.4), transparent 55%)",
      "radial-gradient(circle at 70% 78%, rgba(0,0,0,0.22), transparent 55%)",
      `linear-gradient(${angle}deg, ${c1}, ${c2})`,
    ].join(", "),
  };
  return (
    <div
      aria-hidden
      className={`size-full rounded-full ${className}`.trim()}
      style={style}
    />
  );
}
