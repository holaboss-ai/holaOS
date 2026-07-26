import { BetaTag } from "@/components/ui/beta-tag";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Globe,
  type IconType,
  Image,
  LayoutGrid,
  Loader2,
  MessageCircle,
  Pencil,
  PenLine,
  Plug,
  Puzzle,
  RefreshCw,
  Rocket,
  Search,
  Send,
  Sparkles,
  Trash2,
  Users,
  Wand2,
  Zap,
} from "@/components/ui/icons";
import type {
  AppCatalogEntry,
  AppDetailFeature,
} from "@/lib/holaAppMarketplace";
import { ConnectionAccounts } from "./ConnectionAccounts";
import { HolaAppIcon } from "./HolaAppIcon";

// Fallback detail content. The catalog entry (backend-managed) may carry rich
// per-app `detail` (overview / features / screenshots); anything it omits falls
// back to the synthetic, platform-level copy below — so every app still renders
// a complete detail page, and an app opts into real copy field by field.
function overviewText(entry: AppCatalogEntry): string {
  const authored = entry.detail?.overview?.trim();
  if (authored) {
    return authored;
  }
  const blurb = entry.description?.trim();
  return [
    `${entry.title} is a HolaApp for your holaOS workspace.`,
    blurb || null,
    "Once installed it lives in your sidebar, and your agent can operate its tools directly from chat — so you get things done by just asking.",
  ]
    .filter(Boolean)
    .join(" ");
}

const SYNTHETIC_FEATURES: AppDetailFeature[] = [
  {
    icon: "sparkles",
    title: "Agent-operated",
    body: "Ask in plain language — your agent drives this app's tools for you, no clicking through menus.",
  },
  {
    icon: "zap",
    title: "One keystroke away",
    body: "Installs straight into your sidebar so it's always within reach.",
  },
  {
    icon: "puzzle",
    title: "Shares your workspace",
    body: "Runs alongside your other apps, memory, and connections — same context, same agent.",
  },
];

// Named icon keys the catalog may use on a feature card → renderer glyphs (per
// the desktop icon rule: icons live in the renderer, the catalog only names one).
// Unknown / omitted keys fall back to a generic glyph.
const FEATURE_ICONS: Record<string, IconType> = {
  sparkles: Sparkles,
  zap: Zap,
  bolt: Zap,
  puzzle: Puzzle,
  plug: Plug,
  search: Search,
  pencil: Pencil,
  edit: Pencil,
  write: PenLine,
  clock: Clock,
  calendar: Clock,
  schedule: Clock,
  send: Send,
  publish: Send,
  share: Send,
  bell: Bell,
  message: MessageCircle,
  chat: MessageCircle,
  file: FileText,
  page: FileText,
  doc: FileText,
  book: BookOpen,
  globe: Globe,
  web: Globe,
  users: Users,
  team: Users,
  refresh: RefreshCw,
  wand: Wand2,
  magic: Wand2,
  grid: LayoutGrid,
  apps: LayoutGrid,
  chart: BarChart3,
  analytics: BarChart3,
  rocket: Rocket,
  bot: Bot,
  agent: Bot,
  check: CheckCircle2,
  image: Image,
};

function featureIcon(key?: string): IconType {
  return (key ? FEATURE_ICONS[key.toLowerCase()] : undefined) ?? Sparkles;
}

export function HolaAppDetailView({
  entry,
  busy,
  workspaceId,
  onBack,
  onToggle,
  onOpen,
}: {
  entry: AppCatalogEntry;
  busy: boolean;
  /** Active workspace — needed to read/set the per-workspace default account. */
  workspaceId: string | null;
  onBack: () => void;
  onToggle: () => void;
  /** Open the installed app's surface (a fresh draft beside it). */
  onOpen: () => void;
}) {
  const integrations = entry.integrations ?? [];
  const comingSoon = !entry.installed && entry.status === "coming_soon";
  const features =
    entry.detail?.features && entry.detail.features.length > 0
      ? entry.detail.features
      : SYNTHETIC_FEATURES;
  const screenshots = entry.detail?.screenshots ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <button
          className="-mx-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-foreground/6 hover:text-foreground"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft className="size-4" /> All apps
        </button>

        <div className="mt-5 flex items-start gap-4">
          <HolaAppIcon
            hero
            holaAppId={entry.holaAppId}
            iconUrl={entry.iconUrl}
            title={entry.title}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 truncate font-semibold text-foreground text-xl">
                {entry.title}
              </h2>
              {entry.badge ? <BetaTag label={entry.badge} /> : null}
            </div>
            {entry.description ? (
              <p className="mt-1 text-muted-foreground text-sm leading-relaxed">
                {entry.description}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {entry.installed && !comingSoon ? (
              <Button onClick={onOpen} type="button" variant="default">
                <ArrowUpRight className="size-4" /> Open
              </Button>
            ) : null}
            <Button
              disabled={busy || comingSoon}
              onClick={onToggle}
              type="button"
              variant={entry.installed ? "outline" : "default"}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : comingSoon ? (
                "Coming soon"
              ) : entry.installed ? (
                <>
                  <Trash2 className="size-4" /> Uninstall
                </>
              ) : (
                <>
                  <Download className="size-4" /> Install
                </>
              )}
            </Button>
          </div>
        </div>

        <section className="mt-8">
          <h3 className="font-medium text-foreground text-sm">Overview</h3>
          <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
            {overviewText(entry)}
          </p>
        </section>

        <section className="mt-8">
          <h3 className="font-medium text-foreground text-sm">What you can do</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {features.map((feature) => {
              const Icon = featureIcon(feature.icon);
              return (
                <div
                  className="rounded-xl border border-border bg-card p-4"
                  key={feature.title}
                >
                  <Icon className="size-5 text-foreground" />
                  <div className="mt-2 font-medium text-foreground text-sm">
                    {feature.title}
                  </div>
                  <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                    {feature.body}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {integrations.length > 0 ? (
          <section className="mt-8">
            <h3 className="font-medium text-foreground text-sm">Connections</h3>
            <div className="mt-3 flex flex-col gap-6">
              {integrations.map((integration) => (
                <div key={integration.provider}>
                  <div className="flex items-center gap-2">
                    <Plug className="size-4 text-muted-foreground" />
                    <span className="flex-1 text-foreground text-sm capitalize">
                      {integration.provider}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {integration.required ? "Required" : "Optional"}
                    </span>
                  </div>
                  <ConnectionAccounts
                    appTitle={entry.title}
                    className="mt-3"
                    provider={integration.provider}
                    workspaceId={workspaceId}
                  />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {screenshots.length > 0 ? (
          <section className="mt-8">
            <h3 className="font-medium text-foreground text-sm">Preview</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {screenshots.map((shot) => (
                <div
                  className="grid aspect-video place-items-center overflow-hidden rounded-xl border border-border bg-foreground/[0.02]"
                  key={shot.url}
                >
                  {/* biome-ignore lint/performance/noImgElement: catalog previews are remote URLs, not bundled assets */}
                  <img
                    alt={shot.alt ?? `${entry.title} preview`}
                    className="h-full w-full object-cover"
                    loading="lazy"
                    src={shot.url}
                  />
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
