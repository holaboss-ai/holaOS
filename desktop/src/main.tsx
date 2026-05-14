import * as Sentry from "@sentry/electron/renderer";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@holaboss/editor/styles.css";
import { recordLaunch } from "./lib/analytics/device-id";
import { trackUmamiEvent } from "./lib/analytics/umami";
import {
  enrichRendererSentryEvent,
  pushRendererSentryActivity,
} from "./lib/rendererSentry";

Sentry.init({
  enableLogs: true,
  maxBreadcrumbs: 200,
  integrations: [
    Sentry.consoleLoggingIntegration({
      levels: ["warn", "error"],
    }),
    Sentry.eventLoopBlockIntegration({
      threshold: 2000,
    }),
  ],
  beforeSend(event, hint) {
    return enrichRendererSentryEvent(event, hint);
  },
});
Sentry.setTag("process_kind", "electron_renderer");
pushRendererSentryActivity("lifecycle", "renderer initialized", {
  pathname: window.location.pathname,
  search: window.location.search,
});
window.addEventListener("online", () => {
  pushRendererSentryActivity("connectivity", "renderer went online", {
    online: true,
  });
});
window.addEventListener("offline", () => {
  pushRendererSentryActivity("connectivity", "renderer went offline", {
    online: false,
  });
});
document.addEventListener("visibilitychange", () => {
  pushRendererSentryActivity("visibility", "renderer visibility changed", {
    visibility_state: document.visibilityState,
    focused: document.hasFocus(),
  });
});

// Stamp platform on <html> so CSS can opt into translucent surfaces on
// macOS (where the BrowserWindow has vibrancy enabled). Other platforms
// keep solid surfaces — the OS material isn't there to show through.
const platform = window.electronAPI?.platform;
if (platform) {
  document.documentElement.dataset.platform = platform;
}

const launch = recordLaunch();
if (launch) {
  trackUmamiEvent("desktop_launched", {
    is_first_launch: launch.isFirstLaunch,
    platform: platform ?? null,
    electron_version: window.electronAPI?.versions?.electron ?? null,
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
