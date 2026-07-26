import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { Button } from "@/components/ui/button";
import { Info, MessageCircle } from "@/components/ui/icons";
import type { AutomationExample } from "@/components/panes/automationExamples";

/**
 * Example preview — shows what the automation would produce before anything
 * is created or a chat turn is spent. "Set up" hands off to the prefilled
 * manual create dialog; "Customize with Hola" is the conversational path.
 */
export function AutomationExamplePreviewDialog({
  example,
  onOpenChange,
  onSetUp,
  onCustomizeWithHola,
}: {
  example: AutomationExample | null;
  onOpenChange: (open: boolean) => void;
  onSetUp: (example: AutomationExample) => void;
  onCustomizeWithHola: (example: AutomationExample) => void;
}) {
  return (
    <DialogPrimitive.Root open={example !== null} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[12%] left-1/2 z-[100] w-[520px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          {example ? (
            <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-5">
              <div className="space-y-1">
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  {example.name}
                </DialogPrimitive.Title>
                <p className="text-sm text-muted-foreground">
                  {example.benefit} · {example.scheduleHint}
                </p>
              </div>

              <div className="grid gap-1.5">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Sample output
                </div>
                <div className="rounded-lg border border-border bg-card px-4 py-3.5">
                  <div className="text-sm font-medium text-foreground">
                    {example.sample.title}
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {example.sample.intro}
                  </p>
                  <ul className="mt-2.5 grid gap-1.5">
                    {example.sample.bullets.map((bullet) => (
                      <li
                        key={bullet.label}
                        className="text-xs leading-5 text-muted-foreground"
                      >
                        <span className="font-medium text-foreground">
                          {bullet.label}:
                        </span>{" "}
                        {bullet.text}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="flex items-start gap-1.5 rounded-lg border border-border bg-fg-2 px-3 py-2 text-xs leading-5 text-muted-foreground">
                <Info className="mt-1 size-3.5 shrink-0" />
                <span>
                  Set up creates it directly — you can tweak the instruction,
                  schedule, and project first. Nothing runs until you say so.
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground hover:text-foreground"
                  onClick={() => onCustomizeWithHola(example)}
                >
                  <MessageCircle className="size-3.5" />
                  Customize with Hola
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenChange(false)}
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onSetUp(example)}
                  >
                    Set up
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
