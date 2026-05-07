import { useEffect, useMemo, useState } from "react";
import {
  FileText,
  Folder,
  ImageIcon,
  MessageCircle,
  Package,
  ShieldCheck,
} from "lucide-react";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { Badge } from "@/components/ui/badge";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { cn } from "@/lib/utils";
import { resolveAppDisplay, useWorkspaceDesktop } from "@/lib/workspaceDesktop";

const CATEGORY_LABELS: Record<string, string> = {
  marketing: "Marketing",
  growth: "Growth",
  operations: "Operations",
  general: "General",
};

interface AppSummary {
  id: string;
  label?: string;
}

export interface LivePreviewData {
  name: string;
  description: string;
  category: string;
  tags: string[];
  authorName: string;
  apps: AppSummary[];
  coverImage: string | null;
  screenshots: string[];
  readmeMd: string;
  onboardingMd: string;
}

export interface LivePreviewPanelProps {
  step: "about" | "bundle" | "docs";
  data: LivePreviewData;
  workspaceId: string;
  forceExcludePaths: string[];
}

function formatBytes(n: number): string {
  if (!n) {
    return "0 B";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function LivePreviewPanel({
  step,
  data,
  workspaceId,
  forceExcludePaths,
}: LivePreviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-hidden p-8">
      <div
        className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out"
        key={`preview-${step}`}
      >
        {step === "about" && <ListingMockup data={data} />}
        {step === "bundle" && (
          <BundleIllustration
            data={data}
            forceExcludePaths={forceExcludePaths}
            workspaceId={workspaceId}
          />
        )}
        {step === "docs" && <DocsMockup data={data} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Listing mockup — marketplace card / detail-page hybrid
// ---------------------------------------------------------------------------
function ListingMockup({ data }: { data: LivePreviewData }) {
  const displayName = data.name.trim() || "Your template name";
  const description =
    data.description.trim() ||
    "Your description appears here. Keep it tight — installers skim.";
  return (
    <div className="w-full max-w-[440px]">
      <div className="overflow-hidden rounded-2xl bg-background shadow-subtle-sm ring-1 ring-border/35">
        {/* Cover hero */}
        {data.coverImage ? (
          <img
            alt=""
            className="aspect-[1200/630] w-full object-cover"
            src={data.coverImage}
          />
        ) : (
          <div className="flex aspect-[1200/630] w-full flex-col items-center justify-center gap-1.5 bg-fg-4 text-muted-foreground">
            <ImageIcon className="size-5" />
            <p className="text-xs">Cover image will appear here</p>
          </div>
        )}

        {/* Body */}
        <div className="px-4 pt-4 pb-5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p
                className={cn(
                  "truncate text-[15px] font-semibold tracking-tight",
                  !data.name.trim() && "text-muted-foreground",
                )}
              >
                {displayName}
              </p>
              {data.authorName.trim() && (
                <p className="mt-0.5 text-xs text-muted-foreground">by {data.authorName.trim()}</p>
              )}
            </div>
            <span className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
              Install
            </span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1">
            <Badge className="text-xs" variant="secondary">
              {CATEGORY_LABELS[data.category] ?? data.category}
            </Badge>
            {data.tags.slice(0, 4).map((t) => (
              <Badge className="text-xs" key={t} variant="outline">
                {t}
              </Badge>
            ))}
            {data.tags.length > 4 && (
              <span className="text-xs text-muted-foreground">
                +{data.tags.length - 4}
              </span>
            )}
          </div>

          <p
            className={cn(
              "mt-3 text-[12.5px] leading-relaxed",
              data.description.trim()
                ? "text-foreground/85"
                : "text-muted-foreground",
            )}
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {description}
          </p>

          {/* Screenshots strip */}
          {data.screenshots.length > 0 && (
            <div className="mt-4 -mx-1 flex gap-1.5 overflow-hidden px-1">
              {data.screenshots.slice(0, 3).map((url, idx) => (
                <img
                  alt=""
                  className="h-16 w-auto shrink-0 rounded-md object-cover"
                  key={`${idx}-${url.slice(-12)}`}
                  src={url}
                />
              ))}
              {data.screenshots.length > 3 && (
                <span className="flex h-16 shrink-0 items-center rounded-md bg-fg-4 px-2 text-xs text-muted-foreground">
                  +{data.screenshots.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="mt-3 px-1 text-center text-xs text-muted-foreground">
        Marketplace card · viewers see this in the grid
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bundle illustration — clean card showing the *real* archive contents.
// Real app icons (via the canonical AppIcon resolver), one short privacy line,
// total size + file count footer. No pastel grid, no schematic bars.
// ---------------------------------------------------------------------------
interface FileEntry {
  path: string;
  isDir: boolean;
  totalBytes: number;
  fileCount: number;
}

interface BundleSummary {
  totalBytes: number;
  excludedBytes: number;
  fileCount: number;
  /** Top-level entries OUTSIDE of apps/* — apps already render as their own list. */
  topEntries: FileEntry[];
}

function BundleIllustration({
  data,
  workspaceId,
  forceExcludePaths,
}: {
  data: LivePreviewData;
  workspaceId: string;
  forceExcludePaths: string[];
}) {
  const [bundle, setBundle] = useState<BundleSummary | null>(null);
  const { appCatalog, composioToolkitsByProvider } = useWorkspaceDesktop();

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.workspace
      .previewBundle({
        workspaceId,
        apps: data.apps.map((a) => a.id),
        forceExcludePaths,
      })
      .then((p) => {
        if (cancelled) {
          return;
        }
        // Roll up included files (excluding apps/*) into top-level entries —
        // a file at root becomes one entry, a subdirectory aggregates as one.
        const map = new Map<string, FileEntry>();
        for (const f of p.included) {
          if (f.path.startsWith("apps/")) {
            continue;
          }
          const slashIdx = f.path.indexOf("/");
          if (slashIdx === -1) {
            map.set(f.path, {
              path: f.path,
              isDir: false,
              totalBytes: f.sizeBytes,
              fileCount: 1,
            });
          } else {
            const dir = f.path.slice(0, slashIdx);
            const existing = map.get(dir);
            if (existing) {
              existing.totalBytes += f.sizeBytes;
              existing.fileCount += 1;
            } else {
              map.set(dir, {
                path: dir,
                isDir: true,
                totalBytes: f.sizeBytes,
                fileCount: 1,
              });
            }
          }
        }
        // Sort: directories first (alpha), then root files (alpha).
        const topEntries = [...map.values()].sort((a, b) => {
          if (a.isDir !== b.isDir) {
            return a.isDir ? -1 : 1;
          }
          return a.path.localeCompare(b.path);
        });
        setBundle({
          totalBytes: p.totalIncludedBytes,
          excludedBytes: p.totalExcludedBytes,
          fileCount: p.included.length,
          topEntries,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, data.apps, forceExcludePaths]);

  const visibleEntries = useMemo(
    () => bundle?.topEntries.slice(0, 5) ?? [],
    [bundle],
  );
  const overflowCount = bundle
    ? Math.max(0, bundle.topEntries.length - visibleEntries.length)
    : 0;

  return (
    <div className="w-full min-w-md">
      <div className="overflow-hidden rounded-xl bg-background shadow-subtle-sm ring-1 ring-border/35">
        {/* Title strip */}
        <div className="flex items-center justify-between border-b border-border/35 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Package className="size-3.5 text-muted-foreground" />
            <p className="text-xs font-medium">Archive contents</p>
          </div>
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            {bundle ? formatBytes(bundle.totalBytes) : "—"}
          </p>
        </div>

        {/* Apps */}
        {data.apps.length === 0 ? (
          <p className="px-4 py-3 text-center text-xs text-muted-foreground">
            No apps selected — template will be docs-only
          </p>
        ) : (
          <div className="px-2 py-1.5">
            <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
              Apps
            </p>
            <ul>
              {data.apps.map((app) => {
                const catalogEntry = appCatalog.find(
                  (e) => e.app_id === app.id,
                );
                const providerId = catalogEntry?.provider_id ?? null;
                const display = resolveAppDisplay(
                  providerId,
                  composioToolkitsByProvider,
                );
                const resolvedLabel = display.name ?? app.label ?? app.id;
                return (
                  <li
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
                    key={app.id}
                  >
                    <AppIcon
                      iconUrl={display.logo}
                      appId={app.id}
                      providerId={providerId}
                      label={resolvedLabel}
                      size="row"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {resolvedLabel}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Files (top-level non-app entries). Hidden when the only files are
            inside apps/, otherwise shows up to 5 entries with a + N more chip. */}
        {visibleEntries.length > 0 && (
          <div className="border-t border-border/35 px-2 py-1.5">
            <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
              Files
            </p>
            <ul>
              {visibleEntries.map((entry) => (
                <li
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
                  key={entry.path}
                >
                  {entry.isDir ? (
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {entry.isDir ? `${entry.path}/` : entry.path}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {entry.isDir
                      ? `${entry.fileCount} files`
                      : formatBytes(entry.totalBytes)}
                  </span>
                </li>
              ))}
              {overflowCount > 0 && (
                <li className="px-2 pt-0.5 pb-1">
                  <span className="text-xs text-muted-foreground">
                    + {overflowCount} more
                  </span>
                </li>
              )}
            </ul>
          </div>
        )}

        {/* Privacy line + file count footer */}
        <div className="flex items-center justify-between border-t border-border/35 px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="size-3.5 text-success" />
            <p className="text-xs text-muted-foreground">
              Personal data excluded
            </p>
          </div>
          {bundle && (
            <p className="font-mono text-xs tabular-nums text-muted-foreground">
              {bundle.fileCount} files
            </p>
          )}
        </div>
      </div>

      <p className="mt-3 px-1 text-center text-xs text-muted-foreground">
        What ships in your template archive
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Docs mockup — TWO previews of TWO different experiences:
//   • README → marketplace detail-page render (a real page someone reads)
//   • First-run → a single chat bubble showing what the agent says when the
//     template is first opened (it's an agent script, not a doc to read)
// Tabs let the user switch. AI-generated content sometimes arrives wrapped in
// bare ``` code fences — stripped here so it never renders as a code block.
// ---------------------------------------------------------------------------
function stripOuterCodeFence(md: string): string {
  const trimmed = md.trim();
  // Match an opening fence (with or without language tag) on its own line,
  // then everything in between, then a closing fence.
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```\s*$/);
  return match ? match[1] : md;
}

/** Pull the first 1-2 sentences after the first heading or paragraph for the chat-bubble preview. */
function firstQuestionFromOnboarding(md: string): string {
  const lines = stripOuterCodeFence(md).split("\n");
  // Find the first numbered list item — that's the first question the script will ask.
  for (const raw of lines) {
    const line = raw.trim();
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      return numbered[1];
    }
    const bulleted = line.match(/^[-*]\s+(.+)$/);
    if (bulleted) {
      return bulleted[1];
    }
  }
  // Fallback: first non-heading, non-empty paragraph line.
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("```")) {
      continue;
    }
    return line;
  }
  return "";
}

function DocsMockup({ data }: { data: LivePreviewData }) {
  const hasReadme = data.readmeMd.trim().length > 0;
  const hasOnboarding = data.onboardingMd.trim().length > 0;

  // Default tab: prefer whichever has content; if both empty, README.
  const [tab, setTab] = useState<"readme" | "onboarding">(
    hasReadme ? "readme" : hasOnboarding ? "onboarding" : "readme",
  );

  const cleanReadme = useMemo(() => stripOuterCodeFence(data.readmeMd), [data.readmeMd]);
  const cleanOnboarding = useMemo(() => stripOuterCodeFence(data.onboardingMd), [data.onboardingMd]);
  const firstQuestion = useMemo(() => firstQuestionFromOnboarding(data.onboardingMd), [data.onboardingMd]);

  return (
    // Fixed width — empty / partial / full states should all occupy the same
    // canvas so the panel doesn't shift sideways as the user types README or
    // first-run content. Was `w-full max-w-[560px]` which collapsed to the
    // empty-state's natural width when both tabs had no content.
    <div className="w-[560px] max-w-full">
      <div className="overflow-hidden rounded-2xl bg-background shadow-subtle-sm ring-1 ring-border/35">
        {/* Tab strip */}
        <div className="flex items-center border-b border-border/35 px-3">
          <DocsTab active={tab === "readme"} hasContent={hasReadme} onClick={() => setTab("readme")}>
            <FileText className="size-3.5" />
            README
          </DocsTab>
          <DocsTab
            active={tab === "onboarding"}
            hasContent={hasOnboarding}
            onClick={() => setTab("onboarding")}
          >
            <MessageCircle className="size-3.5" />
            First-run
          </DocsTab>
        </div>

        {/* Body */}
        {tab === "readme" ? (
          <div className="h-[calc(100vh-240px)] overflow-y-auto px-6 py-6">
            {hasReadme ? (
              <div className="prose-tight text-sm">
                <SimpleMarkdown>{cleanReadme}</SimpleMarkdown>
              </div>
            ) : (
              <DocsEmptyState
                hint="Renders on the marketplace listing page."
                title="No README yet"
              />
            )}
          </div>
        ) : (
          <div className="h-[calc(100vh-240px)] overflow-y-auto px-6 py-6">
            {hasOnboarding ? (
              <div className="space-y-3">
                {/* Single chat bubble previewing the first question the agent will ask */}
                <div className="flex items-start gap-2.5">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <MessageCircle className="size-3" />
                  </span>
                  <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-fg-2 px-3 py-2 text-sm">
                    <p className="text-foreground">
                      {firstQuestion || "Hi! Let's get this template configured."}
                    </p>
                  </div>
                </div>
                {/* Collapsed full-script preview, monospace-but-readable */}
                <details className="group rounded-lg border border-border/40">
                  <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-fg-2 [&::-webkit-details-marker]:hidden">
                    <span>View full script</span>
                    <span className="font-mono group-open:rotate-90 transition-transform">›</span>
                  </summary>
                  <div className="border-t border-border/40 px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {cleanOnboarding}
                  </div>
                </details>
              </div>
            ) : (
              <DocsEmptyState
                hint="Runs in chat the first time someone opens this template."
                title="No first-run script yet"
              />
            )}
          </div>
        )}
      </div>

      <p className="mt-3 px-1 text-center text-xs text-muted-foreground">
        {tab === "readme"
          ? "What people see on the marketplace listing"
          : "What the agent runs the first time someone opens this template"}
      </p>
    </div>
  );
}

function DocsTab({
  active,
  hasContent,
  onClick,
  children,
}: {
  active: boolean;
  hasContent: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn(
        "relative inline-flex items-center gap-1.5 px-2.5 py-2.5 text-xs font-medium transition-colors focus-visible:[box-shadow:none!important]",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
      {!hasContent && (
        <span className="size-1 rounded-full bg-fg-32" aria-label="empty" />
      )}
      {active && (
        <span className="absolute right-2.5 bottom-0 left-2.5 h-px bg-foreground" />
      )}
    </button>
  );
}

function DocsEmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-2 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
