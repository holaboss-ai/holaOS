import { FolderOpen, FolderX, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

import { BlockingErrorScreen } from "@/components/layout/BlockingErrorScreen";
import { Button } from "@/components/ui/button";

interface MissingWorkspacePaneProps {
  workspaceName: string;
  workspacePath: string | null;
  onRelocate: () => Promise<void>;
  onDeleteRecord: () => Promise<void>;
}

export function MissingWorkspacePane({
  workspaceName,
  workspacePath,
  onRelocate,
  onDeleteRecord,
}: MissingWorkspacePaneProps) {
  const [isRelocating, setIsRelocating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleRelocate() {
    if (isRelocating || isDeleting) {
      return;
    }
    setIsRelocating(true);
    try {
      await onRelocate();
    } finally {
      setIsRelocating(false);
    }
  }

  async function handleDelete() {
    if (isRelocating || isDeleting) {
      return;
    }
    const confirmed = window.confirm(
      `Remove "${workspaceName}" from Holaboss?\n\nYour files on disk will not be touched. Only this workspace record is removed.`,
    );
    if (!confirmed) {
      return;
    }
    setIsDeleting(true);
    try {
      await onDeleteRecord();
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <BlockingErrorScreen
      actions={
        <>
          <Button
            className="flex-1"
            disabled={isRelocating || isDeleting}
            onClick={() => void handleRelocate()}
            size="lg"
            type="button"
          >
            {isRelocating ? (
              <Loader2 className="animate-spin" />
            ) : (
              <FolderOpen />
            )}
            Relocate to a folder…
          </Button>
          <Button
            disabled={isRelocating || isDeleting}
            onClick={() => void handleDelete()}
            size="lg"
            type="button"
            variant="bordered"
          >
            {isDeleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Remove
          </Button>
        </>
      }
      description={
        <>
          Holaboss can't find the folder for{" "}
          <span className="font-medium text-foreground">{workspaceName}</span>.
          It may have been moved, deleted, or live on a drive that isn't
          mounted right now.
        </>
      }
      technicalDetail={workspacePath ?? undefined}
      hint="Pick the original folder if you moved it, or an empty folder to start fresh."
      icon={FolderX}
      title="Workspace folder is missing"
      tone="warning"
    />
  );
}
