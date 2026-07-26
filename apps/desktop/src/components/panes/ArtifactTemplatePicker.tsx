import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  FileText,
  Loader2,
  Search,
  Sparkles,
  Trash2,
  X,
} from "@/components/ui/icons";
import {
  chatComposerPrefillAtom,
  focusModeAtom,
} from "@/components/layout/shell/state/ui";
import { useReferenceFileInChat } from "@/components/layout/shell/useReferenceFileInChat";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { FileTypeIcon } from "@/lib/fileIcon";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

const UNCATEGORIZED = "Uncategorized";

interface ArtifactTemplatePickerProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (output: WorkspaceOutputRecordPayload) => void;
}

function TemplateThumbnail({
  preview,
  ext,
}: {
  preview: ArtifactTemplatePreviewPayload | undefined;
  ext: string;
}) {
  if (preview?.kind === "image" && preview.dataUrl) {
    return (
      <img
        src={preview.dataUrl}
        alt=""
        className="h-full w-full object-cover"
      />
    );
  }
  if (preview?.kind === "text" && preview.text) {
    return (
      <div className="h-full w-full overflow-hidden bg-background p-2">
        <p className="whitespace-pre-wrap break-words font-sans text-[7px] leading-[1.5] text-foreground/70">
          {preview.text}
        </p>
      </div>
    );
  }
  // No renderable preview (binary doc, etc.) — fall back to the file-type icon
  // for the template's extension rather than a generic glyph.
  return (
    <div className="grid h-full place-items-center">
      <FileTypeIcon filePath={`template${ext}`} size={30} />
    </div>
  );
}

export function ArtifactTemplatePicker({
  workspaceId,
  open,
  onOpenChange,
  onCreated,
}: ArtifactTemplatePickerProps) {
  const [templates, setTemplates] = useState<ArtifactTemplateRecordPayload[]>(
    [],
  );
  const [previews, setPreviews] = useState<
    Record<string, ArtifactTemplatePreviewPayload>
  >({});
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [namingTemplate, setNamingTemplate] =
    useState<ArtifactTemplateRecordPayload | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<ArtifactTemplateRecordPayload | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const referenceFileInChat = useReferenceFileInChat();
  const setComposerPrefill = useSetAtom(chatComposerPrefillAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const { selectedWorkspace } = useWorkspaceDesktop();
  const busy = creatingId !== null || draftingId !== null;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response =
        await window.electronAPI.workspace.listArtifactTemplates();
      const list = response.templates ?? [];
      setTemplates(list);
      void Promise.all(
        list.map(async (template) => {
          try {
            const preview =
              await window.electronAPI.workspace.readArtifactTemplatePreview({
                templateId: template.id,
              });
            return [template.id, preview] as const;
          } catch {
            return [
              template.id,
              { kind: "none" } as ArtifactTemplatePreviewPayload,
            ] as const;
          }
        }),
      ).then((entries) => setPreviews(Object.fromEntries(entries)));
    } catch {
      setTemplates([]);
      setPreviews({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setNamingTemplate(null);
    void reload();
  }, [open, reload]);

  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const filtered = normalizedQuery
      ? templates.filter(
          (template) =>
            template.name.toLowerCase().includes(normalizedQuery) ||
            (template.description ?? "")
              .toLowerCase()
              .includes(normalizedQuery),
        )
      : templates;
    const byCategory = new Map<string, ArtifactTemplateRecordPayload[]>();
    for (const template of filtered) {
      const key = template.category?.trim() || UNCATEGORIZED;
      const bucket = byCategory.get(key);
      if (bucket) bucket.push(template);
      else byCategory.set(key, [template]);
    }
    return [...byCategory.entries()].sort(([a], [b]) => {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return a.localeCompare(b);
    });
  }, [templates, normalizedQuery]);

  // Clicking a template doesn't create immediately — it opens a name step so
  // the user can name the file (the template's extension is appended for them).
  const handleSelect = (template: ArtifactTemplateRecordPayload) => {
    if (busy) return;
    setNamingTemplate(template);
    setNameDraft(template.name);
  };

  const confirmCreate = async () => {
    const template = namingTemplate;
    const name = nameDraft.trim();
    if (!template || !name || busy) return;
    setCreatingId(template.id);
    try {
      const response =
        await window.electronAPI.workspace.createOutputFromTemplate({
          workspaceId,
          templateId: template.id,
          name,
        });
      onOpenChange(false);
      onCreated(response.output);
    } catch (error) {
      toast.error("Couldn't create from template", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setCreatingId(null);
    }
  };

  // Hand the template to the AI team: copy it into the workspace, attach that
  // file to the composer, and prefill a drafting intent. The agent reads the
  // template and produces a new artifact — closing the template→agent loop the
  // plain "New from template" copy can't.
  const handleDraft = async (
    event: React.MouseEvent,
    template: ArtifactTemplateRecordPayload,
  ) => {
    event.stopPropagation();
    if (busy || !workspaceId.trim()) return;
    setDraftingId(template.id);
    try {
      const response =
        await window.electronAPI.workspace.createOutputFromTemplate({
          workspaceId,
          templateId: template.id,
        });
      const filePath = (response.output?.file_path ?? "").trim();
      const root = (selectedWorkspace?.workspace_path ?? "")
        .trim()
        .replace(/[\\/]+$/, "");
      const isAbsolute =
        filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
      const absolutePath = !filePath
        ? ""
        : isAbsolute
          ? filePath
          : root
            ? `${root}/${filePath}`
            : "";
      if (absolutePath) referenceFileInChat(absolutePath);
      setComposerPrefill({
        text: `Use the attached “${template.name}” as a template — match its structure and style, and draft a new version for me: `,
        requestKey: Date.now(),
        mode: "replace",
        sessionMode: "draft",
      });
      setFocusMode(false);
      onOpenChange(false);
    } catch (error) {
      toast.error("Couldn't start a draft", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setDraftingId(null);
    }
  };

  const handleDelete = async (template: ArtifactTemplateRecordPayload) => {
    setTemplates((prev) => prev.filter((t) => t.id !== template.id));
    try {
      await window.electronAPI.workspace.deleteArtifactTemplate({
        templateId: template.id,
      });
    } catch {
      void reload();
    }
  };

  const isEmpty = !loading && templates.length === 0;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[14%] left-1/2 z-[100] flex max-h-[72vh] w-[580px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
            <DialogPrimitive.Title className="text-sm font-medium text-foreground">
              New from template
            </DialogPrimitive.Title>
            <span className="flex-1" />
            <DialogPrimitive.Close className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground">
              <X className="size-3.5" />
            </DialogPrimitive.Close>
          </div>

          {namingTemplate ? (
            <div className="flex flex-col gap-4 p-4">
              <button
                type="button"
                onClick={() => setNamingTemplate(null)}
                className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                Back to templates
              </button>
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-foreground/80">
                  File name
                </span>
                <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-transparent transition-colors focus-within:border-ring">
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void confirmCreate();
                      }
                    }}
                    placeholder="Untitled"
                    aria-label="File name"
                    className="min-w-0 flex-1 bg-transparent px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  {namingTemplate.ext ? (
                    <span className="grid shrink-0 place-items-center border-l border-border bg-fg-4 px-2.5 text-xs text-muted-foreground">
                      {namingTemplate.ext}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setNamingTemplate(null)}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void confirmCreate()}
                  disabled={!nameDraft.trim() || busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
                >
                  {creatingId === namingTemplate.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Create
                </button>
              </div>
            </div>
          ) : (
            <>
          {!isEmpty ? (
            <div className="relative shrink-0 border-b border-border px-3 py-2">
              <Search className="pointer-events-none absolute left-5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search templates"
                aria-label="Search templates"
                className="embedded-input h-8 rounded-md pl-8 text-xs focus-visible:ring-0"
              />
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading templates…
              </div>
            ) : isEmpty ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <FileText className="size-6 text-muted-foreground/50" />
                <div className="text-sm text-foreground/80">No templates yet</div>
              </div>
            ) : groups.length === 0 ? (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                No templates match “{query}”.
              </div>
            ) : (
              groups.map(([categoryLabel, items]) => (
                <div key={categoryLabel} className="mb-3 last:mb-0">
                  {categoryLabel === UNCATEGORIZED ? null : (
                    <div className="px-0.5 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                      {categoryLabel}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2.5">
                    {items.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => handleSelect(template)}
                        disabled={busy}
                        className="group/template relative flex flex-col overflow-hidden rounded-lg border border-border bg-background text-left transition-colors hover:border-foreground/25 disabled:cursor-default"
                      >
                        <div className="relative h-[96px] w-full overflow-hidden border-b border-border bg-fg-4">
                          <TemplateThumbnail
                            preview={previews[template.id]}
                            ext={template.ext}
                          />
                          {creatingId === template.id ||
                          draftingId === template.id ? (
                            <div className="absolute inset-0 grid place-items-center bg-background/60">
                              <Loader2 className="size-5 animate-spin text-foreground/70" />
                            </div>
                          ) : null}
                          <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-snappy ease-out group-hover/template:opacity-100">
                            <span
                              role="button"
                              tabIndex={-1}
                              aria-label="Draft with agent"
                              title="Draft with agent"
                              onClick={(event) =>
                                void handleDraft(event, template)
                              }
                              className="grid size-6 place-items-center rounded-md bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border transition-colors hover:text-foreground"
                            >
                              <Sparkles className="size-3.5" strokeWidth={1.75} />
                            </span>
                            <span
                              role="button"
                              tabIndex={-1}
                              aria-label="Delete template"
                              title="Delete template"
                              onClick={(event) => {
                                event.stopPropagation();
                                setPendingDelete(template);
                              }}
                              className="grid size-6 place-items-center rounded-md bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border transition-colors hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" strokeWidth={1.75} />
                            </span>
                          </div>
                        </div>
                        <div className="min-w-0 px-2.5 py-2">
                          <div className="truncate text-sm text-foreground">
                            {template.name}
                          </div>
                          {template.description ? (
                            <div className="truncate text-xs text-muted-foreground/80">
                              {template.description}
                            </div>
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
            </>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
      <ConfirmDialog
        confirmLabel="Delete"
        description={
          pendingDelete
            ? `"${pendingDelete.name}" will be permanently removed.`
            : undefined
        }
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            void handleDelete(pendingDelete);
          }
          setPendingDelete(null);
        }}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        open={pendingDelete !== null}
        title="Delete this template?"
      />
    </DialogPrimitive.Root>
  );
}
