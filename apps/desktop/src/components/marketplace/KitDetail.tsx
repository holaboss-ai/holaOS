import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KitEmoji } from "./KitEmoji";
import { SimpleMarkdown } from "./SimpleMarkdown";
import { templateReadmes } from "./templateReadmes";

interface KitDetailProps {
  template: TemplateMetadataPayload;
  onBack: () => void;
  onSelect: (template: TemplateMetadataPayload) => void;
  selectLabel?: string;
  selectDisabled?: boolean;
  selectDisabledReason?: string;
  onSignIn?: () => void;
}

export function KitDetail({
  template,
  onBack,
  onSelect,
  selectLabel = "Use this template",
  selectDisabled = false,
  selectDisabledReason,
  onSignIn,
}: KitDetailProps) {
  const readme = templateReadmes[template.name] || template.long_description;
  const displayName = template.display_name ?? template.name.replaceAll("_", " ");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {/* Back */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="mb-5 self-start"
      >
        <ArrowLeft size={13} />
        Back to templates
      </Button>

      {/* Header */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex size-16 shrink-0 items-center justify-center rounded-2xl border border-border bg-muted">
            <KitEmoji emoji={template.emoji} size={40} />
          </div>
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold capitalize tracking-tight text-foreground">
              {displayName}
            </h2>
            {template.description ? (
              <p className="mt-1.5 max-w-[560px] text-sm leading-relaxed text-muted-foreground">
                {template.description}
              </p>
            ) : null}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {template.install_count != null && template.install_count > 0 ? (
                <Badge variant="secondary">
                  {template.install_count} installs
                </Badge>
              ) : null}
              {template.source === "official" || template.verified ? (
                <Badge variant="outline" className="border-info/25 text-info">
                  Official
                </Badge>
              ) : null}
              {template.apps.length > 0 ? (
                <Badge variant="secondary">
                  {template.apps.map((a) => a.name).join(" · ")}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="shrink-0 sm:mt-1">
          {selectDisabled && onSignIn ? (
            <Button size="lg" onClick={onSignIn}>
              Sign in to use
            </Button>
          ) : (
            <Button
              size="lg"
              disabled={selectDisabled}
              onClick={() => onSelect(template)}
            >
              {selectLabel}
            </Button>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="mt-6 border-t border-border" />

      {/* README content */}
      {readme ? (
        <div className="mt-6">
          <SimpleMarkdown>{readme}</SimpleMarkdown>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {template.agents.length > 0 ? (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                AI Agents
              </h3>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {template.agents.map((agent) => (
                  <div
                    key={agent.role}
                    className="rounded-xl border border-border bg-muted px-3 py-2.5"
                  >
                    <div className="text-xs font-medium text-foreground">
                      {agent.role}
                    </div>
                    {agent.description ? (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {agent.description}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {template.views.length > 0 ? (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Views
              </h3>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {template.views.map((view) => (
                  <div
                    key={view.name}
                    className="rounded-xl border border-border bg-muted px-3 py-2.5"
                  >
                    <div className="text-xs font-medium text-foreground">
                      {view.name}
                    </div>
                    {view.description ? (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {view.description}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
