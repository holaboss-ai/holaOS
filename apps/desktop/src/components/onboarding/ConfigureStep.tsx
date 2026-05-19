import { Folder, FolderOpen, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IntegrationsList } from "./IntegrationsList";
import { TemplateCard } from "./TemplateCard";
import {
  WizardField,
  WorkspaceWizardLayout,
} from "./WorkspaceWizardLayout";

interface ConfigureStepProps {
  stepIndex: number;
  stepTotal: number;
  templateSourceMode: string;
  selectedMarketplaceTemplate: TemplateMetadataPayload | null;
  selectedTemplateFolder: TemplateFolderSelectionPayload | null;
  selectedWorkspaceFolder: WorkspaceRuntimeFolderSelectionPayload | null;
  newWorkspaceName: string;
  setNewWorkspaceName: (value: string) => void;
  pendingIntegrations: ResolveTemplateIntegrationsResult | null;
  isResolvingIntegrations: boolean;
  connectingProvider: string | null;
  connectStatus: string;
  workspaceErrorMessage: string;
  continueDisabled: boolean;
  hasUnconnectedIntegrations: boolean;
  onChangeKit: () => void;
  onChangeFolder: () => void;
  onChooseWorkspaceFolder: () => void;
  onClearWorkspaceFolder: () => void;
  defaultWorkspaceRoot: string | null;
  onCancel: () => void;
  onConnect: (provider: string) => void;
  onContinue: () => void;
}

export function ConfigureStep({
  stepIndex,
  stepTotal,
  templateSourceMode,
  selectedMarketplaceTemplate,
  selectedTemplateFolder,
  selectedWorkspaceFolder,
  newWorkspaceName,
  setNewWorkspaceName,
  pendingIntegrations,
  isResolvingIntegrations,
  connectingProvider,
  connectStatus,
  workspaceErrorMessage,
  continueDisabled,
  hasUnconnectedIntegrations,
  onChangeKit,
  onChangeFolder,
  onChooseWorkspaceFolder,
  onClearWorkspaceFolder,
  defaultWorkspaceRoot,
  onCancel,
  onConnect,
  onContinue,
}: ConfigureStepProps) {
  const primaryDisabled =
    continueDisabled ||
    hasUnconnectedIntegrations ||
    isResolvingIntegrations ||
    connectingProvider !== null;

  return (
    <WorkspaceWizardLayout
      description="Pick a name and where the workspace files live. We'll set up the rest."
      errorMessage={workspaceErrorMessage || null}
      primary={{
        label: "Continue",
        onClick: onContinue,
        disabled: primaryDisabled,
      }}
      secondary={
        stepIndex > 1
          ? {
              label: "Back",
              onClick: onChangeKit,
            }
          : undefined
      }
      stepIndex={stepIndex}
      stepTotal={stepTotal}
      tertiary={{ label: "Cancel", onClick: onCancel }}
      title="Name your workspace"
      width="md"
    >
      <div className="space-y-5">
        {/* Source summary */}
        <TemplateCard
          onChangeFolder={onChangeFolder}
          onChangeKit={onChangeKit}
          selectedMarketplaceTemplate={selectedMarketplaceTemplate}
          selectedTemplateFolder={selectedTemplateFolder}
          templateSourceMode={templateSourceMode}
        />

        <WizardField htmlFor="workspace-name" label="Workspace name" required>
          <div className="rounded-lg bg-fg-2 shadow-2xs transition-colors focus-within:bg-background focus-within:shadow-xs">
            <Input
              autoFocus
              className="h-10 border-0 bg-transparent shadow-none focus-visible:ring-0"
              id="workspace-name"
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="My first workspace"
              value={newWorkspaceName}
            />
          </div>
        </WizardField>

        <WizardField
          help={
            selectedWorkspaceFolder?.rootPath ? (
              "Workspace files will live in the folder above."
            ) : defaultWorkspaceRoot ? (
              <>
                Defaults to{" "}
                <code className="rounded bg-fg-4 px-1 py-0.5 font-mono text-[11px]">
                  {defaultWorkspaceRoot}/workspace/&lt;id&gt;
                </code>
                . Pick a folder if you'd rather keep the files somewhere you
                control.
              </>
            ) : (
              "Pick an empty folder if you'd rather keep the workspace files on a drive you control."
            )
          }
          label="Workspace folder"
          optional
        >
          {selectedWorkspaceFolder?.rootPath ? (
            <div className="flex items-center gap-2 rounded-lg bg-fg-2 px-3 py-2 shadow-2xs">
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              <span
                className="flex-1 truncate text-sm text-foreground"
                title={selectedWorkspaceFolder.rootPath}
              >
                {selectedWorkspaceFolder.rootPath}
              </span>
              <Button
                aria-label="Clear workspace folder"
                onClick={onClearWorkspaceFolder}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <X />
              </Button>
            </div>
          ) : (
            <Button
              className="w-full justify-start"
              onClick={onChooseWorkspaceFolder}
              size="lg"
              type="button"
              variant="bordered"
            >
              <Folder className="text-muted-foreground" />
              Choose an empty folder…
            </Button>
          )}
        </WizardField>

        <IntegrationsList
          connectStatus={connectStatus}
          connectingProvider={connectingProvider}
          isResolvingIntegrations={isResolvingIntegrations}
          onConnect={onConnect}
          pendingIntegrations={pendingIntegrations}
        />
      </div>
    </WorkspaceWizardLayout>
  );
}
