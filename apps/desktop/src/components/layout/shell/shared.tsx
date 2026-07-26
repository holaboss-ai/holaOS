import { cn } from "@/lib/utils";

export function SectionLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-1 text-xs font-medium tracking-wide text-foreground/40 uppercase",
        className,
      )}
    >
      {children}
    </div>
  );
}
