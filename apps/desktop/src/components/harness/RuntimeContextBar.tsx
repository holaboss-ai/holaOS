import { cn } from "@/lib/utils";
import { HarnessPicker } from "./HarnessPicker";

/**
 * Quiet runtime-context footer that visually attaches to the bottom of the
 * composer on new-session surfaces (the gray tray peeking out from beneath).
 * The harness is the subject on the left ("Running in Hola ▾").
 */
export function RuntimeContextBar({
  selectedHarnessId,
  harnesses,
  harnessesLoading,
  onHarnessChange,
  className,
}: {
  selectedHarnessId: string;
  harnesses: HarnessAvailabilityEntryPayload[];
  harnessesLoading?: boolean;
  onHarnessChange: (id: string) => void;
  workspaceHint?: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-3 rounded-b-2xl bg-muted px-3.5 pt-2 pb-2.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">Running in</span>
        <HarnessPicker
          harnesses={harnesses}
          inline
          isLoading={harnessesLoading}
          onChange={onHarnessChange}
          value={selectedHarnessId}
        />
      </span>
    </div>
  );
}
