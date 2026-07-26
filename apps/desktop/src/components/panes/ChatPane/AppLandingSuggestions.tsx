import { HolaAppIcon } from "@/components/layout/shell/HolaAppIcon";
import { ArrowRight } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";

interface AppLandingSuggestionsProps {
  /** App-tailored starter prompts (from the catalogue `landing.prompts`). */
  prompts: string[];
  /** The owning app's title — drives the "TRY IN <APP>" section label. */
  appTitle: string;
  /** The owning app's favicon, shown before each prompt. */
  appIconUrl?: string;
  /** Fires when a prompt is picked (parent sends it as the first message). */
  onSelect: (prompt: string) => void;
  className?: string;
}

/**
 * The app-tailored counterpart to PersonalizedSuggestions: for a session opened
 * UNDER a HolaApp, the empty state suggests things to do IN that app instead of
 * the generic workspace prompts. Content is backend-managed (catalogue
 * `landing.prompts`), so this component is purely presentational.
 */
export function AppLandingSuggestions({
  prompts,
  appTitle,
  appIconUrl,
  onSelect,
  className = "w-full px-1 pt-3",
}: AppLandingSuggestionsProps) {
  if (prompts.length === 0) {
    return null;
  }
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={className}
      initial={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
        Try in {appTitle}
      </div>
      <div className="flex flex-col">
        {prompts.map((prompt, index) => (
          <motion.button
            animate={{ opacity: 1, y: 0 }}
            className={cn(
              "group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
              "hover:bg-fg-4",
            )}
            initial={{ opacity: 0, y: 4 }}
            key={prompt}
            onClick={() => onSelect(prompt)}
            transition={{
              duration: 0.28,
              delay: index * 0.04,
              ease: [0.22, 1, 0.36, 1],
            }}
            type="button"
            whileHover={{ y: -0.5 }}
            whileTap={{ scale: 0.997 }}
          >
            <span className="grid size-5 shrink-0 place-items-center">
              <HolaAppIcon iconUrl={appIconUrl} sizeClass="size-3.5" title={appTitle} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85 group-hover:text-foreground">
              {prompt}
            </span>
            <span className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60">
              <ArrowRight className="size-3" />
            </span>
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}
