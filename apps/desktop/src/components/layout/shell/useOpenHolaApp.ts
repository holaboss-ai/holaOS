import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import type {
  ApiKeyInstall,
  CommandMcpInstall,
  HostedMcpInstall,
} from "@/lib/holaAppMarketplace";
import {
  activeWebAppSurfaceAtom,
  focusModeAtom,
  preHolaAppSessionIdAtom,
  projectViewAtom,
  selectedSessionIdAtom,
  workspaceOverlayAtom,
} from "./state/ui";

/**
 * Opens a web HolaApp (need-review et al.) as its own dedicated center-column
 * pane — backed by the native web-surface BrowserView. It takes the middle
 * column while the chat panel stays beside it, so "Discuss" lands in context.
 * Not a tab: there's no entry in the center tab strip.
 */
export function useOpenHolaApp() {
  const store = useStore();
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  const setPreHolaAppSession = useSetAtom(preHolaAppSessionIdAtom);

  return useCallback(
    (params: {
      holaAppId: string;
      title: string;
      path?: string;
      /** Absolute URL for third-party apps (e.g. Notion); when omitted the
       * surface derives `<WEB_APP_BASE_URL>/apps/<holaAppId>`. */
      url?: string;
      /** Declared integrations — folded into the copilot's context as a soft
       * hint about which connections/tools may be relevant in this app. */
      integrations?: { provider: string; required: boolean }[];
      /** MCP tool names — the bundled-MCP counterpart of `integrations` for the
       * same soft tool hint (apps use one or the other). */
      mcpTools?: string[];
      /** API-key install config (OmniSocials, Publora) — carried so the
       * surface-based gate can render it. */
      apiKeyInstall?: ApiKeyInstall;
      /** Hosted-MCP install config (坚果云) — carried so the surface-based gate can
       * render its credential fields + attach the Holaboss-hosted MCP on submit. */
      hostedMcpInstall?: HostedMcpInstall;
      /** Command/stdio MCP install (drawio) — when present, ensure the local MCP
       * server is attached + its editor is up BEFORE the surface loads, so
       * opening the app (from the sidebar, not just install) brings it live. */
      commandMcpInstall?: CommandMcpInstall;
    }) => {
      // Ensure-up on launch: attaching the command MCP is idempotent in main and
      // (re)starts the local editor server the surface loads. Fire-and-forget —
      // the surface's own load handles the brief boot window.
      if (params.commandMcpInstall) {
        void window.electronAPI.holaApps?.attachCommandMcp?.({
          holaAppId: params.holaAppId,
          command: params.commandMcpInstall.command,
          env: params.commandMcpInstall.env ?? {},
        });
      }
      // Remember the session open before the app so closing it can return here
      // (the app opens its own fresh draft chat, replacing the selection).
      const prevSession = store.get(selectedSessionIdAtom);
      setPreHolaAppSession(prevSession && prevSession.trim() ? prevSession : null);
      setProjectView(null);
      setWorkspaceOverlay(null);
      setFocusMode(false);
      setActiveWebAppSurface({
        holaAppId: params.holaAppId,
        title: params.title,
        ...(params.path ? { path: params.path } : {}),
        ...(params.url ? { url: params.url } : {}),
        ...(params.integrations ? { integrations: params.integrations } : {}),
        ...(params.mcpTools ? { mcpTools: params.mcpTools } : {}),
        ...(params.apiKeyInstall ? { apiKeyInstall: params.apiKeyInstall } : {}),
        ...(params.hostedMcpInstall
          ? { hostedMcpInstall: params.hostedMcpInstall }
          : {}),
      });
    },
    [
      store,
      setPreHolaAppSession,
      setProjectView,
      setWorkspaceOverlay,
      setFocusMode,
      setActiveWebAppSurface,
    ],
  );
}
