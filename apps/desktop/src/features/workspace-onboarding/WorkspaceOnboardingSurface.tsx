import { X } from "lucide-react";
import { useState } from "react";
import { AgenticWorkspaceOnboardingSurface } from "@/features/workspace-onboarding/AgenticWorkspaceOnboardingSurface";
import { DeterministicWorkspaceOnboardingSurface } from "@/features/workspace-onboarding/DeterministicWorkspaceOnboardingSurface";
import { Button } from "@/components/ui/button";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

interface WorkspaceOnboardingSurfaceProps {
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onSyncFileDisplayFromAgentOperation?: (path: string) => void;
  onImageAttachmentPreviewOpenChange?: (open: boolean) => void;
  focusRequestKey?: number;
}

export function WorkspaceOnboardingSurface({
  onOpenOutput,
  onSyncFileDisplayFromAgentOperation,
  onImageAttachmentPreviewOpenChange,
  focusRequestKey = 0,
}: WorkspaceOnboardingSurfaceProps) {
  const { onboardingEngine, skipWorkspaceOnboarding } = useWorkspaceDesktop();
  const [isSkipping, setIsSkipping] = useState(false);

  async function handleSkipOnboarding() {
    setIsSkipping(true);
    try {
      await skipWorkspaceOnboarding();
    } finally {
      setIsSkipping(false);
    }
  }

  if (!onboardingEngine) {
    return null;
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1">
      {onboardingEngine === "agentic" ? (
        <div className="pointer-events-none absolute top-4 right-4 z-20 sm:top-6 sm:right-6">
          <div className="pointer-events-auto rounded-full border border-border/70 bg-background/88 p-1 shadow-[0_16px_48px_rgba(15,23,42,0.08)] backdrop-blur">
            <Button
              aria-label="Skip onboarding"
              disabled={isSkipping}
              onClick={() => {
                void handleSkipOnboarding();
              }}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X />
            </Button>
          </div>
        </div>
      ) : null}

      {onboardingEngine === "agentic" ? (
        <AgenticWorkspaceOnboardingSurface
          onOpenOutput={onOpenOutput}
          onSyncFileDisplayFromAgentOperation={
            onSyncFileDisplayFromAgentOperation
          }
          onImageAttachmentPreviewOpenChange={
            onImageAttachmentPreviewOpenChange
          }
          focusRequestKey={focusRequestKey}
        />
      ) : (
        <DeterministicWorkspaceOnboardingSurface />
      )}
    </div>
  );
}
