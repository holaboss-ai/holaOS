import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@holaboss/editor/styles.css";
import { recordLaunch } from "./lib/analytics/device-id";
import { trackUmamiEvent } from "./lib/analytics/umami";

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

const sessionStartedAt = Date.now();
window.addEventListener("beforeunload", () => {
  trackUmamiEvent("desktop_quit", {
    session_duration_ms: Date.now() - sessionStartedAt,
    platform: platform ?? null,
  });
});

const rootElement = document.getElementById("root")!;
ReactDOM.createRoot(rootElement).render(<App />);
