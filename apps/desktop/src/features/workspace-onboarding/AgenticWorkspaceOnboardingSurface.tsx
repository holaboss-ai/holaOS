import { OnboardingPane } from "@/components/panes/OnboardingPane";

interface AgenticWorkspaceOnboardingSurfaceProps {
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onSyncFileDisplayFromAgentOperation?: (path: string) => void;
  onImageAttachmentPreviewOpenChange?: (open: boolean) => void;
  focusRequestKey?: number;
}

export function AgenticWorkspaceOnboardingSurface({
  onOpenOutput,
  onSyncFileDisplayFromAgentOperation,
  onImageAttachmentPreviewOpenChange,
  focusRequestKey = 0,
}: AgenticWorkspaceOnboardingSurfaceProps) {
  return (
    <OnboardingPane
      onOpenOutput={onOpenOutput}
      onSyncFileDisplayFromAgentOperation={
        onSyncFileDisplayFromAgentOperation
      }
      onImageAttachmentPreviewOpenChange={
        onImageAttachmentPreviewOpenChange
      }
      focusRequestKey={focusRequestKey}
    />
  );
}
