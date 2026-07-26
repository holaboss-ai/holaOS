import type {
  InstalledItem,
  InstallEventPayload,
  InstallResult,
} from "@holaboss/app-host/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type MarketItem,
  toIdList,
  toRequiredProviders,
} from "@/components/panes/CapabilitiesMarketPane";
import {
  fetchDirectoryCapabilities,
  fetchDirectorySkillBody,
  fetchDirectorySkills,
} from "@/lib/directoryClient";
import { appKind } from "@/lib/holaAppMarketplace";
import { readInstalledMcpIds } from "@/lib/localMcpKeys";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { withSkillDisplayTitle } from "@/lib/skillDisplayTitle";
import { useWorkspaceSkills, workspaceSkillsKey } from "@/lib/useWorkspaceSkills";
import { useHolaAppCatalog } from "./useHolaAppCatalog";
import { useMcpCatalog } from "./useMcpCatalog";
import {
  pendingHubAppInstallAtom,
  pendingHubInstallAtom,
  workspaceOverlayAtom,
} from "./state/ui";

// Smooth HolaHub install — the shell-root receiver for the desktop host `install`
// op. A hosted page (HolaHub) invokes install → main forwards HOST_INSTALL_EVENT
// here → we install the item HEADLESSLY (in place, no navigation) when it's
// keyless, or open the native connect surface when it needs credentials/an
// integration, then reply with the outcome (sendInstallResult) so the hub button
// can show Installing → Installed / Connect.
//
// The per-type runners reproduce the exact install primitives the visible panes
// use (useMcpCatalog / skills install mutation / capability handleAdd) — kept in
// lockstep with McpsPane, SkillsStorePane and CapabilitiesMarketPane. They mount
// only while a request is active (queries fire on demand, nothing idle).

type OpenNative = (type: InstallEventPayload["type"], ref: string) => void;

type RunnerProps = {
  ref: string;
  onDone: (result: InstallResult) => void;
  openNative: OpenNative;
};

// ── MCP: keyless + verified → attach in place; keyed / unverified / coming-soon
// → the native MCP surface (which owns the key dialog / consent gate). ──────────
function McpInstallRunner({ ref, onDone, openNative }: RunnerProps) {
  const { catalog, install, refresh } = useMcpCatalog();
  const doneRef = useRef(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (doneRef.current || catalog.length === 0) {
      return;
    }
    const entry = catalog.find((e) => e.id === ref);
    if (!entry) {
      return; // catalog not fully loaded yet — a later render will find it
    }
    doneRef.current = true;
    if (entry.installed) {
      onDone({ status: "already" });
      return;
    }
    if (entry.comingSoon) {
      onDone({ status: "error", message: `${entry.name} is coming soon.` });
      return;
    }
    if (!entry.verified || entry.requiredKeys.length > 0) {
      openNative("mcp", ref);
      onDone({
        status: "needsConnect",
        opened: true,
        requiredKeys: entry.requiredKeys.map((key) => key.name),
      });
      return;
    }
    void install(entry, {})
      .then(() => onDone({ status: "installed" }))
      .catch((error) =>
        onDone({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      );
  }, [catalog, ref, install, onDone, openNative]);

  return null;
}

// ── Skill: always keyless — resolve the body + install in place. ───────────────
function SkillInstallRunner({
  ref,
  workspaceId,
  onDone,
}: RunnerProps & { workspaceId: string | null }) {
  const queryClient = useQueryClient();
  const marketQuery = useQuery({
    queryKey: ["directory-central", "skills"],
    queryFn: fetchDirectorySkills,
    retry: 2,
    staleTime: 60_000,
  });
  const installMutation = useMutation(
    remoteApiQuery.skills.install.mutationOptions()
  );
  const installedQuery = useWorkspaceSkills(workspaceId);
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current || !marketQuery.isSuccess) {
      return;
    }
    const entry = (marketQuery.data?.skills ?? []).find((e) => e.id === ref);
    if (!entry) {
      doneRef.current = true;
      onDone({ status: "error", message: `"${ref}" isn't in the skills catalog.` });
      return;
    }
    const installedIds = new Set(
      (installedQuery.data?.skills ?? []).map((s) => s.skill_id)
    );
    if (installedIds.has(entry.id)) {
      doneRef.current = true;
      onDone({ status: "already" });
      return;
    }
    doneRef.current = true;
    void fetchDirectorySkillBody(entry.id)
      .then((resolved) =>
        installMutation.mutateAsync({
          skillId: entry.id,
          content: withSkillDisplayTitle(resolved.body, entry.name),
        })
      )
      .then(() => {
        if (workspaceId) {
          void queryClient.invalidateQueries({
            queryKey: workspaceSkillsKey(workspaceId),
          });
        }
        onDone({ status: "installed" });
      })
      .catch((error) =>
        onDone({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      );
  }, [
    marketQuery.isSuccess,
    marketQuery.data,
    ref,
    workspaceId,
    installMutation,
    installedQuery.data,
    queryClient,
    onDone,
  ]);

  return null;
}

// ── Capability: install in place, mirroring CapabilitiesMarketPane.handleAdd —
// embedded → capabilities.install; community → install its skills + create the
// workspace capability. A required integration is recorded as `needs_connection`
// and keyed MCPs are filtered out of attachment, so both connect LAZILY later.
// A HolaHub install therefore never yanks the user out to the Marketplace — it
// behaves like a skill/MCP install (in place), consistent with the rest of the
// hub. (No `connectedSlugs` gate here, which also removes its hydration race.) ──
function CapabilityInstallRunner({ ref, onDone }: RunnerProps) {
  const queryClient = useQueryClient();
  const centralQuery = useQuery({
    queryKey: ["directory-central", "capabilities"],
    queryFn: fetchDirectoryCapabilities,
    retry: 2,
    staleTime: 60_000,
  });
  const runtimeQuery = useQuery(
    remoteApiQuery.capabilities.catalog.queryOptions({ input: {} })
  );
  const installMutation = useMutation(
    remoteApiQuery.capabilities.install.mutationOptions()
  );
  const skillInstall = useMutation(remoteApiQuery.skills.install.mutationOptions());
  const capabilityCreate = useMutation(
    remoteApiQuery.capabilities.create.mutationOptions()
  );
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current || !centralQuery.isSuccess) {
      return;
    }
    // Wait until the runtime (embedded) catalog is settled so built-in vs
    // ref-based routing is decided correctly.
    if (runtimeQuery.isLoading) {
      return;
    }
    const raw = (centralQuery.data?.capabilities ?? []).find((e) => e.id === ref);
    if (!raw) {
      doneRef.current = true;
      onDone({
        status: "error",
        message: `"${ref}" isn't in the combos catalog.`,
      });
      return;
    }
    doneRef.current = true;
    const item: MarketItem = {
      id: raw.id,
      name: raw.name,
      description: raw.description,
      icon: raw.icon ?? undefined,
      category:
        "category" in raw && typeof raw.category === "string"
          ? raw.category
          : undefined,
      skills: toIdList(raw.skills),
      integrations: toIdList(raw.integrations),
      requiredProviders: toRequiredProviders(raw.integrations),
      mcps: ("mcps" in raw ? (raw.mcps ?? []) : []).map((m) => ({
        id: m.id,
        name: m.name,
        url: m.url,
        tools: m.tools,
        requiresKeys: m.requiresKeys,
        requiredKeys: m.requiredKeys ?? [],
        required: m.required,
      })),
    };
    const embeddedIds = new Set(
      (runtimeQuery.data?.capabilities ?? []).map((c) => c.id)
    );
    void (async () => {
      try {
        if (embeddedIds.has(item.id)) {
          await installMutation.mutateAsync({ capabilityId: item.id });
        } else {
          const installedSkillIds: string[] = [];
          for (const skillId of item.skills) {
            try {
              const resolved = await fetchDirectorySkillBody(skillId);
              await skillInstall.mutateAsync({ skillId, content: resolved.body });
              installedSkillIds.push(skillId);
            } catch {
              // A skill whose body can't resolve shouldn't sink the capability.
            }
          }
          await capabilityCreate.mutateAsync({
            name: item.name,
            description: item.description,
            icon: item.icon,
            skillIds: installedSkillIds,
            integrationProviders: item.integrations,
            mcps: item.mcps
              .filter((m) => !m.requiresKeys)
              .map((m) => ({ id: m.id, url: m.url, tools: m.tools })),
          });
        }
        queryClient.invalidateQueries({
          queryKey: remoteApiQuery.capabilities.key(),
        });
        queryClient.invalidateQueries({ queryKey: remoteApiQuery.skills.key() });
        onDone({ status: "installed" });
      } catch (error) {
        onDone({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [
    centralQuery.isSuccess,
    centralQuery.data,
    runtimeQuery.isLoading,
    runtimeQuery.data,
    ref,
    installMutation,
    skillInstall,
    capabilityCreate,
    queryClient,
    onDone,
  ]);

  return null;
}

// ── HolaApp: install in place for the one-click flavors (plain hosted/module,
// api-key — key entered later at the surface, and command/stdio MCP which needs no
// key). Route to the app store's OWN gate — focused on this app, not a generic
// marketplace dump — only for flavors that need input up front: a connection-tier
// app (install IS the connect) or a hosted-MCP app needing BYO credentials. ──────
function HolaAppInstallRunner({ ref, onDone, openNative }: RunnerProps) {
  const { catalog, install, refresh } = useHolaAppCatalog();
  const doneRef = useRef(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (doneRef.current || catalog.length === 0) {
      return;
    }
    const entry = catalog.find((e) => e.holaAppId === ref);
    if (!entry) {
      return; // catalog still hydrating — a later render may find it
    }
    doneRef.current = true;
    if (entry.installed) {
      onDone({ status: "already" });
      return;
    }
    if (entry.status === "coming_soon") {
      onDone({ status: "error", message: `${entry.title} is coming soon.` });
      return;
    }
    // Needs input up front → hand off to the app's own gate in the store (the
    // pane's `toggle` opens the exact same gate): a connection-tier app (install
    // IS the connect), a hosted-MCP app needing BYO credentials, OR any app with a
    // REQUIRED integration — its install is designed to gate on connecting first
    // (the HolaAppInstallDialog: connect the account, then add to sidebar, e.g.
    // Notion). Unlike a capability, an app couples connect → install, so we don't
    // silently defer it.
    const requiresIntegration = (entry.integrations ?? []).some(
      (integration) => integration.required
    );
    if (
      appKind(entry) === "connection" ||
      entry.hostedMcpInstall ||
      requiresIntegration
    ) {
      openNative("holaapp", ref);
      onDone({ status: "needsConnect", opened: true });
      return;
    }
    // One-click → install in place. A command/stdio MCP app (drawio) also needs
    // its local server attached; an api-key app's key is entered later at the
    // app surface (no required integration, so it never reaches here as gated).
    void (async () => {
      try {
        await install(entry.holaAppId);
        if (entry.commandMcpInstall) {
          await window.electronAPI.holaApps?.attachCommandMcp?.({
            holaAppId: entry.holaAppId,
            command: entry.commandMcpInstall.command,
            env: entry.commandMcpInstall.env ?? {},
          });
        }
        onDone({ status: "installed" });
      } catch (error) {
        onDone({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [catalog, ref, install, onDone, openNative]);

  return null;
}

export function HeadlessInstaller({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setPendingInstall = useSetAtom(pendingHubInstallAtom);
  const setPendingHubApp = useSetAtom(pendingHubAppInstallAtom);
  const [queue, setQueue] = useState<InstallEventPayload[]>([]);
  const active = queue[0] ?? null;
  const activeRef = useRef<InstallEventPayload | null>(null);
  activeRef.current = active;

  useEffect(() => {
    const off = window.electronAPI?.host?.onInstall?.((payload) =>
      setQueue((q) => [...q, payload])
    );
    return off;
  }, []);

  const openNative = useCallback<OpenNative>(
    (type, ref) => {
      if (type === "holaapp") {
        // Focus THIS app in the store so it opens its own install gate, rather
        // than dumping the user into a generic marketplace.
        setPendingHubApp(ref || null);
        setWorkspaceOverlay("apps");
        return;
      }
      setWorkspaceOverlay("customize");
      setPendingInstall({ type, ref });
    },
    [setWorkspaceOverlay, setPendingInstall, setPendingHubApp]
  );

  const handleDone = useCallback((result: InstallResult) => {
    const current = activeRef.current;
    if (current) {
      window.electronAPI?.host?.sendInstallResult?.(current.requestId, result);
    }
    setQueue((q) => q.slice(1));
  }, []);

  if (!active) {
    return null;
  }
  const common = { ref: active.ref, onDone: handleDone, openNative };
  switch (active.type) {
    case "mcp":
      return <McpInstallRunner key={active.requestId} {...common} />;
    case "skill":
      return (
        <SkillInstallRunner
          key={active.requestId}
          {...common}
          workspaceId={workspaceId}
        />
      );
    case "capability":
      return <CapabilityInstallRunner key={active.requestId} {...common} />;
    default:
      return <HolaAppInstallRunner key={active.requestId} {...common} />;
  }
}

// Always-mounted responder for the host `install.status` op: reports the skills,
// MCPs and capabilities installed in this workspace so a hosted page (HolaHub) can
// show "Installed" instead of offering "Install" again. Main augments the reply
// with its HolaApps.
//
// Capability caveat: the installed record's `capabilityId` equals the catalog id
// only for embedded/official capabilities (installed via `capabilities.install`).
// A community capability is installed by CREATING a fresh workspace capability
// (`capabilities.create`), so its id won't match the catalog ref and that card
// stays "Install" — acceptable until create carries the source ref.
export function InstallStatusResponder({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  const installedSkills = useWorkspaceSkills(workspaceId);
  const skillsRef = useRef(installedSkills.data);
  skillsRef.current = installedSkills.data;

  const installedCaps = useQuery(
    remoteApiQuery.capabilities.listInstalled.queryOptions({
      input: {},
      enabled: Boolean(workspaceId),
    })
  );
  const capsRef = useRef(installedCaps.data);
  capsRef.current = installedCaps.data;

  // HolaApps: report from the FULL catalog (backend-driven `installed` flags),
  // NOT main's `installedHolaAppIds` — that set is a subset (only Holaboss-hosted
  // `/mcp/<id>` apps; external / api-key apps like OmniSocials are excluded). Keep
  // the catalog fresh on mount + focus so an install elsewhere is reflected.
  const { catalog: appCatalog, refresh: refreshApps } = useHolaAppCatalog();
  const appsRef = useRef(appCatalog);
  appsRef.current = appCatalog;

  useEffect(() => {
    void refreshApps();
    const onFocus = () => void refreshApps();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshApps]);

  useEffect(() => {
    const off = window.electronAPI?.host?.onInstallStatus?.((payload) => {
      const items: InstalledItem[] = [
        ...(skillsRef.current?.skills ?? []).map((s) => ({
          type: "skill" as const,
          ref: s.skill_id,
        })),
        ...readInstalledMcpIds().map((id) => ({
          type: "mcp" as const,
          ref: id,
        })),
        ...(capsRef.current?.capabilities ?? []).map((c) => ({
          type: "capability" as const,
          ref: c.capabilityId,
        })),
        ...(appsRef.current ?? [])
          .filter((app) => app.installed)
          .map((app) => ({
            type: "holaapp" as const,
            ref: app.holaAppId,
          })),
      ];
      window.electronAPI?.host?.sendInstallStatus?.(payload.requestId, {
        items,
      });
    });
    return off;
  }, []);

  return null;
}
