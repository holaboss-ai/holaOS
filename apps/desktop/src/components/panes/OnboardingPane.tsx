import { ChatPane } from "@/components/panes/ChatPane";

export function OnboardingPane({
  onOpenOutput,
  onSyncFileDisplayFromAgentOperation,
  onImageAttachmentPreviewOpenChange,
  focusRequestKey = 0
}: {
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onSyncFileDisplayFromAgentOperation?: (path: string) => void;
  onImageAttachmentPreviewOpenChange?: (open: boolean) => void;
  focusRequestKey?: number;
}) {
  return (
    <ChatPane
      onOpenOutput={onOpenOutput}
      onSyncFileDisplayFromAgentOperation={
        onSyncFileDisplayFromAgentOperation
      }
      onImageAttachmentPreviewOpenChange={
        onImageAttachmentPreviewOpenChange
      }
      focusRequestKey={focusRequestKey}
      variant="onboarding"
    />
  );
}
