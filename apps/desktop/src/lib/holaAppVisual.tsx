import {
  CloudFilled,
  FeedFilled,
  GlobeFilled,
  type IconType,
  MessageCircleFilled,
} from "@/components/ui/icons";

type HolaAppVisual = { Icon: IconType; className: string };

// Local glyph + tint for HolaApps that ship no real logo — without this they
// fall back to the generic Holaboss favicon (a bare orange arc that reads as a
// spinner). Keyed by holaAppId; the glyph reflects the app's function and the
// colour stays muted (one calm hue each, no brand orange/red).
const HOLA_APP_VISUALS: Record<string, HolaAppVisual> = {
  // Nutstore (坚果云) — cloud file storage.
  jianguoyun: { Icon: CloudFilled, className: "text-sky-500" },
  // Chat — conversational agent.
  chat: { Icon: MessageCircleFilled, className: "text-emerald-500" },
  // HolaFeed — AI-curated news/research feed.
  holafeed: { Icon: FeedFilled, className: "text-amber-500" },
  // Fiat — god-simulator over a synthetic world.
  fiat: { Icon: GlobeFilled, className: "text-violet-500" },
};

export function getHolaAppVisual(
  holaAppId: string | null | undefined,
): HolaAppVisual | null {
  if (!holaAppId) return null;
  return HOLA_APP_VISUALS[holaAppId] ?? null;
}
