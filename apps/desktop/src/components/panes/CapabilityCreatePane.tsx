import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useWorkspaceIntegrationItems } from "@/components/panes/ChatPane/useWorkspaceIntegrationItems";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { Button } from "@/components/ui/button";
import { Check, Sparkles, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";

type SkillOption = { skillId: string; title: string; summary: string };

export function CapabilityCreatePane({
  workspaceId,
  onCreated,
  onClose,
}: {
  workspaceId: string;
  onCreated: (capabilityId: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [pickedSkills, setPickedSkills] = useState<Set<string>>(new Set());
  const [pickedProviders, setPickedProviders] = useState<Set<string>>(new Set());

  const { items: integrationItems } = useWorkspaceIntegrationItems(workspaceId, 50);
  const createMutation = useMutation(
    remoteApiQuery.capabilities.create.mutationOptions(),
  );

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    let cancelled = false;
    void window.electronAPI?.workspace
      ?.listSkills?.(workspaceId)
      .then((result) => {
        if (cancelled) return;
        setSkillOptions(
          (result?.skills ?? []).map((skill) => ({
            skillId: skill.skill_id,
            title: skill.title || skill.skill_id,
            summary: skill.summary ?? "",
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const toggle = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    return next;
  };

  const canCreate = name.trim().length > 0 && !createMutation.isPending;

  const submit = () => {
    if (!canCreate) return;
    createMutation.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        skillIds: [...pickedSkills],
        integrationProviders: [...pickedProviders],
      },
      {
        onSuccess: (record) => {
          queryClient.invalidateQueries({
            queryKey: remoteApiQuery.capabilities.key(),
          });
          onCreated(record.capabilityId);
        },
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-semibold text-foreground">New combo</span>
        <Button aria-label="Close" onClick={onClose} size="icon-sm" variant="ghost">
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
          <div className="flex flex-col gap-3">
            <Input
              aria-label="Combo name"
              onChange={(event) => setName(event.target.value)}
              placeholder="Name (e.g. Competitor Watch)"
              value={name}
            />
            <Input
              aria-label="Combo description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What it's for (optional)"
              value={description}
            />
          </div>

          <Section title="Skills" subtitle="The know-how this combo bundles">
            {skillOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No skills yet. Create skills first, then bundle them here.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {skillOptions.map((skill) => (
                  <PickRow
                    key={skill.skillId}
                    onClick={() =>
                      setPickedSkills((prev) => toggle(prev, skill.skillId))
                    }
                    selected={pickedSkills.has(skill.skillId)}
                    subtitle={skill.summary}
                    title={skill.title}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section title="Connections" subtitle="The accounts it needs">
            {integrationItems.length === 0 ? (
              <p className="text-xs text-muted-foreground">No connections available.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {integrationItems.map((item) => (
                  <PickRow
                    icon={
                      <AppIcon
                        appId={item.slug}
                        label={item.name}
                        providerId={item.slug}
                        size="row"
                      />
                    }
                    key={item.key}
                    onClick={() =>
                      setPickedProviders((prev) => toggle(prev, item.slug))
                    }
                    selected={pickedProviders.has(item.slug)}
                    title={item.name}
                  />
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button onClick={onClose} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!canCreate} onClick={submit} size="sm">
          <Sparkles className="size-3.5" />
          Create capability
        </Button>
      </footer>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        <p className="text-[13px] text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function PickRow({
  title,
  subtitle,
  selected,
  onClick,
  icon,
}: {
  title: string;
  subtitle?: string;
  selected: boolean;
  onClick: () => void;
  icon?: ReactNode;
}) {
  return (
    <button
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
        selected
          ? "border-primary/40 bg-accent"
          : "border-border hover:bg-accent",
      )}
      onClick={onClick}
      type="button"
    >
      {icon ? (
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-background ring-1 ring-border">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{title}</span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full border",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border",
        )}
      >
        {selected ? <Check className="size-3" /> : null}
      </span>
    </button>
  );
}
