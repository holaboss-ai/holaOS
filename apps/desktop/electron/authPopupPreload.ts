import { contextBridge, ipcRenderer } from "electron";

import { loadDesktopEnv } from "./desktopEnv";

loadDesktopEnv();

interface AuthUserPayload {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  timezone?: string | null;
  [key: string]: unknown;
}

interface AuthErrorPayload {
  message?: string;
  status: number;
  statusText: string;
  path: string;
}

interface RuntimeConfigPayload {
  configPath: string | null;
  loadedFromFile: boolean;
  authTokenPresent: boolean;
  userId: string | null;
  sandboxId: string | null;
  modelProxyBaseUrl: string | null;
  defaultModel: string | null;
  subagentModel: string | null;
  defaultBackgroundModel: string | null;
  defaultImageModel: string | null;
  controlPlaneBaseUrl: string | null;
}

interface RuntimeConfigUpdatePayload {
  authToken?: string | null;
  modelProxyApiKey?: string | null;
  userId?: string | null;
  sandboxId?: string | null;
  modelProxyBaseUrl?: string | null;
  defaultModel?: string | null;
  subagentModel?: string | null;
  defaultBackgroundModel?: string | null;
  defaultImageModel?: string | null;
  controlPlaneBaseUrl?: string | null;
}

interface RuntimeStatusPayload {
  status: "disabled" | "missing" | "starting" | "running" | "stopped" | "error";
  available: boolean;
  runtimeRoot: string | null;
  sandboxRoot: string | null;
  executablePath: string | null;
  url: string | null;
  pid: number | null;
  harness: string | null;
  desktopBrowserReady: boolean;
  desktopBrowserUrl: string | null;
  startupMessage: string | null;
  lastError: string;
}

interface WorkspaceRecordPayload {
  id: string;
  name: string;
  status: string;
  harness: string | null;
  error_message: string | null;
  onboarding_status: string;
  onboarding_session_id: string | null;
  onboarding_completed_at: string | null;
  onboarding_completion_summary: string | null;
  onboarding_requested_at: string | null;
  onboarding_requested_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at_utc: string | null;
}

interface WorkspaceListResponsePayload {
  items: WorkspaceRecordPayload[];
  total: number;
  limit: number;
  offset: number;
}

type UiSettingsPaneSection = "account" | "billing" | "providers" | "integrations" | "submissions" | "settings" | "about";

const INTERNAL_DEV_BACKEND_OVERRIDES_ENABLED =
  Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.HOLABOSS_INTERNAL_DEV?.trim() === "1";
const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, "");
const configuredRemoteBaseUrl = (...envNames: string[]): string => {
  for (const envName of envNames) {
    const value = normalizeBaseUrl(
      (INTERNAL_DEV_BACKEND_OVERRIDES_ENABLED ? process.env[envName]?.trim() || "" : "") || process.env[envName]?.trim() || ""
    );
    if (value) {
      return value;
    }
  }
  return "";
};
const serviceBaseUrlFromHost = (baseUrl: string, port: number): string => {
  try {
    const parsed = new URL(baseUrl);
    const protocol = parsed.protocol || "http:";
    const hostname = parsed.hostname;
    if (!hostname) {
      return "";
    }
    return `${protocol}//${hostname}:${port}`;
  } catch {
    return "";
  }
};
const BACKEND_BASE_URL = configuredRemoteBaseUrl("HOLABOSS_BACKEND_BASE_URL");
const CONTROL_PLANE_BASE_URL =
  configuredRemoteBaseUrl("HOLABOSS_DESKTOP_CONTROL_PLANE_BASE_URL") ||
  serviceBaseUrlFromHost(BACKEND_BASE_URL, 3060);
const DEFAULT_MODEL_PROXY_BASE_URL = CONTROL_PLANE_BASE_URL ? `${CONTROL_PLANE_BASE_URL}/api/v1/model-proxy` : "";
const DEFAULT_RUNTIME_MODEL = "openai/gpt-5.4";

contextBridge.exposeInMainWorld("authPopup", {
  getDefaults: () => ({
    modelProxyBaseUrl: DEFAULT_MODEL_PROXY_BASE_URL,
    defaultModel: DEFAULT_RUNTIME_MODEL
  }),
  getUser: () => ipcRenderer.invoke("auth:getUser") as Promise<AuthUserPayload | null>,
  requestAuth: () => ipcRenderer.invoke("auth:requestAuth") as Promise<void>,
  signOut: () => ipcRenderer.invoke("auth:signOut") as Promise<void>,
  setTheme: (theme: string) => ipcRenderer.invoke("ui:setTheme", theme) as Promise<void>,
  getRuntimeConfig: () => ipcRenderer.invoke("runtime:getConfig") as Promise<RuntimeConfigPayload>,
  getRuntimeStatus: () => ipcRenderer.invoke("runtime:getStatus") as Promise<RuntimeStatusPayload>,
  setRuntimeConfig: (payload: RuntimeConfigUpdatePayload) =>
    ipcRenderer.invoke("runtime:setConfig", payload) as Promise<RuntimeConfigPayload>,
  exchangeBinding: (sandboxId: string) => ipcRenderer.invoke("runtime:exchangeBinding", sandboxId) as Promise<RuntimeConfigPayload>,
  listWorkspaces: () => ipcRenderer.invoke("workspace:listWorkspaces") as Promise<WorkspaceListResponsePayload>,
  openSettingsPane: (section?: UiSettingsPaneSection) => ipcRenderer.invoke("ui:openSettingsPane", section) as Promise<void>,
  openExternalUrl: (url: string) => ipcRenderer.invoke("ui:openExternalUrl", url) as Promise<void>,
  scheduleClose: (delayMs?: number) => ipcRenderer.invoke("auth:scheduleClosePopup", delayMs) as Promise<void>,
  cancelClose: () => ipcRenderer.invoke("auth:cancelClosePopup") as Promise<void>,
  close: () => ipcRenderer.invoke("auth:closePopup") as Promise<void>,
  onAuthenticated: (listener: (user: AuthUserPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, user: AuthUserPayload) => listener(user);
    ipcRenderer.on("auth:authenticated", wrapped);
    return () => ipcRenderer.removeListener("auth:authenticated", wrapped);
  },
  onUserUpdated: (listener: (user: AuthUserPayload | null) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, user: AuthUserPayload | null) => listener(user);
    ipcRenderer.on("auth:userUpdated", wrapped);
    return () => ipcRenderer.removeListener("auth:userUpdated", wrapped);
  },
  onError: (listener: (payload: AuthErrorPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AuthErrorPayload) => listener(payload);
    ipcRenderer.on("auth:error", wrapped);
    return () => ipcRenderer.removeListener("auth:error", wrapped);
  },
  onRuntimeConfigChange: (listener: (payload: RuntimeConfigPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RuntimeConfigPayload) => listener(payload);
    ipcRenderer.on("runtime:config", wrapped);
    return () => ipcRenderer.removeListener("runtime:config", wrapped);
  },
  onRuntimeStateChange: (listener: (payload: RuntimeStatusPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RuntimeStatusPayload) => listener(payload);
    ipcRenderer.on("runtime:state", wrapped);
    return () => ipcRenderer.removeListener("runtime:state", wrapped);
  },
  onOpened: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("auth:opened", wrapped);
    return () => ipcRenderer.removeListener("auth:opened", wrapped);
  }
});
