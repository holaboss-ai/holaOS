import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom } from "jotai";
import { Loader2, Paperclip, Plus, Trash2, X } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { newIssueOpenAtom } from "./state/ui";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";

const ISSUE_STATUS_OPTIONS: ReadonlyArray<{
  value: IssueStatusPayload;
  label: string;
}> = [
  { value: "todo", label: "Todo" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
  { value: "blocked", label: "Blocked" },
];

const ISSUE_PRIORITY_OPTIONS: ReadonlyArray<{
  value: IssuePriorityPayload;
  label: string;
}> = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function attachmentUploadPayload(
  file: File,
): Promise<StageSessionAttachmentFilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      resolve({
        name: file.name,
        mime_type: file.type || null,
        content_base64: separator >= 0 ? result.slice(separator + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

function dedupeFiles(current: File[], incoming: File[]): File[] {
  const seen = new Set(
    current.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
  );
  const next = [...current];
  for (const file of incoming) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  return next;
}

export function NewIssueDialog() {
  const [open, setOpen] = useAtom(newIssueOpenAtom);
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const openIssueDetailTab = useOpenIssueDetailTab();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [teammates, setTeammates] = useState<TeammateRecordPayload[]>([]);
  const [isLoadingTeammates, setIsLoadingTeammates] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<IssueStatusPayload | "">("");
  const [assigneeTeammateId, setAssigneeTeammateId] = useState("");
  const [priority, setPriority] = useState<IssuePriorityPayload | "">("");
  const [blockerReason, setBlockerReason] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);

  const reset = useCallback(() => {
    setTitle("");
    setDescription("");
    setStatus("");
    setAssigneeTeammateId("");
    setPriority("");
    setBlockerReason("");
    setAttachments([]);
    setErrorMessage("");
    setIsSubmitting(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        reset();
      }
    },
    [reset, setOpen],
  );

  useEffect(() => {
    if (!open || !selectedWorkspaceId) {
      setTeammates([]);
      setIsLoadingTeammates(false);
      return;
    }
    let cancelled = false;
    setIsLoadingTeammates(true);
    setErrorMessage("");
    void window.electronAPI.workspace
      .listTeammates(selectedWorkspaceId)
      .then((response) => {
        if (cancelled) return;
        setTeammates(response.teammates.filter((item) => item.status === "active"));
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to load teammates",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingTeammates(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedWorkspaceId]);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextFiles = Array.from(event.target.files ?? []);
      if (nextFiles.length === 0) return;
      setAttachments((current) => dedupeFiles(current, nextFiles));
      event.target.value = "";
    },
    [],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedWorkspaceId) {
        setErrorMessage("Select a workspace before creating an issue.");
        return;
      }
      if (!title.trim()) {
        setErrorMessage("Issue title is required.");
        return;
      }
      if (!status) {
        setErrorMessage("Issue status is required.");
        return;
      }
      if (status === "blocked" && !blockerReason.trim()) {
        setErrorMessage("Blocked issues need a blocker reason.");
        return;
      }

      setIsSubmitting(true);
      setErrorMessage("");
      try {
        const stagedAttachments =
          attachments.length > 0
            ? await window.electronAPI.workspace.stageSessionAttachments({
                workspace_id: selectedWorkspaceId,
                files: await Promise.all(
                  attachments.map((file) => attachmentUploadPayload(file)),
                ),
              })
            : { attachments: [] };
        const created = await window.electronAPI.workspace.createIssue({
          workspace_id: selectedWorkspaceId,
          title: title.trim(),
          description: description.trim() || null,
          status,
          priority: priority || null,
          assignee_teammate_id: assigneeTeammateId || null,
          blocker_reason:
            status === "blocked" ? blockerReason.trim() || null : null,
          attachments: stagedAttachments.attachments,
        });
        void openIssueDetailTab({
          workspaceId: selectedWorkspaceId,
          issueId: created.issue.issue_id,
          title: created.issue.title,
        });
        handleOpenChange(false);
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to create issue",
        );
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      assigneeTeammateId,
      attachments,
      blockerReason,
      description,
      handleOpenChange,
      priority,
      selectedWorkspaceId,
      status,
      title,
      openIssueDetailTab,
    ],
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          style={{
            animationDuration: "var(--duration-snappy)",
            animationTimingFunction: "var(--ease-out-expo)",
          }}
        />
        <DialogPrimitive.Popup
          className="fixed top-[12%] left-1/2 z-[100] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl outline-none backdrop-blur-2xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          style={{
            animationDuration: "var(--duration-base)",
            animationTimingFunction: "var(--ease-out-expo)",
          }}
        >
          <form onSubmit={handleSubmit} className="flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="text-sm font-medium text-foreground">
                New issue
              </div>
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="grid size-7 place-items-center rounded-md text-foreground/45 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                aria-label="Close new issue dialog"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 px-4 py-4">
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Issue title"
                autoFocus
                className="h-11 text-base"
              />

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                    Assignee
                  </div>
                  <Select
                    value={assigneeTeammateId || "__unassigned__"}
                    onValueChange={(value) =>
                      setAssigneeTeammateId(
                        value === "__unassigned__" || value == null ? "" : value,
                      )
                    }
                  >
                    <SelectTrigger className="w-full bg-background">
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                    <SelectContent align="start" className="min-w-[220px]">
                      <SelectItem value="__unassigned__">
                        Unassigned
                      </SelectItem>
                      {teammates.map((teammate) => (
                        <SelectItem
                          key={teammate.teammate_id}
                          value={teammate.teammate_id}
                        >
                          {teammate.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                    Status
                  </div>
                  <Select
                    value={status || undefined}
                    onValueChange={(value) =>
                      setStatus(value as IssueStatusPayload)
                    }
                  >
                    <SelectTrigger className="w-full bg-background">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent align="start" className="min-w-[220px]">
                      {ISSUE_STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                    Priority
                  </div>
                  <Select
                    value={priority || "__none__"}
                    onValueChange={(value) =>
                      setPriority(
                        value === "__none__" || value == null
                          ? ""
                          : (value as IssuePriorityPayload),
                      )
                    }
                  >
                    <SelectTrigger className="w-full bg-background">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent align="start" className="min-w-[220px]">
                      <SelectItem value="__none__">None</SelectItem>
                      {ISSUE_PRIORITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                    Attachments
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={handleFileInputChange}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      className="h-8"
                    >
                      <Paperclip className="size-3.5" />
                      Upload
                    </Button>
                    <span className="text-xs text-foreground/45">
                      {attachments.length === 0
                        ? "No files"
                        : `${attachments.length} file${attachments.length === 1 ? "" : "s"}`}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                  Description
                </div>
                <Textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Add description..."
                  className="min-h-40 resize-none bg-background"
                />
              </div>

              {status === "blocked" ? (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                    Blocker reason
                  </div>
                  <Textarea
                    value={blockerReason}
                    onChange={(event) => setBlockerReason(event.target.value)}
                    placeholder="What is blocking this issue?"
                    className="min-h-20 resize-none bg-background"
                  />
                </div>
              ) : null}

              {attachments.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {attachments.map((file) => (
                    <span
                      key={`${file.name}:${file.size}:${file.lastModified}`}
                      className="inline-flex items-center gap-2 rounded-full bg-foreground/[0.06] px-2 py-1 text-xs text-foreground/70"
                    >
                      {file.name}
                      <button
                        type="button"
                        onClick={() =>
                          setAttachments((current) =>
                            current.filter(
                              (entry) =>
                                !(
                                  entry.name === file.name &&
                                  entry.size === file.size &&
                                  entry.lastModified === file.lastModified
                                ),
                            ),
                          )
                        }
                        className="grid size-4 place-items-center rounded-full text-foreground/45 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                        aria-label={`Remove ${file.name}`}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              {errorMessage ? (
                <div className="rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive">
                  {errorMessage}
                </div>
              ) : null}
              {isLoadingTeammates ? (
                <div className="text-xs text-foreground/45">
                  Loading teammates…
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="text-sm text-foreground/45 transition-colors hover:text-foreground"
              >
                Discard draft
              </button>
              <Button
                type="submit"
                disabled={isSubmitting || !selectedWorkspaceId}
                className="h-10 min-w-32"
              >
                {isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                Create issue
              </Button>
            </div>
          </form>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
