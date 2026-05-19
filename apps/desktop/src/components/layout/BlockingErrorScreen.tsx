import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Check, ChevronRight, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type BlockingErrorTone = "error" | "warning" | "info";

interface BlockingErrorScreenProps {
  /** Drives the small accent on the status icon. Defaults to "error". */
  tone?: BlockingErrorTone;
  /** Replace the default AlertTriangle when a more specific icon fits. */
  icon?: LucideIcon;
  /**
   * Spin the icon — used for "blocked but recovering" states like the
   * workspace-apps initializing gate. Adds `animate-spin` to the icon node.
   */
  iconSpinning?: boolean;
  title: string;
  description?: ReactNode;
  /**
   * Engineer-facing context: paths, raw error messages, "check runtime.log"
   * hints. Hidden behind a "Show technical details" disclosure so a normal
   * user doesn't have to read it. Auto-expanded in dev (Vite `import.meta.
   * env.DEV`) so we still see it without clicking while iterating.
   *
   * Pass a string when possible — string content gets a Copy-to-clipboard
   * button so support handoffs are one click. ReactNode also accepted for
   * cases that need richer formatting (per-app failure lists, etc.).
   */
  technicalDetail?: ReactNode;
  /**
   * Domain-specific block rendered between description and actions —
   * used by the per-app status list, etc. Author owns its layout.
   */
  body?: ReactNode;
  /**
   * Buttons / links. Compose with shadcn `<Button>` and the parent picks
   * size + variant. Stacked on narrow widths via `flex-col sm:flex-row`.
   */
  actions?: ReactNode;
  /** A subtle one-liner under the actions for "where to look next" hints. */
  hint?: ReactNode;
}

const TONE_STYLES: Record<
  BlockingErrorTone,
  { iconWrap: string; icon: string }
> = {
  error: {
    iconWrap: "ring-destructive/20 bg-destructive/8",
    icon: "text-destructive",
  },
  warning: {
    iconWrap: "ring-warning/22 bg-warning/10",
    icon: "text-warning",
  },
  info: {
    iconWrap: "ring-border bg-muted",
    icon: "text-muted-foreground",
  },
};

/**
 * Full-screen blocker shown when the desktop shell genuinely can't proceed
 * (renderer crash, runtime missing, workspace folder unmounted). Reuses the
 * same `bg-fg-2` canvas + centered card vocabulary as the publish + onboarding
 * full-screen flows so a hard-block doesn't visually splinter from the rest
 * of the app. Stay restrained: small icon, no destructive fill, no radial
 * gradients — the title carries the weight. Engineer-facing context lives
 * behind a "Show technical details" disclosure so normal users aren't
 * staring at file paths and log filenames.
 */
export function BlockingErrorScreen({
  tone = "error",
  icon,
  iconSpinning = false,
  title,
  description,
  technicalDetail,
  body,
  actions,
  hint,
}: BlockingErrorScreenProps) {
  const Icon = icon ?? AlertTriangle;
  const toneStyle = TONE_STYLES[tone];

  return (
    <section className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-y-auto bg-fg-2 px-6 py-12">
      <div className="w-full max-w-md">
        <div className="rounded-2xl bg-background p-8 shadow-xs ring-1 ring-border/40 sm:p-10">
          <div
            className={cn(
              "flex size-9 items-center justify-center rounded-full ring-1",
              toneStyle.iconWrap,
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                "size-4",
                toneStyle.icon,
                iconSpinning && "animate-spin",
              )}
            />
          </div>

          <h2 className="mt-5 text-xl font-semibold tracking-tight text-foreground sm:text-[22px]">
            {title}
          </h2>

          {description ? (
            <div className="mt-2 text-sm leading-6 text-muted-foreground">
              {description}
            </div>
          ) : null}

          {body ? <div className="mt-5">{body}</div> : null}

          {actions ? (
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">{actions}</div>
          ) : null}

          {technicalDetail ? <TechnicalDetail content={technicalDetail} /> : null}

          {hint ? (
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              {hint}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * Collapsible "Show technical details" disclosure. Closed by default in
 * production so a normal user never sees the engineer-facing copy; open by
 * default in dev so we don't have to click every time during development.
 * Native `<details>` for accessibility + zero-state-machine simplicity.
 */
function TechnicalDetail({ content }: { content: ReactNode }) {
  const defaultOpen = Boolean(import.meta.env.DEV);
  const [copied, setCopied] = useState(false);
  const isCopyable = typeof content === "string";

  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>) {
    // Stop the click from bubbling into the <summary> and toggling open state.
    event.preventDefault();
    event.stopPropagation();
    if (!isCopyable) {
      return;
    }
    try {
      await navigator.clipboard.writeText(content as string);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail in some sandboxed contexts; silent is fine —
      // the user can still select-and-copy from the rendered detail block.
    }
  }

  return (
    <details className="group mt-6" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md py-1 text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5">
          <ChevronRight
            aria-hidden
            className="size-3 transition-transform group-open:rotate-90"
          />
          Show technical details
        </span>
        {isCopyable ? (
          <Button
            aria-label="Copy technical details"
            className="hidden group-open:inline-flex"
            onClick={handleCopy}
            size="xs"
            type="button"
            variant="ghost"
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}
      </summary>
      <div className="mt-2 overflow-hidden rounded-lg bg-fg-2 px-3.5 py-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-foreground/85">
        {content}
      </div>
    </details>
  );
}
