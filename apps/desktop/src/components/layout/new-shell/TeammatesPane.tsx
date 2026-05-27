import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  FileCode2,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CardAction,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

const NEW_TEAMMATE_ID = "__new_teammate__";

type SkillDraft = {
  localId: string;
  skillId: string | null;
  name: string;
  content: string;
};

type DraftState = {
  teammateId: string | null;
  name: string;
  instructions: string;
  skills: SkillDraft[];
  status: TeammateStatusPayload;
  kind: TeammateKindPayload;
};

function makeDraftSkillId(): string {
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyDraft(): DraftState {
  return {
    teammateId: null,
    name: "",
    instructions: "",
    skills: [],
    status: "active",
    kind: "custom",
  };
}

function draftFromTeammate(teammate: TeammateRecordPayload): DraftState {
  return {
    teammateId: teammate.teammate_id,
    name: teammate.name,
    instructions: teammate.instructions ?? "",
    skills: teammate.skills.map((skill) => ({
      localId: skill.skill_id || makeDraftSkillId(),
      skillId: skill.skill_id,
      name: skill.name,
      content: skill.content,
    })),
    status: teammate.status,
    kind: teammate.kind,
  };
}

function normalizedSkillInputs(
  skills: SkillDraft[],
): TeammateSkillInputPayload[] | null {
  const normalized: TeammateSkillInputPayload[] = [];
  for (const skill of skills) {
    const name = skill.name.trim();
    const content = skill.content.trim();
    if (!name && !content) {
      continue;
    }
    if (!name || !content) {
      throw new Error("Every skill needs both a name and SKILL.md content.");
    }
    normalized.push({
      skill_id: skill.skillId,
      name,
      content,
    });
  }
  return normalized;
}

function sortTeammates(teammates: TeammateRecordPayload[]): TeammateRecordPayload[] {
  return [...teammates].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "system" ? -1 : 1;
    }
    if (left.status !== right.status) {
      return left.status === "active" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function relativeTimeLabel(value: string | null): string {
  if (!value) return "—";
  const delta = Date.now() - Date.parse(value);
  if (Number.isNaN(delta)) return value;
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TeammatesPane({ workspaceId }: { workspaceId: string }) {
  const { selectedWorkspace } = useWorkspaceDesktop();
  const [teammates, setTeammates] = useState<TeammateRecordPayload[]>([]);
  const [issues, setIssues] = useState<IssueRecordPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedTeammateId, setSelectedTeammateId] = useState<string | null>(
    null,
  );
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId.trim()) {
      setTeammates([]);
      setIssues([]);
      return;
    }
    setIsLoading(true);
    try {
      const [teammateResponse, issueResponse] = await Promise.all([
        window.electronAPI.workspace.listTeammates(workspaceId, showArchived),
        window.electronAPI.workspace.listIssues(workspaceId),
      ]);
      setTeammates(sortTeammates(teammateResponse.teammates));
      setIssues(issueResponse.issues);
      setStatusMessage("");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to load teammates",
      );
    } finally {
      setIsLoading(false);
    }
  }, [showArchived, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const teammatesById = useMemo(
    () =>
      Object.fromEntries(teammates.map((teammate) => [teammate.teammate_id, teammate])),
    [teammates],
  );

  const selectedTeammate =
    selectedTeammateId && selectedTeammateId !== NEW_TEAMMATE_ID
      ? teammatesById[selectedTeammateId] ?? null
      : null;
  const isCreating = selectedTeammateId === NEW_TEAMMATE_ID;

  useEffect(() => {
    if (selectedTeammateId === NEW_TEAMMATE_ID) {
      return;
    }
    if (selectedTeammate) {
      setDraft(draftFromTeammate(selectedTeammate));
      return;
    }
    const fallback = teammates.find((entry) => entry.status === "active") ?? null;
    if (fallback) {
      setSelectedTeammateId(fallback.teammate_id);
      setDraft(draftFromTeammate(fallback));
      return;
    }
    setSelectedTeammateId(NEW_TEAMMATE_ID);
    setDraft(emptyDraft());
  }, [selectedTeammate, selectedTeammateId, teammates]);

  const selectedIssueCount = useMemo(() => {
    const teammateId = selectedTeammate?.teammate_id ?? null;
    if (!teammateId) return 0;
    return issues.filter((issue) => issue.assignee_teammate_id === teammateId).length;
  }, [issues, selectedTeammate]);

  const selectedRunningCount = useMemo(() => {
    const teammateId = selectedTeammate?.teammate_id ?? null;
    if (!teammateId) return 0;
    return issues.filter(
      (issue) =>
        issue.assignee_teammate_id === teammateId &&
        (issue.status === "in_progress" || Boolean(issue.active_subagent_id)),
    ).length;
  }, [issues, selectedTeammate]);

  const customActiveCount = useMemo(
    () =>
      teammates.filter(
        (teammate) => teammate.kind === "custom" && teammate.status === "active",
      ).length,
    [teammates],
  );

  const archivedCount = useMemo(
    () => teammates.filter((teammate) => teammate.status === "archived").length,
    [teammates],
  );

  const draftLocked =
    isSaving ||
    (!!selectedTeammate && selectedTeammate.kind === "system") ||
    (!!selectedTeammate && selectedTeammate.status === "archived");

  const handleStartCreate = useCallback(() => {
    setSelectedTeammateId(NEW_TEAMMATE_ID);
    setDraft(emptyDraft());
    setStatusMessage("");
  }, []);

  const handleAddSkill = useCallback(() => {
    setDraft((current) => ({
      ...current,
      skills: [
        ...current.skills,
        {
          localId: makeDraftSkillId(),
          skillId: null,
          name: "",
          content: "",
        },
      ],
    }));
  }, []);

  const handleSkillChange = useCallback(
    (localId: string, field: "name" | "content", value: string) => {
      setDraft((current) => ({
        ...current,
        skills: current.skills.map((skill) =>
          skill.localId === localId ? { ...skill, [field]: value } : skill,
        ),
      }));
    },
    [],
  );

  const handleRemoveSkill = useCallback((localId: string) => {
    setDraft((current) => ({
      ...current,
      skills: current.skills.filter((skill) => skill.localId !== localId),
    }));
  }, []);

  const handleSave = useCallback(async () => {
    const name = draft.name.trim();
    if (!name) {
      setStatusMessage("Teammate name is required.");
      return;
    }
    let skills: TeammateSkillInputPayload[] | null;
    try {
      skills = normalizedSkillInputs(draft.skills);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Invalid teammate skills",
      );
      return;
    }
    setIsSaving(true);
    setStatusMessage("");
    try {
      if (isCreating) {
        const created = await window.electronAPI.workspace.createTeammate({
          workspace_id: workspaceId,
          name,
          instructions: draft.instructions.trim() || null,
          skills,
        });
        await refresh();
        setSelectedTeammateId(created.teammate.teammate_id);
        setDraft(draftFromTeammate(created.teammate));
        setStatusMessage("Teammate created.");
      } else if (selectedTeammate) {
        const updated = await window.electronAPI.workspace.updateTeammate(
          workspaceId,
          selectedTeammate.teammate_id,
          {
            workspace_id: workspaceId,
            name,
            instructions: draft.instructions.trim() || null,
            skills,
          },
        );
        await refresh();
        setSelectedTeammateId(updated.teammate.teammate_id);
        setDraft(draftFromTeammate(updated.teammate));
        setStatusMessage("Teammate updated.");
      }
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to save teammate",
      );
    } finally {
      setIsSaving(false);
    }
  }, [draft, isCreating, refresh, selectedTeammate, workspaceId]);

  const handleArchive = useCallback(async () => {
    if (!selectedTeammate || selectedTeammate.kind === "system") {
      return;
    }
    setIsSaving(true);
    setStatusMessage("");
    try {
      await window.electronAPI.workspace.updateTeammate(
        workspaceId,
        selectedTeammate.teammate_id,
        {
          workspace_id: workspaceId,
          status: "archived",
        },
      );
      await refresh();
      setSelectedTeammateId(null);
      setStatusMessage("Teammate archived.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to archive teammate",
      );
    } finally {
      setIsSaving(false);
    }
  }, [refresh, selectedTeammate, workspaceId]);

  const handleRestore = useCallback(async () => {
    if (!selectedTeammate || selectedTeammate.kind === "system") {
      return;
    }
    setIsSaving(true);
    setStatusMessage("");
    try {
      const restored = await window.electronAPI.workspace.updateTeammate(
        workspaceId,
        selectedTeammate.teammate_id,
        {
          workspace_id: workspaceId,
          status: "active",
        },
      );
      await refresh();
      setSelectedTeammateId(restored.teammate.teammate_id);
      setDraft(draftFromTeammate(restored.teammate));
      setStatusMessage("Teammate restored.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to restore teammate",
      );
    } finally {
      setIsSaving(false);
    }
  }, [refresh, selectedTeammate, workspaceId]);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top_left,rgba(245,118,66,0.06),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_32%)]">
        <div className="border-b border-border px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-foreground/35">
                <span>Agent Team</span>
                <span className="text-foreground/20">/</span>
                <span>Teammates</span>
              </div>
              <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-foreground">
                Teammates
              </h1>
              <p className="mt-1 max-w-3xl text-sm text-foreground/55">
                Manage the fixed General teammate plus custom teammates with
                editable instructions and freeform SKILL.md entries.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Badge variant="outline" className="h-9 rounded-full bg-card/80 px-3 text-foreground/65">
                {customActiveCount} custom active
              </Badge>
              {showArchived ? (
                <Badge
                  variant="outline"
                  className="h-9 rounded-full bg-card/80 px-3 text-foreground/65"
                >
                  {archivedCount} archived
                </Badge>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="h-9 rounded-full border-border bg-card/80 px-3 text-foreground/80 hover:bg-card"
                onClick={() => void refresh()}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Refresh
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "h-9 rounded-full border-border px-3",
                  showArchived ? "bg-foreground/[0.08]" : "bg-card/80",
                )}
                onClick={() => setShowArchived((current) => !current)}
              >
                {showArchived ? "Hide archived" : "Show archived"}
              </Button>
              <Button
                type="button"
                className="h-9 rounded-full px-4"
                onClick={handleStartCreate}
              >
                <Plus className="size-4" />
                New teammate
              </Button>
            </div>
          </div>
          {statusMessage ? (
            <div className="mt-3 rounded-2xl border border-border bg-card/80 px-3 py-2 text-xs text-foreground/65">
              {statusMessage}
            </div>
          ) : null}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-r border-border bg-card/25 px-4 py-5">
            <div className="space-y-2">
              {teammates.map((teammate) => {
                const assignedCount = issues.filter(
                  (issue) => issue.assignee_teammate_id === teammate.teammate_id,
                ).length;
                const isSelected =
                  !isCreating && selectedTeammateId === teammate.teammate_id;
                return (
                  <button
                    key={teammate.teammate_id}
                    type="button"
                    onClick={() => setSelectedTeammateId(teammate.teammate_id)}
                    className={cn(
                      "w-full rounded-2xl border px-4 py-3 text-left transition-colors",
                      isSelected
                        ? "border-foreground/15 bg-card shadow-sm"
                        : "border-border bg-background/55 hover:bg-background/80",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {teammate.kind === "system" ? (
                            <ShieldCheck className="size-4 text-foreground/45" />
                          ) : (
                            <UserRound className="size-4 text-foreground/45" />
                          )}
                          <div className="truncate text-sm font-medium text-foreground">
                            {teammate.name}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-foreground/52">
                          <Badge variant="outline" className="bg-card/70">
                            {teammate.kind === "system" ? "System" : "Custom"}
                          </Badge>
                          <Badge variant="outline" className="bg-card/70">
                            {teammate.skills.length} skills
                          </Badge>
                          <Badge variant="outline" className="bg-card/70">
                            {assignedCount} issues
                          </Badge>
                          {teammate.status === "archived" ? (
                            <Badge
                              variant="outline"
                              className="border-orange-500/18 bg-orange-500/[0.1] text-orange-800 dark:text-orange-100/85"
                            >
                              Archived
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-foreground/42">
                      Updated {relativeTimeLabel(teammate.updated_at)}
                    </div>
                  </button>
                );
              })}

              {isCreating ? (
                <div className="rounded-2xl border border-dashed border-primary/30 bg-primary/[0.06] px-4 py-3 text-sm text-primary">
                  Creating a new teammate
                </div>
              ) : null}
            </div>
          </aside>

          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-4xl">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-foreground/35">
                    <span>{selectedWorkspace?.name || "Workspace"}</span>
                    <span className="text-foreground/20">/</span>
                    <span>{isCreating ? "New teammate" : selectedTeammate?.name || "Teammate"}</span>
                  </div>
                  <h2 className="mt-2 text-[30px] font-semibold tracking-tight text-foreground">
                    {isCreating
                      ? "New teammate"
                      : selectedTeammate?.name || "Select a teammate"}
                  </h2>
                  <p className="mt-1 text-sm text-foreground/55">
                    {selectedTeammate?.kind === "system"
                      ? "The built-in General teammate is fixed in v1 and can be viewed but not edited."
                      : "Adjust routing instructions and freeform SKILL.md entries used by the Workspace Manager."}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {selectedTeammate?.status === "archived" ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleRestore()}
                      disabled={isSaving || selectedTeammate.kind === "system"}
                    >
                      <RotateCcw className="size-4" />
                      Restore
                    </Button>
                  ) : null}
                  {!isCreating && selectedTeammate?.kind === "custom" ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setArchiveConfirmOpen(true)}
                      disabled={isSaving}
                    >
                      <Trash2 className="size-4" />
                      Archive
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={draftLocked || isSaving}
                  >
                    {isSaving ? <Loader2 className="size-4 animate-spin" /> : null}
                    {isCreating ? "Create teammate" : "Save changes"}
                  </Button>
                </div>
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
                <div className="space-y-6">
                  <Card className="bg-card/85">
                    <CardHeader>
                      <CardTitle>Identity</CardTitle>
                      <CardDescription>
                        Name the teammate and describe the routing behavior the
                        Workspace Manager should recognize.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4">
                      <div>
                        <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
                          Name
                        </div>
                        <Input
                          value={draft.name}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              name: event.target.value,
                            }))
                          }
                          placeholder="Coder"
                          disabled={draftLocked}
                          className="h-11 bg-background/75"
                        />
                      </div>
                      <div>
                        <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
                          Instructions
                        </div>
                        <Textarea
                          value={draft.instructions}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              instructions: event.target.value,
                            }))
                          }
                          placeholder="Describe what this teammate is good at, how it should work, and any routing cues."
                          disabled={draftLocked}
                          className="min-h-[160px] resize-y bg-background/75"
                        />
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="bg-card/85">
                    <CardHeader>
                      <div>
                        <CardTitle>Skills</CardTitle>
                        <CardDescription>
                          Add multiple freeform SKILL.md entries for this teammate.
                        </CardDescription>
                      </div>
                      <CardAction>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleAddSkill}
                          disabled={draftLocked}
                        >
                          <Plus className="size-4" />
                          Add skill
                        </Button>
                      </CardAction>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      {draft.skills.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-border bg-background/45 px-4 py-8 text-center text-sm text-foreground/48">
                          No skills yet
                        </div>
                      ) : (
                        draft.skills.map((skill, index) => (
                          <div
                            key={skill.localId}
                            className="rounded-2xl border border-border bg-background/55 p-4"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                                <FileCode2 className="size-4 text-foreground/45" />
                                Skill {index + 1}
                              </div>
                              {!draftLocked ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label="Remove skill"
                                  onClick={() => handleRemoveSkill(skill.localId)}
                                >
                                  <X className="size-4" />
                                </Button>
                              ) : null}
                            </div>
                            <div className="mt-4 grid gap-4">
                              <div>
                                <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
                                  Skill name
                                </div>
                                <Input
                                  value={skill.name}
                                  onChange={(event) =>
                                    handleSkillChange(
                                      skill.localId,
                                      "name",
                                      event.target.value,
                                    )
                                  }
                                  placeholder="frontend"
                                  disabled={draftLocked}
                                  className="h-10 bg-card/80"
                                />
                              </div>
                              <div>
                                <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
                                  SKILL.md content
                                </div>
                                <Textarea
                                  value={skill.content}
                                  onChange={(event) =>
                                    handleSkillChange(
                                      skill.localId,
                                      "content",
                                      event.target.value,
                                    )
                                  }
                                  placeholder="# Skill&#10;Explain how this teammate should approach the work."
                                  disabled={draftLocked}
                                  className="min-h-[180px] resize-y bg-card/80 font-mono text-[13px]"
                                />
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>
                </div>

                <aside className="space-y-4">
                  <Card className="bg-card/85">
                    <CardHeader>
                      <CardTitle>Summary</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm text-foreground/68">
                      <SummaryRow label="Kind" value={draft.kind === "system" ? "System" : "Custom"} />
                      <SummaryRow label="Status" value={draft.status === "archived" ? "Archived" : "Active"} />
                      <SummaryRow label="Skills" value={`${draft.skills.filter((skill) => skill.name.trim() || skill.content.trim()).length}`} />
                      <SummaryRow label="Assigned issues" value={`${selectedIssueCount}`} />
                      <SummaryRow label="Working now" value={`${selectedRunningCount}`} />
                    </CardContent>
                  </Card>

                  {selectedTeammate ? (
                    <Card className="bg-card/85">
                      <CardHeader>
                        <CardTitle>Lifecycle</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 text-sm text-foreground/68">
                        <SummaryRow
                          label="Created"
                          value={relativeTimeLabel(selectedTeammate.created_at)}
                        />
                        <SummaryRow
                          label="Updated"
                          value={relativeTimeLabel(selectedTeammate.updated_at)}
                        />
                        <SummaryRow
                          label="Archived"
                          value={relativeTimeLabel(selectedTeammate.archived_at)}
                        />
                      </CardContent>
                    </Card>
                  ) : null}

                  <Card className="bg-card/85">
                    <CardHeader>
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <Bot className="size-4 text-foreground/45" />
                        Routing note
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm leading-6 text-foreground/58">
                        The Workspace Manager chooses teammates from their
                        instructions and SKILL.md entries. Archived teammates drop
                        out of routing and disappear from normal navigation.
                      </p>
                    </CardContent>
                  </Card>
                </aside>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={archiveConfirmOpen}
        onOpenChange={setArchiveConfirmOpen}
        title={`Archive ${selectedTeammate?.name || "teammate"}?`}
        description="Archiving cancels any active work owned by this teammate and moves its assigned issues back to unassigned Todo."
        confirmLabel="Archive teammate"
        destructive
        onConfirm={() => {
          void handleArchive();
        }}
      />
    </>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground/45">{label}</span>
      <span className="text-right text-foreground/82">{value || "—"}</span>
    </div>
  );
}
