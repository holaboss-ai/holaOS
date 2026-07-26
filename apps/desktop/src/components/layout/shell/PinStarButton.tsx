import { useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import { Star } from "@/components/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type FavoriteToggleInput,
  favoriteKey,
  isFavoriteAtom,
  toggleFavoriteAtom,
} from "./state/favorites";

// Shared "pin to favorites" star. One affordance across every surface that
// shows a savable thing (outputs, files, apps, urls, issues), so the gesture
// and pinned-state read identically everywhere. `notify` shows a toast when
// the shelf isn't in view (file preview, search); leave it off where the
// Pinned section is already visible (sidebar rows).
export function PinStarButton({
  favorite,
  notify = false,
  className,
}: {
  favorite: FavoriteToggleInput;
  notify?: boolean;
  className?: string;
}) {
  const toggleFavorite = useSetAtom(toggleFavoriteAtom);
  const isFavoriteFn = useAtomValue(isFavoriteAtom);
  const starred = isFavoriteFn(favoriteKey(favorite));
  const label = starred ? "Remove from favorites" : "Add to favorites";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              toggleFavorite(favorite);
              if (notify && !starred) {
                toast("Pinned");
              }
            }}
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded transition-colors hover:bg-foreground/8 hover:text-foreground",
              starred ? "text-foreground" : "text-muted-foreground",
              className,
            )}
          />
        }
      >
        <Star
          className={cn("size-3.5", starred && "fill-current")}
          strokeWidth={1.75}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="py-1">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
