import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useAtom, useSetAtom } from "jotai";
import {
  CalendarClock,
  Check,
  ChevronDown,
  FileText,
  File as FileIconBase,
  FileImage,
  FileSpreadsheet,
  Inbox,
  Keyboard,  type IconType,
  Package,
  PanelLeftClose,
  Settings,
  Sparkles,
  X,
} from "@/components/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { cn } from "@/lib/utils";
import { modifierKeyLabel } from "./keyboardShortcuts";
import {
  focusModeAtom,
  searchOpenAtom,
  settingsOpenAtom,
  shortcutsHelpOpenAtom,
  sidebarCollapsedAtom,
} from "./state/ui";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";
import { PinStarButton } from "./PinStarButton";

export function SearchDialog() {
  const [open, setOpen] = useAtom(searchOpenAtom);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Popup
          className="fixed top-[18%] left-1/2 z-[100] w-[600px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl outline-none backdrop-blur-2xl ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {open ? <SearchContent onSelect={() => setOpen(false)} /> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SearchContent({ onSelect }: { onSelect: () => void }) {  const { selectedWorkspaceId } = useWorkspaceSelection();
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);  const setFocusMode = useSetAtom(focusModeAtom);
  const setShortcutsHelpOpen = useSetAtom(shortcutsHelpOpenAtom);

  const close = onSelect;
  const wrap = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <Command className="bg-transparent">
      <CommandInput placeholder="Search content or actions…" />
      <CommandList className="max-h-[460px] px-1.5 pt-1 pb-2">
        <CommandEmpty>
          <div className="px-3 py-6 text-center text-sm text-foreground/55">
            No matches.
            <span className="ml-1 text-foreground/40">
              Try a different keyword.
            </span>
          </div>
        </CommandEmpty>

        <CommandGroup heading="Actions">
          <ActionItem
            label="Toggle sidebar"
            shortcut={`${modifierKeyLabel()}\\`}
            icon={PanelLeftClose}
            onSelect={wrap(() => setSidebarCollapsed((prev) => !prev))}
          />
          <ActionItem
            label="Toggle chat mode"
            shortcut={`${modifierKeyLabel()}.`}
            icon={Sparkles}
            onSelect={wrap(() => setFocusMode((prev) => !prev))}
          />
          <ActionItem
            label="Settings"
            shortcut={`${modifierKeyLabel()},`}
            icon={Settings}
            onSelect={wrap(() => setSettingsOpen(true))}
          />
          <ActionItem
            label="Keyboard shortcuts"
            shortcut="?"
            icon={Keyboard}
            onSelect={wrap(() => setShortcutsHelpOpen(true))}
          />
        </CommandGroup>

        {selectedWorkspaceId ? (
          <ContentSearchSection
            workspaceId={selectedWorkspaceId}
            onClose={close}
          />
        ) : null}
      </CommandList>

      <div className="flex items-center justify-between border-t border-border bg-foreground/[0.02] px-3 py-2 text-xs text-foreground/55">
        <span className="flex items-center gap-1.5">
          <span className="inline-flex gap-0.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
          navigate
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          open
          <span className="mx-1 text-foreground/35">·</span>
          <Kbd>esc</Kbd>
          close
        </span>
      </div>
    </Command>
  );
}

// Shared chip surface for any row that needs a square icon-on-tinted-
// surface lead glyph (actions, content). `tone` carries meaning — the
// colour tells you what kind of thing the row is (content type, brand
// action) at a glance, not decoration.
type ChipTone = "neutral" | "info" | "success" | "warning" | "brand";

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "bg-foreground/[0.05] text-foreground/60",
  info: "bg-info/10 text-info",
  success: "bg-success/10 text-success",
  warning: "bg-warning/15 text-warning",
  brand: "bg-primary/10 text-primary",
};

function RowIconChip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: ChipTone;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center overflow-hidden rounded-md [&_svg]:size-3.5",
        CHIP_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

function ActionItem({
  label,
  shortcut,
  icon: Icon,
  tone,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  icon: IconType;
  tone?: ChipTone;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`action ${label}`}
      onSelect={onSelect}
      className="group/cmd-item gap-2.5 py-1.5"
    >
      <RowIconChip tone={tone}>
        <Icon />
      </RowIconChip>
      <span className="flex-1 truncate text-sm">{label}</span>
      {shortcut ? (
        <span className="text-xs text-foreground/55">{shortcut}</span>
      ) : null}
    </CommandItem>
  );
}

type DateRangePreset = "all" | "today" | "7d" | "30d";

const DATE_RANGE_OPTIONS: ReadonlyArray<{
  id: DateRangePreset;
  label: string;
}> = [
  { id: "all", label: "Any time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

function dateRangeLabel(preset: DateRangePreset): string {
  return (
    DATE_RANGE_OPTIONS.find((o) => o.id === preset)?.label ?? "Any time"
  );
}

function dateRangePayload(
  preset: DateRangePreset,
): { start?: string; end?: string } | null {
  if (preset === "all") return null;
  const now = new Date();
  const end = now.toISOString();
  if (preset === "today") {
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).toISOString();
    return { start, end };
  }
  const days = preset === "7d" ? 7 : 30;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { start, end };
}

function formatRelativeShort(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (!normalized) return "";
  const ms = Date.now() - Date.parse(normalized);
  if (Number.isNaN(ms)) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  return `${years}y`;
}

function outputIconFor(output: WorkspaceOutputRecordPayload): IconType {
  const path = (output.file_path ?? "").toLowerCase();
  const ext = path.includes(".") ? path.split(".").pop() : "";
  if (ext === "csv" || ext === "xlsx" || ext === "tsv") {
    return FileSpreadsheet;
  }
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "gif" ||
    ext === "webp" ||
    ext === "svg"
  ) {
    return FileImage;
  }
  if (output.module_id) return Package;
  if (output.file_path) return FileText;
  return FileIconBase;
}

function chipToneForOutput(output: WorkspaceOutputRecordPayload): ChipTone {
  const path = (output.file_path ?? "").toLowerCase();
  const ext = path.includes(".") ? path.split(".").pop() : "";
  if (ext === "csv" || ext === "xlsx" || ext === "tsv") return "success";
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "gif" ||
    ext === "webp" ||
    ext === "svg"
  ) {
    return "warning";
  }
  if (output.module_id) return "brand";
  if (output.file_path || output.title) return "info";
  return "neutral";
}

// Parse a snippet that contains <mark>...</mark> tags into safe React nodes.
// Anything outside <mark> is rendered as plain text; <mark> contents get the
// highlight styling. We avoid dangerouslySetInnerHTML since the snippet is
// user-content.
function renderHighlighted(snippet: string): React.ReactNode {
  if (!snippet) return null;
  const segments: React.ReactNode[] = [];
  const regex = /<mark>([\s\S]*?)<\/mark>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while (true) {
    match = regex.exec(snippet);
    if (!match) break;
    if (match.index > cursor) {
      segments.push(snippet.slice(cursor, match.index));
    }
    segments.push(
      <mark
        key={`hl-${key++}`}
        className="rounded-[3px] bg-primary/15 px-0.5 text-foreground"
      >
        {match[1]}
      </mark>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < snippet.length) {
    segments.push(snippet.slice(cursor));
  }
  return segments;
}

function useContentSearchQuery(): string {
  const [query, setQuery] = useState("");
  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[cmdk-input=""]',
    );
    if (!input) return;
    setQuery(input.value);
    const handler = (event: Event) => {
      const target = event.target as HTMLInputElement | null;
      if (target) setQuery(target.value);
    };
    input.addEventListener("input", handler);
    return () => {
      input.removeEventListener("input", handler);
    };
  }, []);
  return query;
}

function ContentSearchSection({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const query = useContentSearchQuery();
  const trimmed = query.trim();
  const [dateRange, setDateRange] = useState<DateRangePreset>("all");
  const [results, setResults] = useState<
    WorkspaceOutputSearchResultPayload[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const requestRef = useRef(0);
  const { openOutput, openUrlInBrowserTab, openFileInInternalTab } =
    useOpenWorkspaceOutput();

  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setIsLoading(false);
      return;
    }
    const reqId = ++requestRef.current;
    setIsLoading(true);
    const filters: WorkspaceOutputSearchFiltersPayload = {};
    const range = dateRangePayload(dateRange);
    if (range) filters.dateRange = range;
    const timer = window.setTimeout(() => {
      window.electronAPI.workspace
        .searchOutputs({
          workspaceId,
          query: trimmed,
          filters,
          limit: 20,
        })
        .then((response) => {
          if (reqId !== requestRef.current) return;
          setResults(response.results ?? []);
        })
        .catch(() => {
          if (reqId !== requestRef.current) return;
          setResults([]);
        })
        .finally(() => {
          if (reqId !== requestRef.current) return;
          setIsLoading(false);
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
    };
  }, [workspaceId, trimmed, dateRange]);

  const handleOpen = useCallback(
    async (result: WorkspaceOutputSearchResultPayload) => {
      onClose();
      await openOutput(result.output);
    },
    [openOutput, onClose],
  );

  const handleOpenNewTab = useCallback(
    async (result: WorkspaceOutputSearchResultPayload) => {
      onClose();
      const output = result.output;
      const moduleId = (output.module_id || "").trim().toLowerCase();
      if (moduleId) {
        try {
          const metadata = (output.metadata ?? {}) as Record<string, unknown>;
          const presentation = metadata.presentation as
            | { kind?: string; view?: string; path?: string }
            | undefined;
          const hasAppPresentation =
            presentation?.kind === "app_resource" && presentation?.view;
          let path: string | undefined =
            hasAppPresentation && presentation?.path
              ? presentation.path
              : undefined;
          if (!path) {
            const view = hasAppPresentation
              ? presentation?.view
              : output.output_type === "post"
                ? "posts"
                : output.output_type || "home";
            const resourceId = output.module_resource_id;
            if (resourceId) {
              const encoded = encodeURIComponent(resourceId);
              path =
                view === "home" ? `/posts/${encoded}` : `/${view}/${encoded}`;
            } else if (view && view !== "home") {
              path = `/${view}`;
            }
          }
          const url = await window.electronAPI.appSurface.resolveUrl(
            workspaceId,
            moduleId,
            path,
          );
          await openUrlInBrowserTab(url, { forceNewTab: true });
          return;
        } catch {
          // fall through to file fallback
        }
      }
      if (output.file_path) {
        openFileInInternalTab(output.file_path);
      }
    },
    [onClose, openFileInInternalTab, openUrlInBrowserTab, workspaceId],
  );

  // ⌘+Enter opens the currently highlighted content result in a new tab.
  useEffect(() => {
    if (!trimmed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const selected = document.querySelector<HTMLElement>(
        '[cmdk-item][data-selected="true"]',
      );
      const value = selected?.getAttribute("data-value") ?? "";
      if (!value.startsWith("content:")) return;
      const id = value.slice("content:".length).split(" ")[0];
      const match = results.find((r) => r.output.id === id);
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      void handleOpenNewTab(match);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [results, trimmed, handleOpenNewTab]);

  const hasActiveFilter = dateRange !== "all";

  if (!trimmed && !hasActiveFilter) return null;

  return (
    <>
      <div
        className="flex items-center gap-1.5 px-2 pt-2 pb-1.5"
        // Keep these chips out of cmdk's keyboard nav so up/down stays on rows.
        cmdk-group=""
        role="presentation"
      >
        <DateRangeChip value={dateRange} onChange={setDateRange} />
        {hasActiveFilter ? (
          <button
            type="button"
            onClick={() => setDateRange("all")}
            className="ml-auto inline-flex items-center gap-1 text-xs text-foreground/55 transition-colors hover:text-foreground"
          >
            <X className="size-3" />
            Clear
          </button>
        ) : null}
      </div>
      <CommandGroup heading="Content">
        {isLoading && results.length === 0 ? (
          <div className="px-3 py-2 text-xs text-foreground/55">
            Searching…
          </div>
        ) : null}
        {!isLoading && trimmed && results.length === 0 ? (
          <div className="px-3 py-2 text-xs text-foreground/55">
            No content matches.
          </div>
        ) : null}
        {results.map((result) => (
          <ContentResultRow
            key={`content-${result.output.id}`}
            result={result}
            producerName={
              result.output.metadata &&
              typeof result.output.metadata === "object"
                ? resolveProducerName(
                    result.output.metadata as Record<string, unknown>,
                  )
                : null
            }
            onSelect={() => void handleOpen(result)}
          />
        ))}
      </CommandGroup>
    </>
  );
}

function resolveProducerName(
  metadata: Record<string, unknown>,
): string | null {
  const producerName =
    typeof metadata.producer_name === "string"
      ? (metadata.producer_name as string)
      : null;
  return producerName;
}

function DateRangeChip({
  value,
  onChange,
}: {
  value: DateRangePreset;
  onChange: (next: DateRangePreset) => void;
}) {
  const active = value !== "all";
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors outline-none",
          active
            ? "border-primary/30 bg-primary/10 text-foreground"
            : "border-border bg-foreground/[0.03] text-foreground/70 hover:text-foreground",
        )}
      >
        <CalendarClock className="size-3" />
        <span>{dateRangeLabel(value)}</span>
        <ChevronDown className="size-3 text-foreground/45" />
      </MenuPrimitive.Trigger>
      {/* Portaled above the z-[100] search dialog so the menu isn't clipped
          by the list's overflow or hidden behind the popup. */}
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          className="isolate z-[110] outline-none"
          align="start"
          side="bottom"
          sideOffset={6}
        >
          <MenuPrimitive.Popup className="min-w-[160px] overflow-hidden rounded-lg border border-border bg-popover/95 p-1 shadow-lg outline-none backdrop-blur-2xl">
            <MenuPrimitive.RadioGroup
              value={value}
              onValueChange={(next) => onChange(next as DateRangePreset)}
            >
              {DATE_RANGE_OPTIONS.map((option) => (
                <MenuPrimitive.RadioItem
                  key={option.id}
                  value={option.id}
                  className="relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pr-8 pl-2.5 text-xs text-foreground/80 outline-none data-highlighted:bg-fg-6"
                >
                  <span className="flex-1">{option.label}</span>
                  <MenuPrimitive.RadioItemIndicator className="absolute right-2 inline-flex">
                    <Check className="size-3" />
                  </MenuPrimitive.RadioItemIndicator>
                </MenuPrimitive.RadioItem>
              ))}
            </MenuPrimitive.RadioGroup>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

function ContentResultRow({
  result,
  producerName,
  onSelect,
}: {
  result: WorkspaceOutputSearchResultPayload;
  producerName: string | null;
  onSelect: () => void;
}) {
  const { output } = result;
  const Icon = outputIconFor(output);
  const title = output.title || output.file_path || "Untitled";
  const relative = formatRelativeShort(output.updated_at || output.created_at);
  return (
    <CommandItem
      value={`content:${output.id} ${title} ${output.file_path ?? ""}`}
      onSelect={onSelect}
      className="group/cmd-item gap-2.5 py-1.5"
    >
      <RowIconChip tone={chipToneForOutput(output)}>
        <Icon />
      </RowIconChip>
      <span className="min-w-0 flex-1 truncate text-sm">
        {renderHighlighted(title)}
      </span>
      {producerName ? (
        <span className="shrink-0 rounded-[3px] bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-foreground/65">
          {producerName}
        </span>
      ) : null}
      {relative ? (
        <span className="shrink-0 text-[11px] tabular-nums text-foreground/45">
          {relative}
        </span>
      ) : null}
      <PinStarButton
        favorite={{
          kind: "output",
          workspaceId: output.workspace_id,
          outputId: output.id,
          title,
          filePath: output.file_path,
        }}
        notify
        className="opacity-0 transition-opacity group-hover/cmd-item:opacity-100 group-data-[selected=true]/cmd-item:opacity-100"
      />
    </CommandItem>
  );
}
