import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStartChatDraft } from "@/components/layout/shell/useStartChatDraft";
import { useConnectedToolkitSlugs } from "@/components/panes/ChatPane/useWorkspaceIntegrationItems";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Loader2,
  MessageSquareText,
  Plus,
  Server,
  Unplug,
} from "@/components/ui/icons";
import { CapabilityGlyph } from "@/components/marketplace/CapabilityGlyph";
import { McpInstallDialog } from "@/components/layout/shell/McpInstallDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type DirectoryMcpRequiredKeyDto,
  fetchDirectorySkillBody,
} from "@/lib/directoryClient";
import { readInstalledMcpIds } from "@/lib/localMcpKeys";
import { installMcp, type McpCatalogEntry } from "@/lib/mcpMarketplace";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { useIntegrationConnect } from "@/lib/useIntegrationConnect";
import { composioToolkitSlugForProvider } from "@/lib/workspaceDesktop";

/** A workspace-installed capability record (from capabilities.listInstalled). */
export interface InstalledCapability {
  capabilityId: string;
  name: string;
  description: string | null;
  icon: string | null;
  version: string | null;
  status: string;
  installedSkillIds: string[];
  integrationStatus: Record<string, string>;
}

type SkillMeta = { title: string; summary: string; filePath: string | null };

/** A capability's bundled MCP server (resolved from the catalog by the gateway).
 * Keyless ones attach silently on install; keyed ones surface a connect-gate. */
type BundledMcp = {
  id: string;
  name: string;
  url: string;
  tools: string[];
  requiresKeys: boolean;
  requiredKeys: DirectoryMcpRequiredKeyDto[];
  required: boolean;
};

function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? markdown.slice(match[0].length).trimStart() : markdown;
}

/**
 * One capability detail surface for both states — installed and not. The body
 * (header, connectors, skills) is shared; only the action bar and the skill-row
 * affordances branch on `installed` (an uninstalled capability has no workspace
 * skill bodies to expand, and its action is Install rather than manage/remove).
 */
export function CapabilityDetailView({
  onBack,
  backLabel,
  name,
  description,
  category,
  icon,
  skillIds,
  connectorProviders,
  requiredProviders,
  mcps,
  workspaceId,
  installed,
  capabilityId,
  status,
  onUninstalled,
  onInstall,
  installing,
}: {
  onBack: () => void;
  backLabel: string;
  name: string;
  description: string | null;
  category?: string | null;
  /** Phosphor glyph name from the backend catalog. */
  icon?: string | null;
  skillIds: string[];
  connectorProviders: string[];
  /** Provider names that must be connected before Install (not-installed only). */
  requiredProviders?: string[];
  /** Bundled MCP servers (not-installed only). Keyed ones gate install until
   * their credentials are supplied via the connect dialog. */
  mcps?: BundledMcp[];
  workspaceId: string;
  installed: boolean;
  /** Installed-only — the workspace capability id, for toggle/uninstall. */
  capabilityId?: string;
  status?: string;
  onUninstalled?: () => void;
  /** Not-installed-only. */
  onInstall?: () => void;
  installing?: boolean;
}) {
  const queryClient = useQueryClient();
  const startChatDraft = useStartChatDraft();
  const { connectedSlugs } = useConnectedToolkitSlugs();
  // useConnectedToolkitSlugs fetches once on mount; after an inline connect we
  // optimistically add the slug here so the row + gate flip immediately.
  const [locallyConnected, setLocallyConnected] = useState<Set<string>>(
    new Set(),
  );
  const markConnected = useCallback((slug: string) => {
    setLocallyConnected((prev) => new Set(prev).add(slug));
  }, []);
  const requiredSlugSet = useMemo(
    () => new Set((requiredProviders ?? []).map(composioToolkitSlugForProvider)),
    [requiredProviders],
  );
  const isConnected = useCallback(
    (slug: string) => connectedSlugs.has(slug) || locallyConnected.has(slug),
    [connectedSlugs, locallyConnected],
  );
  const requiredUnmet = useMemo(
    () =>
      connectorProviders.filter((provider) => {
        const slug = composioToolkitSlugForProvider(provider);
        return requiredSlugSet.has(slug) && !isConnected(slug);
      }),
    [connectorProviders, requiredSlugSet, isConnected],
  );

  // Keyed bundled MCPs (need credentials). Keyless ones attach silently on
  // install and never gate. Track connected ones locally so the gate + rows flip
  // immediately after the connect dialog.
  const keyedMcps = useMemo(
    () => (mcps ?? []).filter((mcp) => mcp.requiresKeys),
    [mcps],
  );
  const [connectedMcpIds, setConnectedMcpIds] = useState<Set<string>>(
    () => new Set(readInstalledMcpIds()),
  );
  const [mcpDialog, setMcpDialog] = useState<McpCatalogEntry | null>(null);
  const mcpUnmet = useMemo(
    () =>
      keyedMcps.filter((mcp) => mcp.required && !connectedMcpIds.has(mcp.id)),
    [keyedMcps, connectedMcpIds],
  );
  const toMcpEntry = useCallback(
    (mcp: BundledMcp): McpCatalogEntry => ({
      id: mcp.id,
      name: mcp.name,
      mcpUrl: mcp.url,
      holabossHosted: false,
      requiredKeys: mcp.requiredKeys,
      comingSoon: false,
      verified: true,
      installed: connectedMcpIds.has(mcp.id),
      tools: mcp.tools.map((toolName) => ({ name: toolName, description: "" })),
    }),
    [connectedMcpIds],
  );

  const [skillMetaById, setSkillMetaById] = useState<Record<string, SkillMeta>>(
    {},
  );
  const [expandedSkillIds, setExpandedSkillIds] = useState<Set<string>>(
    new Set(),
  );
  const [skillBodies, setSkillBodies] = useState<Record<string, string | null>>(
    {},
  );
  const [confirmRemove, setConfirmRemove] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: remoteApiQuery.capabilities.key(),
    });

  const toggleMutation = useMutation(
    remoteApiQuery.capabilities.toggle.mutationOptions(),
  );
  const uninstallMutation = useMutation(
    remoteApiQuery.capabilities.uninstall.mutationOptions(),
  );

  const isActive = status === "active";
  const busy = toggleMutation.isPending || uninstallMutation.isPending;

  // Only installed skills live in the workspace; resolve their titles/summaries
  // and let their SKILL.md bodies expand inline. Skipped for uninstalled
  // capabilities (the skills aren't materialized yet).
  useEffect(() => {
    if (!installed || !workspaceId) {
      return;
    }
    let cancelled = false;
    void window.electronAPI?.workspace
      ?.listSkills?.(workspaceId)
      .then((result) => {
        if (cancelled) return;
        const byId: Record<string, SkillMeta> = {};
        for (const skill of result?.skills ?? []) {
          byId[skill.skill_id] = {
            title: skill.title || skill.skill_id,
            summary: skill.summary ?? "",
            filePath: skill.skill_file_path ?? null,
          };
        }
        setSkillMetaById(byId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [installed, workspaceId]);

  const toggleSkill = useCallback(
    (skillId: string) => {
      setExpandedSkillIds((prev) => {
        const next = new Set(prev);
        if (next.has(skillId)) {
          next.delete(skillId);
          return next;
        }
        next.add(skillId);
        if (!(skillId in skillBodies)) {
          setSkillBodies((bodies) => ({ ...bodies, [skillId]: null }));
          // Installed skills live in the workspace (may carry local edits);
          // uninstalled ones resolve their SKILL.md from the directory backend.
          const filePath = skillMetaById[skillId]?.filePath;
          const load: Promise<string> =
            installed && filePath
              ? Promise.resolve(
                  window.electronAPI?.fs?.readFilePreview?.(
                    filePath,
                    workspaceId,
                  ),
                ).then((response) =>
                  response?.kind === "text" ? (response.content ?? "") : "",
                )
              : fetchDirectorySkillBody(skillId).then((dto) => dto.body ?? "");
          load
            .then((content) =>
              setSkillBodies((bodies) => ({ ...bodies, [skillId]: content })),
            )
            .catch(() =>
              setSkillBodies((bodies) => ({ ...bodies, [skillId]: "" })),
            );
        }
        return next;
      });
    },
    [installed, skillMetaById, skillBodies, workspaceId],
  );

  const connectorLabel = useMemo(
    () => (category ? category : null),
    [category],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-8">
        <button
          className="-mx-2 mb-6 flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-fg-2 hover:text-foreground"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft className="size-4" />
          {backLabel}
        </button>

        <header className="flex items-start gap-4">
          <CapabilityGlyph
            category={category ?? undefined}
            className="size-14"
            icon={icon ?? undefined}
            iconClassName="size-7"
            id={capabilityId ?? ""}
          />
          <div className="min-w-0 flex-1 pt-0.5">
            {connectorLabel ? (
              <p className="text-[11px] text-muted-foreground/70 uppercase tracking-wide">
                {connectorLabel}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                {name}
              </h1>
              {installed && !isActive ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  Off
                </span>
              ) : null}
            </div>
            {description ? (
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
        </header>

        <div className="mt-5 flex items-center gap-2">
          {installed ? (
            <>
              <Button
                disabled={busy || !capabilityId}
                onClick={() => {
                  if (!capabilityId) return;
                  toggleMutation.mutate(
                    { capabilityId, enabled: !isActive },
                    { onSuccess: invalidate },
                  );
                }}
                size="sm"
                variant={isActive ? "secondary" : "default"}
              >
                {isActive ? "Turn off" : "Turn on"}
              </Button>
              <Button
                onClick={() =>
                  startChatDraft(
                    `/customize-capability Help me customize the "${name}" combo (id: ${capabilityId}). Ask me what to change.`,
                    { returnTo: "customize" },
                  )
                }
                size="sm"
                variant="outline"
              >
                Customize
              </Button>
              <Button
                className="text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
                size="sm"
                variant="ghost"
              >
                <Unplug className="size-3.5" />
                Uninstall
              </Button>
            </>
          ) : (
            <Button
              disabled={
                installing || requiredUnmet.length > 0 || mcpUnmet.length > 0
              }
              onClick={() => onInstall?.()}
              size="sm"
            >
              {installing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
              )}
              Install
            </Button>
          )}
        </div>
        {!installed && (requiredUnmet.length > 0 || mcpUnmet.length > 0) ? (
          <p className="mt-2 text-sm font-medium text-amber-600 dark:text-amber-500">
            {requiredUnmet.length > 0 && mcpUnmet.length > 0
              ? "Connect the required integrations and MCP servers first"
              : requiredUnmet.length > 0
                ? "Connect the required integrations first"
                : "Connect the required MCP servers first"}
          </p>
        ) : null}

        {!installed && keyedMcps.length > 0 ? (
          <section className="mt-8">
            <SectionLabel count={keyedMcps.length} title="MCP servers" />
            <div className="mt-3 flex flex-col gap-1.5">
              {keyedMcps.map((mcp) => {
                const isMcpConnected = connectedMcpIds.has(mcp.id);
                return (
                  <div
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                    key={mcp.id}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted">
                      <Server className="size-4 text-muted-foreground" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground text-sm">
                        {mcp.name}
                        {mcp.required ? null : (
                          <span className="ml-2 text-muted-foreground text-xs">
                            optional
                          </span>
                        )}
                      </p>
                    </div>
                    {isMcpConnected ? (
                      <span className="flex shrink-0 items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
                        <Check className="size-3.5" />
                        Connected
                      </span>
                    ) : (
                      <Button
                        onClick={() => setMcpDialog(toMcpEntry(mcp))}
                        size="sm"
                        variant="outline"
                      >
                        Connect
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {mcpDialog ? (
          <McpInstallDialog
            entry={mcpDialog}
            onConfirm={async (values) => {
              await installMcp(mcpDialog, values);
              setConnectedMcpIds((prev) => new Set(prev).add(mcpDialog.id));
            }}
            onOpenChange={(next) => {
              if (!next) {
                setMcpDialog(null);
              }
            }}
            open
          />
        ) : null}

        <ConfirmDialog
          confirmLabel="Remove"
          description={`"${name}" and its skills will be removed from this workspace. You can reinstall it from the Directory later.`}
          destructive
          onConfirm={() => {
            setConfirmRemove(false);
            if (!capabilityId) return;
            uninstallMutation.mutate(
              { capabilityId },
              {
                onSuccess: () => {
                  invalidate();
                  onUninstalled?.();
                },
              },
            );
          }}
          onOpenChange={(open) => {
            if (!open) setConfirmRemove(false);
          }}
          open={confirmRemove}
          title="Remove this combo?"
        />

        {connectorProviders.length > 0 ? (
          <section className="mt-8">
            <SectionLabel count={connectorProviders.length} title="Connections" />
            <div className="mt-3 flex flex-col gap-1.5">
              {[...connectorProviders]
                .sort((a, b) => {
                  const aReq = requiredSlugSet.has(
                    composioToolkitSlugForProvider(a),
                  );
                  const bReq = requiredSlugSet.has(
                    composioToolkitSlugForProvider(b),
                  );
                  if (aReq === bReq) {
                    return 0;
                  }
                  return aReq ? -1 : 1;
                })
                .map((provider) => {
                  const slug = composioToolkitSlugForProvider(provider);
                  return (
                    <ConnectorRow
                      connected={isConnected(slug)}
                      key={provider}
                      onConnected={markConnected}
                      provider={provider}
                      required={requiredSlugSet.has(slug)}
                      slug={slug}
                    />
                  );
                })}
            </div>
          </section>
        ) : null}

        {skillIds.length > 0 ? (
          <section className="mt-8">
            <SectionLabel count={skillIds.length} title="Skills" />
            <div className="mt-3 flex flex-col gap-2">
              {skillIds.map((skillId) => {
                const meta = skillMetaById[skillId];
                const expanded = expandedSkillIds.has(skillId);
                const body = skillBodies[skillId];
                const label = meta?.title ?? skillId;
                return (
                  <div
                    className="overflow-hidden rounded-lg border border-border"
                    key={skillId}
                  >
                    <button
                      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent"
                      onClick={() => toggleSkill(skillId)}
                      type="button"
                    >
                      <ChevronRight
                        className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {label}
                        </span>
                        {meta?.summary ? (
                          <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
                            {meta.summary}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {expanded ? (
                      <div className="border-border border-t px-4 py-3">
                        {body === null || body === undefined ? (
                          <div
                            aria-busy="true"
                            aria-label="Loading skill content"
                            className="space-y-2"
                            role="status"
                          >
                            <Skeleton className="h-3 w-full" />
                            <Skeleton className="h-3 w-5/6" />
                            <Skeleton className="h-3 w-2/3" />
                          </div>
                        ) : body === "" ? (
                          <p className="text-xs text-muted-foreground">
                            No readable content for this skill.
                          </p>
                        ) : (
                          <SimpleMarkdown className="md-body text-sm">
                            {stripFrontmatter(body)}
                          </SimpleMarkdown>
                        )}
                        {installed ? (
                          <div className="mt-3">
                            <Button
                              onClick={() =>
                                startChatDraft(`/${skillId} `, {
                                  returnTo: "customize",
                                })
                              }
                              size="sm"
                              variant="outline"
                            >
                              <MessageSquareText className="size-3.5" />
                              Use in chat
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ConnectorRow({
  provider,
  slug,
  connected,
  required,
  onConnected,
}: {
  provider: string;
  slug: string;
  connected: boolean;
  required: boolean;
  onConnected: (slug: string) => void;
}) {
  const { connect, status } = useIntegrationConnect({
    onDone: () => onConnected(slug),
  });
  const connecting = status.kind === "connecting";
  const errored = status.kind === "error";
  return (
    <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-background ring-1 ring-border">
          <AppIcon appId={slug} label={provider} providerId={slug} size="row" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm capitalize text-foreground">
            {provider}
          </span>
          {required ? (
            <span className="text-[11px] text-muted-foreground">Required</span>
          ) : null}
        </span>
      </span>
      {connected ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Check className="size-3.5" />
          Connected
        </span>
      ) : (
        <Button
          disabled={connecting}
          onClick={() => void connect({ provider, accountLabel: provider })}
          size="sm"
          variant="outline"
        >
          {connecting ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Connecting
            </>
          ) : errored ? (
            "Retry"
          ) : (
            "Connect"
          )}
        </Button>
      )}
    </div>
  );
}

function SectionLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <span className="grid h-4 min-w-4 place-items-center rounded-full bg-muted px-1 text-[10px] font-medium tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );
}
