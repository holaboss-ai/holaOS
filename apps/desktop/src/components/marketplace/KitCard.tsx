import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { KitEmoji } from "./KitEmoji";

interface KitCardProps {
  template: TemplateMetadataPayload;
  onClick: (template: TemplateMetadataPayload) => void;
  selected?: boolean;
}

export function KitCard({ template, onClick, selected = false }: KitCardProps) {
  const isComingSoon = template.is_coming_soon;
  const displayName = template.display_name ?? template.name.replaceAll("_", " ");

  return (
    <button
      type="button"
      disabled={isComingSoon}
      onClick={() => onClick(template)}
      className={cn(
        "group relative flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
        isComingSoon
          ? "cursor-default opacity-50"
          : selected
            ? "bg-primary/10"
            : "hover:bg-fg-2",
      )}
    >
      <KitEmoji emoji={template.emoji} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          {isComingSoon ? (
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
            >
              Coming soon
            </Badge>
          ) : null}
        </div>
        {template.description ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {template.description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {template.install_count != null && template.install_count > 0 ? (
          <span>{template.install_count} installs</span>
        ) : template.apps.length > 0 ? (
          <span>{template.apps.length} apps</span>
        ) : null}
      </div>
    </button>
  );
}
