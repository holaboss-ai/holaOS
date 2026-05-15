import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom, type PrimitiveAtom } from "jotai";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { ArtifactsPane } from "@/components/panes/ArtifactsPane";
import { AutomationsPane } from "@/components/panes/AutomationsPane";
import { SubagentSessionsPane } from "@/components/panes/SubagentSessionsPane";
import { Button } from "@/components/ui/button";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  artifactsOpenAtom,
  automationsOpenAtom,
  sessionsOpenAtom,
} from "./state/ui";

export function Overlays() {
  return (
    <>
      <ArtifactsOverlay />
      <AutomationsOverlay />
      <SessionsOverlay />
    </>
  );
}

function PaneOverlay({
  openAtom,
  title,
  children,
}: {
  openAtom: PrimitiveAtom<boolean>;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useAtom(openAtom);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          style={{
            animationDuration: "180ms",
            animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
        <DialogPrimitive.Popup
          className="fixed inset-x-[8%] inset-y-[8%] z-[100] flex flex-col overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl outline-none backdrop-blur-2xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          style={{
            animationDuration: "220ms",
            animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="text-sm font-medium">{title}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="text-foreground/60"
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ArtifactsOverlay() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  return (
    <PaneOverlay openAtom={artifactsOpenAtom} title="Artifacts">
      <ArtifactsPane workspaceId={selectedWorkspaceId || null} />
    </PaneOverlay>
  );
}

function AutomationsOverlay() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  return (
    <PaneOverlay openAtom={automationsOpenAtom} title="Automations">
      <AutomationsPane workspaceId={selectedWorkspaceId || null} />
    </PaneOverlay>
  );
}

function SessionsOverlay() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  return (
    <PaneOverlay openAtom={sessionsOpenAtom} title="Sessions">
      <SubagentSessionsPane workspaceId={selectedWorkspaceId || null} />
    </PaneOverlay>
  );
}
