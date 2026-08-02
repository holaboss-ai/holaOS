import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  deleteOrgModelKey,
  listOrgModelKeys,
  listOrgProviderModels,
  type OrgModelKeyMeta,
  type OrgProviderUpsert,
  saveOrgProvider,
  saveOrgProviderModels,
} from "@/lib/app-sdk-client";
import { useOrganizations } from "@/lib/auth/useOrganizations";
import {
  CUSTOM_PROVIDER_PRESET_ID,
  PROVIDER_FORM_PRESETS,
  providerFormPreset,
} from "@/lib/providerFormPresets";
import { type ProviderBrand, ProviderBrandIcon } from "@/lib/providerBrandIcon";
import { cn } from "@/lib/utils";
import { SettingsCard } from "./SettingsCard";
import { SettingsSection } from "./SettingsSection";

// BYOK — bring-your-own-key. An org supplies its own provider credentials; the
// agent then routes direct to that provider on the org's account (billed by the
// provider, not the Holaboss plan) and its models appear in the picker. Two
// built-ins (OpenAI, Anthropic, native hosts) plus any number of CUSTOM providers
// (OpenAI- or Anthropic-compatible endpoints with a user-supplied host). Providers
// are org-scoped on the backend, so they're shared with the web Settings → BYOK
// panel. Mirrors that panel.

const BUILTINS = [
  { id: "openai", name: "OpenAI", brand: "openai" as ProviderBrand, placeholder: "sk-…" },
  {
    id: "anthropic",
    name: "Anthropic",
    brand: "anthropic" as ProviderBrand,
    placeholder: "sk-ant-…",
  },
];
const BUILTIN_IDS = new Set(BUILTINS.map((b) => b.id));

// The provider types offered by the "Create Provider" form — the two compatible
// families. The built-in native OpenAI/Anthropic are their own pre-seeded rows.
const CUSTOM_TYPES = [
  { value: "openai_compatible", label: "OpenAI-compatible", placeholder: "sk-…" },
  {
    value: "anthropic_compatible",
    label: "Anthropic-compatible",
    placeholder: "sk-ant-…",
  },
];

const TYPE_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openai_compatible: "OpenAI-compatible",
  anthropic_compatible: "Anthropic-compatible",
};

type QueryKey = ReturnType<typeof buildQueryKey>;
function buildQueryKey(orgKey: string) {
  return ["org-model-keys", orgKey] as const;
}

// Per-provider model-curation checklist — pick which of the provider's native
// models appear in the picker, and add models by id the provider doesn't list.
function ModelChecklist({ providerRef }: { providerRef: string }) {
  const queryClient = useQueryClient();
  const modelsKey = ["org-model-keys", providerRef, "models"] as const;
  const query = useQuery({
    queryKey: modelsKey,
    queryFn: () => listOrgProviderModels(providerRef),
    retry: 1,
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [search, setSearch] = useState("");
  const [newId, setNewId] = useState("");

  const models = query.data?.models ?? [];
  const baseSelected = useMemo(
    () => new Set(models.filter((m) => m.enabled).map((m) => m.id)),
    [models],
  );
  const current = selected ?? baseSelected;

  const save = useMutation({
    mutationFn: () => saveOrgProviderModels(providerRef, [...current]),
    onSuccess: () => {
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: modelsKey });
    },
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev ?? baseSelected);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const addModel = (raw: string) => {
    const id = raw.trim();
    if (!id) {
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev ?? baseSelected);
      next.add(id);
      return next;
    });
    setNewId("");
  };

  if (query.isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <p className="text-destructive text-xs">
        {query.error instanceof Error
          ? query.error.message
          : "Couldn't load models."}
      </p>
    );
  }

  const q = search.trim().toLowerCase();
  const modelIds = new Set(models.map((m) => m.id));
  const manual = [...current]
    .filter((id) => !modelIds.has(id))
    .map((id) => ({ id, label: id }));
  const allRows = [...models, ...manual];
  const filtered = allRows.filter(
    (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium text-foreground text-xs">
          Models in the picker · {current.size} of {allRows.length}
        </span>
        <div className="flex items-center gap-2">
          <Button
            aria-label="Re-fetch the model list from the provider"
            disabled={query.isFetching}
            onClick={() => query.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            {query.isFetching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
          <Button
            disabled={selected === null || save.isPending}
            onClick={() => save.mutate()}
            size="sm"
            type="button"
          >
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Save selection"
            )}
          </Button>
        </div>
      </div>
      {allRows.length > 8 ? (
        <div className="relative mb-2">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            aria-label="Search models"
            className="h-8 pl-8 text-xs"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models…"
            value={search}
          />
        </div>
      ) : null}
      <div className="mb-2 flex items-center gap-2">
        <Input
          aria-label="Add a model by id"
          className="h-8 text-xs"
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addModel(newId);
            }
          }}
          placeholder="Add a model by id…"
          value={newId}
        />
        <Button
          disabled={!newId.trim()}
          onClick={() => addModel(newId)}
          size="sm"
          type="button"
          variant="outline"
        >
          Add
        </Button>
      </div>
      <div className="max-h-56 divide-y divide-border overflow-auto rounded-lg border border-border">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-muted-foreground text-xs">
            No models match.
          </p>
        ) : (
          filtered.map((m) => (
            <label
              className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted/40"
              key={m.id}
            >
              <input
                checked={current.has(m.id)}
                className="size-4 shrink-0 accent-primary"
                onChange={() => toggle(m.id)}
                type="checkbox"
              />
              <span className="truncate">{m.label}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

type RowProvider = {
  ref: string;
  name: string;
  typeLabel: string;
  brand?: ProviderBrand;
  placeholder: string;
  isCustom: boolean;
  meta?: OrgModelKeyMeta;
};

// After any provider change (add / save key / enable / remove), refresh the desktop
// model catalog so the new provider's models appear in the model selector right away.
// The selector reads runtimeConfig.providerModelGroups, which only updates when the
// main process re-broadcasts runtime:config — the mutations invalidate the settings
// query but never triggered that, so the picker stayed stale until a restart or a
// manual "Refresh catalogue".
function refreshDesktopModelCatalog(): void {
  void window.electronAPI.runtime.refreshModelCatalog().catch(() => {
    // best-effort — the picker keeps its previous catalog
  });
}

function ProviderRow({
  provider,
  expanded,
  onToggle,
  queryKey,
}: {
  provider: RowProvider;
  expanded: boolean;
  onToggle: () => void;
  queryKey: QueryKey;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [host, setHost] = useState(provider.meta?.api_host ?? "");
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey });
  // Saving/removing a key or toggling a provider changes which models are available,
  // so also refresh the desktop catalog → the selector updates live (not next restart).
  const invalidateAndRefresh = () => {
    invalidate();
    refreshDesktopModelCatalog();
  };
  const configured = provider.meta !== undefined;

  const saveKey = useMutation({
    mutationFn: () =>
      saveOrgProvider({
        provider: provider.ref,
        api_key: draft.trim(),
        ...(provider.isCustom && host.trim() ? { api_host: host.trim() } : {}),
      }),
    onSuccess: () => {
      setDraft("");
      setError(null);
      invalidateAndRefresh();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to save"),
  });
  const remove = useMutation({
    mutationFn: () => deleteOrgModelKey(provider.ref),
    onSuccess: invalidateAndRefresh,
  });
  const setEnabled = useMutation({
    mutationFn: (next: boolean) =>
      saveOrgProvider({ provider: provider.ref, enabled: next }),
    onSuccess: invalidateAndRefresh,
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to save"),
  });

  return (
    <div>
      <div className="flex w-full items-center gap-3 px-3 py-3">
        <button
          className="flex flex-1 items-center gap-3 text-left"
          onClick={onToggle}
          type="button"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted font-semibold text-foreground text-sm">
            {provider.brand ? (
              <ProviderBrandIcon brand={provider.brand} className="size-5" />
            ) : (
              provider.name.charAt(0).toUpperCase()
            )}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-sm">
                {provider.name}
              </span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {provider.typeLabel}
              </span>
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {configured
                ? `Key ••••${provider.meta?.key_last4} · ${provider.meta?.status}`
                : "Not configured"}
            </span>
          </span>
        </button>
        {configured ? (
          <Switch
            checked={provider.meta?.enabled ?? true}
            disabled={setEnabled.isPending}
            onCheckedChange={(next) => setEnabled.mutate(next)}
          />
        ) : null}
        <button
          aria-label="Expand"
          className="text-muted-foreground"
          onClick={onToggle}
          type="button"
        >
          <ChevronRight
            className={cn("size-4 transition-transform", expanded && "rotate-90")}
          />
        </button>
      </div>
      {expanded ? (
        <div className="border-border/50 border-t px-3 py-3">
          {provider.isCustom ? (
            <div className="mb-3">
              <Label className="text-xs" htmlFor={`host-${provider.ref}`}>
                API Host
              </Label>
              <Input
                className="mt-1"
                id={`host-${provider.ref}`}
                onChange={(e) => setHost(e.target.value)}
                placeholder="https://api.example.com"
                value={host}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Input
              aria-label={`${provider.name} API key`}
              className="flex-1"
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                configured ? "Replace with a new key…" : provider.placeholder
              }
              type="password"
              value={draft}
            />
            <Button
              disabled={!draft.trim() || saveKey.isPending}
              onClick={() => saveKey.mutate()}
              type="button"
            >
              {saveKey.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
            {configured ? (
              <Button
                aria-label={provider.isCustom ? "Delete provider" : "Remove key"}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                type="button"
                variant="ghost"
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
          {error ? <p className="mt-2 text-destructive text-xs">{error}</p> : null}
          {configured ? (
            <div className="mt-3 border-border/60 border-t pt-3">
              <ModelChecklist providerRef={provider.ref} />
            </div>
          ) : (
            <p className="mt-2 text-muted-foreground text-xs">
              Stored encrypted server-side; never shown again after saving.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CreateProviderForm({
  queryKey,
  onDone,
}: {
  queryKey: QueryKey;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [presetId, setPresetId] = useState(CUSTOM_PROVIDER_PRESET_ID);
  const [name, setName] = useState("");
  const [type, setType] = useState<string>(CUSTOM_TYPES[0].value);
  const [apiKey, setApiKey] = useState("");
  const [apiHost, setApiHost] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const placeholder =
    presetId === CUSTOM_PROVIDER_PRESET_ID
      ? (CUSTOM_TYPES.find((t) => t.value === type)?.placeholder ?? "sk-…")
      : providerFormPreset(presetId).keyPlaceholder;

  const applyPreset = (nextPresetId: string) => {
    const preset = providerFormPreset(nextPresetId);
    setPresetId(preset.id);
    setName(preset.displayName);
    setType(preset.providerType);
    setApiHost(preset.apiHost);
  };

  const create = useMutation({
    mutationFn: () => {
      const body: OrgProviderUpsert = {
        display_name: name.trim(),
        provider_type: type,
        api_host: apiHost.trim(),
        api_key: apiKey.trim(),
        enabled,
      };
      return saveOrgProvider(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // Show the new provider's models in the selector immediately.
      refreshDesktopModelCatalog();
      onDone();
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : "Failed to create provider"),
  });

  const canSubmit =
    name.trim().length > 0 &&
    apiKey.trim().length > 0 &&
    apiHost.trim().length > 0;

  return (
    <div className="rounded-lg border border-border/60 bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-medium text-sm">Create Provider</span>
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
      <div className="grid gap-3">
        <div>
          <Label htmlFor="provider-preset">Provider Preset</Label>
          <Select
            onValueChange={(value) =>
              applyPreset(value ?? CUSTOM_PROVIDER_PRESET_ID)
            }
            value={presetId}
          >
            <SelectTrigger
              className="mt-1 w-full bg-background"
              id="provider-preset"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-[220px]">
              {PROVIDER_FORM_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="provider-name">Provider Name</Label>
          <Input
            className="mt-1"
            id="provider-name"
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. DeepSeek"
            value={name}
          />
        </div>
        <div className="flex items-center gap-3">
          <Label className="mb-0" htmlFor="provider-enabled">
            Enabled
          </Label>
          <Switch
            checked={enabled}
            id="provider-enabled"
            onCheckedChange={(next) => setEnabled(next)}
          />
        </div>
        <div>
          <Label htmlFor="provider-type">Provider Type</Label>
          <Select
            onValueChange={(value) => setType(value ?? CUSTOM_TYPES[0].value)}
            value={type}
          >
            <SelectTrigger className="mt-1 w-full bg-background" id="provider-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-[220px]">
              {CUSTOM_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="provider-key">API Key</Label>
          <Input
            className="mt-1"
            id="provider-key"
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={placeholder}
            type="password"
            value={apiKey}
          />
        </div>
        <div>
          <Label htmlFor="provider-host">API Host</Label>
          <Input
            className="mt-1"
            id="provider-host"
            onChange={(e) => setApiHost(e.target.value)}
            placeholder="https://api.deepseek.com"
            value={apiHost}
          />
        </div>
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
        <div>
          <Button
            disabled={!canSubmit || create.isPending}
            onClick={() => create.mutate()}
            type="button"
          >
            {create.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Create Provider"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function BYOKSettingsPanel() {
  const { activeOrg } = useOrganizations();
  const queryClient = useQueryClient();
  const queryKey = buildQueryKey(activeOrg?.id ?? "personal");
  const query = useQuery({ queryKey, queryFn: listOrgModelKeys, retry: 1 });
  const [expandedRef, setExpandedRef] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);

  const rows = useMemo<RowProvider[]>(() => {
    const keys = query.data?.keys ?? [];
    const metaByRef = new Map(keys.map((k) => [k.provider, k]));
    const builtinRows: RowProvider[] = BUILTINS.map((b) => ({
      ref: b.id,
      name: b.name,
      typeLabel: TYPE_LABEL[b.id] ?? b.name,
      brand: b.brand,
      placeholder: b.placeholder,
      isCustom: false,
      meta: metaByRef.get(b.id),
    }));
    const customRows: RowProvider[] = keys
      .filter((k) => !BUILTIN_IDS.has(k.provider))
      .map((k) => ({
        ref: k.provider,
        name: k.display_name || k.provider,
        typeLabel: TYPE_LABEL[k.provider_type] ?? k.provider_type,
        placeholder: k.provider_type.startsWith("anthropic") ? "sk-ant-…" : "sk-…",
        isCustom: true,
        meta: k,
      }));
    return [...builtinRows, ...customRows];
  }, [query.data]);

  const refreshCatalog = async () => {
    setRefreshing(true);
    setRefreshed(false);
    try {
      await window.electronAPI.runtime.refreshModelCatalog();
      // Re-fetch the provider list + any open model checklists too.
      queryClient.invalidateQueries({ queryKey: ["org-model-keys"] });
      setRefreshed(true);
    } catch {
      // best-effort — the picker keeps its previous catalog
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <SettingsSection
      description="Bring your own provider keys — models run on your account, not your holaOS plan. Add a custom OpenAI- or Anthropic-compatible endpoint."
      title="Model Providers"
    >
      <div className="mb-3 flex items-center gap-2">
        <Button
          onClick={() => setCreating((v) => !v)}
          size="sm"
          type="button"
          variant={creating ? "secondary" : "default"}
        >
          <Plus className="size-4" />
          Add Provider
        </Button>
        <Button
          disabled={refreshing}
          onClick={refreshCatalog}
          size="sm"
          type="button"
          variant="outline"
        >
          {refreshing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Refresh catalogue
        </Button>
        {refreshed ? (
          <span className="text-muted-foreground text-xs">Synced</span>
        ) : null}
      </div>

      {creating ? (
        <div className="mb-4">
          <CreateProviderForm onDone={() => setCreating(false)} queryKey={queryKey} />
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      {query.isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="font-medium text-destructive text-sm">
            Couldn't load providers
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            {query.error instanceof Error
              ? query.error.message
              : "Please try again."}
          </p>
          <Button
            className="mt-2"
            onClick={() => query.refetch()}
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      ) : null}
      {query.isSuccess ? (
        <SettingsCard>
          {rows.map((r) => (
            <ProviderRow
              expanded={expandedRef === r.ref}
              key={r.ref}
              onToggle={() =>
                setExpandedRef((prev) => (prev === r.ref ? null : r.ref))
              }
              provider={r}
              queryKey={queryKey}
            />
          ))}
        </SettingsCard>
      ) : null}
    </SettingsSection>
  );
}
