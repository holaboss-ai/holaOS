import { FolderOpen, Plus } from "lucide-react";
import { KitEmoji } from "@/components/marketplace/KitEmoji";

interface RowProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onChange: () => void;
  changeLabel?: string;
}

function SourceRow({ icon, title, subtitle, onChange, changeLabel }: RowProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-fg-2 px-3.5 py-2.5 shadow-2xs">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background shadow-2xs">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {title}
        </div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <button
        className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:[box-shadow:none!important]"
        onClick={onChange}
        type="button"
      >
        {changeLabel ?? "Change"}
      </button>
    </div>
  );
}

export function TemplateCard({
  templateSourceMode,
  selectedMarketplaceTemplate,
  selectedTemplateFolder,
  onChangeKit,
  onChangeFolder,
}: {
  templateSourceMode: string;
  selectedMarketplaceTemplate: TemplateMetadataPayload | null;
  selectedTemplateFolder: TemplateFolderSelectionPayload | null;
  onChangeKit: () => void;
  onChangeFolder: () => void;
}) {
  if (templateSourceMode === "marketplace" && selectedMarketplaceTemplate) {
    const template = selectedMarketplaceTemplate;
    return (
      <SourceRow
        icon={<KitEmoji emoji={template.emoji} size={22} />}
        onChange={onChangeKit}
        subtitle={
          template.description ||
          template.apps.map((a) => a.name).join(", ") ||
          "Marketplace template"
        }
        title={template.name}
      />
    );
  }

  if (
    templateSourceMode === "empty" ||
    templateSourceMode === "empty_onboarding"
  ) {
    return (
      <SourceRow
        icon={<Plus className="size-4 text-muted-foreground" />}
        onChange={onChangeKit}
        subtitle="Empty workspace scaffold"
        title="Starting from scratch"
      />
    );
  }

  if (templateSourceMode === "local") {
    return (
      <SourceRow
        changeLabel="Change folder"
        icon={<FolderOpen className="size-4 text-muted-foreground" />}
        onChange={onChangeFolder}
        subtitle={selectedTemplateFolder?.rootPath || "No folder selected"}
        title={selectedTemplateFolder?.templateName || "Local template"}
      />
    );
  }

  return null;
}
