import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { remoteApiQuery } from "@/lib/remoteApiQuery";

export function CapabilityImportPane({
  onImported,
  onClose,
}: {
  onImported: (capabilityId: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [pluginPath, setPluginPath] = useState("");
  const importMutation = useMutation(
    remoteApiQuery.capabilities.importPlugin.mutationOptions(),
  );

  const submit = () => {
    const trimmed = pluginPath.trim();
    if (!trimmed || importMutation.isPending) {
      return;
    }
    importMutation.mutate(
      { pluginPath: trimmed },
      {
        onSuccess: (record) => {
          queryClient.invalidateQueries({
            queryKey: remoteApiQuery.capabilities.key(),
          });
          onImported(record.capabilityId);
        },
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-semibold text-foreground">Import a plugin</span>
        <Button aria-label="Close" onClick={onClose} size="icon-sm" variant="ghost">
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Import a Claude or Codex plugin folder as a capability. Its skills are
            copied into your workspace; connect any tools it needs afterward.
          </p>
          <Input
            aria-label="Plugin folder path"
            onChange={(event) => setPluginPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                submit();
              }
            }}
            placeholder="/path/to/the-plugin"
            value={pluginPath}
          />
          {importMutation.isError ? (
            <p className="text-xs text-destructive">
              {importMutation.error instanceof Error
                ? importMutation.error.message
                : "Could not import that plugin."}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              disabled={!pluginPath.trim() || importMutation.isPending}
              onClick={submit}
              size="sm"
            >
              {importMutation.isPending ? "Importing…" : "Import"}
            </Button>
            <Button onClick={onClose} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
