import { getDeviceId } from "./device-id";

const UMAMI_HOST = "https://cloud.umami.is";
const UMAMI_WEBSITE_ID = "fcd99465-5997-4653-a519-bc9911c9609b";
// Umami uses `hostname` to bucket events; pin to a stable virtual host so
// desktop traffic shows up under one origin in the dashboard regardless of
// whether the renderer is on file:// (packaged) or localhost (dev).
const HOSTNAME = "desktop.holaos.ai";

type EventData = Record<
  string,
  string | number | boolean | null | undefined
>;

interface SendBody {
  type: "event";
  payload: {
    website: string;
    hostname: string;
    language: string;
    screen: string;
    url: string;
    referrer: string;
    name?: string;
    data?: EventData;
  };
}

let cachedUserId: string | null = null;

function basePayload(): SendBody["payload"] {
  const width = typeof window !== "undefined" ? window.screen?.width ?? 0 : 0;
  const height = typeof window !== "undefined" ? window.screen?.height ?? 0 : 0;
  const language =
    typeof navigator !== "undefined" ? navigator.language || "en" : "en";
  const url =
    typeof window !== "undefined" ? window.location?.pathname || "/" : "/";
  return {
    website: UMAMI_WEBSITE_ID,
    hostname: HOSTNAME,
    language,
    screen: `${width}x${height}`,
    url,
    referrer: "",
  };
}

async function send(body: SendBody): Promise<void> {
  try {
    await fetch(`${UMAMI_HOST}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      keepalive: true,
    });
  } catch {
    // Analytics must never break the app
  }
}

export function trackUmamiEvent(name: string, data?: EventData): void {
  const enriched: EventData = {
    surface: "desktop",
    device_id: getDeviceId(),
    ...(cachedUserId ? { user_id: cachedUserId } : {}),
    ...data,
  };
  void send({
    type: "event",
    payload: {
      ...basePayload(),
      name,
      data: enriched,
    },
  });
}

export function identifyUmamiUser(userId: string | null): void {
  if (userId === cachedUserId) {
    return;
  }
  cachedUserId = userId;
  if (!userId) {
    return;
  }
  trackUmamiEvent("identify", { user_id: userId });
}
