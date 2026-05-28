import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Bot,
  FileCode2,
  FolderOpen,
  ListTodo,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
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
import { StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";

const NEW_TEAMMATE_ID = "__new_teammate__";

type DetailTab = "activity" | "issues" | "instructions" | "skills";

type SkillDraft = {
  localId: string;
  skillId: string | null;
  name: string;
  content: string;
  storageOrigin?: "filesystem";
  sourceDir?: string | null;
  filePath?: string | null;
  hasSidecarAssets?: boolean;
};

type DraftState = {
  teammateId: string | null;
  name: string;
  instructions: string;
  capabilitySummary: string;
  capabilityTags: string;
  preferredTools: string;
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
    capabilitySummary: "",
    capabilityTags: "",
    preferredTools: "",
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
    capabilitySummary: teammate.capability_profile.summary ?? "",
    capabilityTags: teammate.capability_profile.capabilities.join(", "),
    preferredTools: teammate.capability_profile.preferred_tools.join(", "),
    skills: teammate.skills.map((skill) => ({
      localId: skill.skill_id || makeDraftSkillId(),
      skillId: skill.skill_id,
      name: skill.name,
      content: skill.content,
      storageOrigin: skill.storage_origin,
      sourceDir: skill.source_dir ?? null,
      filePath: skill.file_path ?? null,
      hasSidecarAssets: skill.has_sidecar_assets ?? false,
    })),
    status: teammate.status,
    kind: teammate.kind,
  };
}

function normalizedSkillInputs(
  skills: SkillDraft[],
): TeammateSkillInputPayload[] | null {
  const normalized: TeammateSkillInputPayload[] = [];
  const seenSkillIds = new Set<string>();
  for (const skill of skills) {
    const name = skill.name.trim();
    const content = skill.content.trim();
    if (!name && !content) {
      continue;
    }
    if (!name || !content) {
      throw new Error("Every skill needs both a name and SKILL.md content.");
    }
    const canonicalSkillId =
      skill.skillId?.trim().toLowerCase() ||
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[-_]+|[-_]+$/g, "");
    if (!canonicalSkillId) {
      throw new Error("Every skill needs a name that can be turned into a skill id.");
    }
    if (seenSkillIds.has(canonicalSkillId)) {
      throw new Error(`Duplicate skill id: ${canonicalSkillId}`);
    }
    seenSkillIds.add(canonicalSkillId);
    normalized.push({
      skill_id: skill.skillId?.trim() || null,
      name,
      content,
    });
  }
  return normalized;
}

function teammateSkillRelativePath(
  teammateId: string | null,
  skillId: string | null,
): string | null {
  const trimmedTeammateId = teammateId?.trim() ?? "";
  const trimmedSkillId = skillId?.trim() ?? "";
  if (!trimmedTeammateId || !trimmedSkillId) {
    return null;
  }
  return `teammates/${trimmedTeammateId}/skills/${trimmedSkillId}/SKILL.md`;
}

function normalizedCommaSeparatedValues(value: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizedCapabilityProfileInput(
  draft: DraftState,
): Partial<TeammateCapabilityProfilePayload> | null {
  const summary = draft.capabilitySummary.trim();
  const capabilities = normalizedCommaSeparatedValues(draft.capabilityTags);
  const preferredTools = normalizedCommaSeparatedValues(draft.preferredTools);
  if (!summary && capabilities.length === 0 && preferredTools.length === 0) {
    return null;
  }
  return {
    summary: summary || null,
    capabilities,
    preferred_tools: preferredTools,
  };
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

function teammateStatusLabel(status: TeammateStatusPayload): string {
  return status === "archived" ? "Archived" : "Active";
}

function teammateStatusVariant(
  status: TeammateStatusPayload,
): "success" | "warning" {
  return status === "archived" ? "warning" : "success";
}

function issueStatusLabel(status: IssueStatusPayload): string {
  switch (status) {
    case "in_progress":
      return "In Progress";
    case "in_review":
      return "In Review";
    default:
      return status
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function issuePriorityLabel(priority: IssuePriorityPayload | null): string {
  if (!priority) return "No priority";
  return priority.slice(0, 1).toUpperCase() + priority.slice(1);
}

function issuePriorityBadgeClass(priority: IssuePriorityPayload | null): string {
  switch (priority) {
    case "critical":
      return "border-red-500/18 bg-red-500/10 text-red-700 dark:text-red-200";
    case "high":
      return "border-orange-500/18 bg-orange-500/10 text-orange-700 dark:text-orange-200";
    case "medium":
      return "border-amber-500/18 bg-amber-500/10 text-amber-800 dark:text-amber-200";
    case "low":
      return "border-slate-500/18 bg-slate-500/10 text-slate-700 dark:text-slate-300";
    default:
      return "border-border bg-background/70 text-foreground/55";
  }
}

function teammateWorkloadLabel(runningCount: number, assignedCount: number): string {
  if (runningCount > 0) {
    return `${runningCount} running`;
  }
  if (assignedCount > 0) {
    return `${assignedCount} assigned`;
  }
  return "Idle";
}

function teammateSummary(teammate: TeammateRecordPayload): string {
  const capabilitySummary = teammate.capability_profile.summary?.trim();
  if (capabilitySummary) {
    return capabilitySummary;
  }
  const summary = teammate.instructions?.trim();
  if (summary) {
    return summary;
  }
  return teammate.kind === "system"
    ? "The built-in General teammate picks up work when no custom teammate is a stronger routing match."
    : "No routing instructions yet.";
}

export function TeammatesPane({ workspaceId }: { workspaceId: string }) {
  const openIssueDetailTab = useOpenIssueDetailTab();
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
  const [detailTab, setDetailTab] = useState<DetailTab>("activity");
  const [searchQuery, setSearchQuery] = useState("");
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
  const showingDetail = isCreating || Boolean(selectedTeammate);

  useEffect(() => {
    if (
      selectedTeammateId &&
      selectedTeammateId !== NEW_TEAMMATE_ID &&
      !teammatesById[selectedTeammateId]
    ) {
      setSelectedTeammateId(null);
      setDetailTab("activity");
    }
  }, [selectedTeammateId, teammatesById]);

  useEffect(() => {
    if (isCreating) {
      setDraft((current) =>
        current.teammateId == null ? current : emptyDraft(),
      );
      return;
    }
    if (selectedTeammate) {
      setDraft(draftFromTeammate(selectedTeammate));
      return;
    }
    setDraft(emptyDraft());
  }, [isCreating, selectedTeammate]);

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

  const visibleTeammates = useMemo(
    () =>
      showArchived
        ? teammates
        : teammates.filter((teammate) => teammate.status === "active"),
    [showArchived, teammates],
  );

  const filteredTeammates = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return visibleTeammates;
    }
    return visibleTeammates.filter((teammate) => {
      const haystacks = [
        teammate.name,
        teammate.instructions ?? "",
        teammate.skills.map((skill) => skill.name).join(" "),
      ];
      return haystacks.some((value) => value.toLowerCase().includes(query));
    });
  }, [searchQuery, visibleTeammates]);

  const selectedIssues = useMemo(() => {
    if (!selectedTeammate) return [];
    return [...issues]
      .filter((issue) => issue.assignee_teammate_id === selectedTeammate.teammate_id)
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  }, [issues, selectedTeammate]);

  const selectedIssueCount = selectedIssues.length;
  const selectedRunningIssues = useMemo(
    () =>
      selectedIssues.filter(
        (issue) =>
          issue.status === "in_progress" || Boolean(issue.active_subagent_id),
      ),
    [selectedIssues],
  );
  const selectedRunningCount = selectedRunningIssues.length;
  const selectedCompletedCount = useMemo(
    () => selectedIssues.filter((issue) => issue.status === "done").length,
    [selectedIssues],
  );

  const draftLocked =
    isSaving ||
    (!!selectedTeammate && selectedTeammate.kind === "system") ||
    (!!selectedTeammate && selectedTeammate.status === "archived");
  const canSave =
    isCreating ||
    (!!selectedTeammate &&
      selectedTeammate.kind === "custom" &&
      selectedTeammate.status === "active");

  const handleBackToList = useCallback(() => {
    setSelectedTeammateId(null);
    setDetailTab("activity");
    setStatusMessage("");
  }, []);

  const handleStartCreate = useCallback(() => {
    setSelectedTeammateId(NEW_TEAMMATE_ID);
    setDraft(emptyDraft());
    setDetailTab("instructions");
    setStatusMessage("");
  }, []);

  const handleSelectTeammate = useCallback((teammateId: string) => {
    setSelectedTeammateId(teammateId);
    setDetailTab("activity");
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
    (localId: string, field: "skillId" | "name" | "content", value: string) => {
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

  const handleRevealSkill = useCallback(
    async (skill: SkillDraft) => {
      const targetPath =
        skill.sourceDir?.trim() ||
        teammateSkillRelativePath(draft.teammateId, skill.skillId);
      if (!targetPath) {
        setStatusMessage("Skill folder path is not available yet.");
        return;
      }
      try {
        await window.electronAPI.fs.revealInFolder(targetPath, workspaceId);
        setStatusMessage("");
      } catch (error) {
        setStatusMessage(
          error instanceof Error ? error.message : "Failed to reveal skill folder",
        );
      }
    },
    [draft.teammateId, workspaceId],
  );

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
    const capabilityProfile = normalizedCapabilityProfileInput(draft);
    setIsSaving(true);
    setStatusMessage("");
    try {
      const persistSkills = async (
        teammateId: string,
        previousSkills: TeammateSkillPayload[],
      ): Promise<void> => {
        const desiredSkillIds = new Set<string>();
        for (const skill of skills ?? []) {
          const created = await window.electronAPI.workspace.createTeammateSkill(
            workspaceId,
            teammateId,
            {
              workspace_id: workspaceId,
              skill,
            },
          );
          desiredSkillIds.add(created.skill.skill_id);
        }
        for (const existingSkill of previousSkills) {
          if (desiredSkillIds.has(existingSkill.skill_id)) {
            continue;
          }
          await window.electronAPI.workspace.deleteTeammateSkill(
            workspaceId,
            teammateId,
            existingSkill.skill_id,
          );
        }
      };
      if (isCreating) {
        const created = await window.electronAPI.workspace.createTeammate({
          workspace_id: workspaceId,
          name,
          instructions: draft.instructions.trim() || null,
          capability_profile: capabilityProfile,
        });
        await persistSkills(created.teammate.teammate_id, []);
        await refresh();
        setSelectedTeammateId(created.teammate.teammate_id);
        setDetailTab("activity");
        setStatusMessage("Teammate created.");
      } else if (selectedTeammate) {
        const updated = await window.electronAPI.workspace.updateTeammate(
          workspaceId,
          selectedTeammate.teammate_id,
          {
            workspace_id: workspaceId,
            name,
            instructions: draft.instructions.trim() || null,
            capability_profile: capabilityProfile,
          },
        );
        await persistSkills(updated.teammate.teammate_id, selectedTeammate.skills);
        await refresh();
        setSelectedTeammateId(updated.teammate.teammate_id);
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
      setDetailTab("activity");
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

  const headerTitle = !showingDetail
    ? "Teammates"
    : isCreating
      ? "New teammate"
      : selectedTeammate?.name || "Teammate";

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="border-b border-border px-6 py-3">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-foreground/35">
            <span>Teammate</span>
            {showingDetail ? (
              <>
                <span className="text-foreground/20">/</span>
                <span>{headerTitle}</span>
              </>
            ) : null}
          </div>
        </div>

        {showingDetail ? (
          <div className="border-b border-border px-6 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 rounded-xl px-3"
                    onClick={handleBackToList}
                    disabled={isSaving}
                  >
                    <ArrowLeft className="size-4" />
                    Back to teammates
                  </Button>
                  <div className="inline-flex h-9 items-center rounded-xl border border-border bg-card px-4 text-sm font-medium text-foreground shadow-sm">
                    {headerTitle}
                  </div>
                </>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <>
                  {selectedTeammate ? (
                    <>
                      <Badge variant="outline" className="h-9 rounded-xl bg-background px-3 text-foreground/65">
                        <StatusDot
                          variant={teammateStatusVariant(selectedTeammate.status)}
                          className="mr-2"
                        />
                        {teammateStatusLabel(selectedTeammate.status)}
                      </Badge>
                      <Badge variant="outline" className="h-9 rounded-xl bg-background px-3 text-foreground/65">
                        {selectedTeammate.skills.length} skills
                      </Badge>
                      <Badge variant="outline" className="h-9 rounded-xl bg-background px-3 text-foreground/65">
                        {selectedIssueCount} issues
                      </Badge>
                    </>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 rounded-xl px-3"
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
                  {selectedTeammate?.status === "archived" ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 rounded-xl px-3"
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
                      className="h-9 rounded-xl px-3"
                      onClick={() => setArchiveConfirmOpen(true)}
                      disabled={isSaving}
                    >
                      <Trash2 className="size-4" />
                      Archive
                    </Button>
                  ) : null}
                  {canSave ? (
                    <Button
                      type="button"
                      className="h-9 rounded-xl px-4"
                      onClick={() => void handleSave()}
                      disabled={draftLocked || isSaving}
                    >
                      {isSaving ? <Loader2 className="size-4 animate-spin" /> : null}
                      {isCreating ? "Create teammate" : "Save changes"}
                    </Button>
                  ) : null}
                </>
              </div>
            </div>
            {statusMessage ? (
              <div className="mt-3 rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground/65">
                {statusMessage}
              </div>
            ) : null}
          </div>
        ) : statusMessage ? (
          <div className="border-b border-border px-6 py-3">
            <div className="rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground/65">
              {statusMessage}
            </div>
          </div>
        ) : null}

        {!showingDetail ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-7xl">
              <Card className="overflow-hidden border-border bg-card/80 shadow-sm">
                <CardContent className="p-0">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="relative w-full max-w-md">
                        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground/38" />
                        <Input
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                          placeholder="Search teammates..."
                          className="h-11 rounded-xl bg-background/70 pl-9"
                        />
                      </div>
                      <Badge variant="outline" className="bg-background/80">
                        All {visibleTeammates.length}
                      </Badge>
                      <Badge variant="outline" className="bg-background/80">
                        Active{" "}
                        {
                          visibleTeammates.filter(
                            (teammate) => teammate.status === "active",
                          ).length
                        }
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <div className="text-sm text-foreground/55">
                        {filteredTeammates.length} of {visibleTeammates.length}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl px-3"
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
                          "h-9 rounded-xl px-3",
                          showArchived ? "bg-card" : "",
                        )}
                        onClick={() => setShowArchived((current) => !current)}
                      >
                        {showArchived ? "Hide archived" : "Show archived"}
                      </Button>
                      <Button
                        type="button"
                        className="h-9 rounded-xl px-4"
                        onClick={handleStartCreate}
                      >
                        <Plus className="size-4" />
                        New teammate
                      </Button>
                    </div>
                  </div>
                  {showArchived ? (
                    <div className="border-b border-border px-5 py-3">
                      <Badge
                        variant="outline"
                        className="h-8 rounded-xl bg-background px-3 text-foreground/65"
                      >
                        {archivedCount} archived
                      </Badge>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-[minmax(0,1.6fr)_160px_170px_140px_120px] gap-4 border-b border-border px-5 py-3 text-[11px] font-medium uppercase tracking-[0.18em] text-foreground/38">
                    <div>Agent</div>
                    <div>Status</div>
                    <div>Workload</div>
                    <div>Issues</div>
                    <div>Updated</div>
                  </div>

                  <div className="divide-y divide-border">
                    {filteredTeammates.length > 0 ? (
                      filteredTeammates.map((teammate) => {
                        const teammateIssues = issues.filter(
                          (issue) =>
                            issue.assignee_teammate_id === teammate.teammate_id,
                        );
                        const runningCount = teammateIssues.filter(
                          (issue) =>
                            issue.status === "in_progress" ||
                            Boolean(issue.active_subagent_id),
                        ).length;
                        return (
                          <button
                            key={teammate.teammate_id}
                            type="button"
                            className="grid w-full grid-cols-[minmax(0,1.6fr)_160px_170px_140px_120px] gap-4 px-5 py-4 text-left transition-colors hover:bg-background/45"
                            onClick={() => handleSelectTeammate(teammate.teammate_id)}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-3">
                                <div className="grid size-10 shrink-0 place-items-center rounded-2xl border border-border bg-background/70">
                                  {teammate.kind === "system" ? (
                                    <ShieldCheck className="size-4 text-foreground/45" />
                                  ) : (
                                    <UserRound className="size-4 text-foreground/45" />
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-foreground">
                                    {teammate.name}
                                  </div>
                                  <div className="mt-1 truncate text-sm text-foreground/48">
                                    {teammateSummary(teammate)}
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center">
                              <Badge variant="outline" className="bg-background/80">
                                <StatusDot
                                  variant={teammateStatusVariant(teammate.status)}
                                  className="mr-2"
                                />
                                {teammateStatusLabel(teammate.status)}
                              </Badge>
                            </div>
                            <div className="flex items-center text-sm text-foreground/68">
                              {teammateWorkloadLabel(runningCount, teammateIssues.length)}
                            </div>
                            <div className="flex items-center gap-2 text-sm text-foreground/68">
                              <span>{teammateIssues.length}</span>
                              <span className="text-foreground/35">assigned</span>
                            </div>
                            <div className="flex items-center text-sm text-foreground/48">
                              {relativeTimeLabel(teammate.updated_at)}
                            </div>
                          </button>
                        );
                      })
                    ) : (
                      <div className="px-5 py-12 text-center text-sm text-foreground/48">
                        {searchQuery.trim()
                          ? "No teammates match that search."
                          : "No teammates to show yet."}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-7xl">
              <div className="grid items-start gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
                <aside className="space-y-4">
                  <Card className="overflow-hidden bg-card/85">
                    <CardContent className="p-0">
                      <div className="border-b border-border px-5 py-5">
                        <div className="grid size-14 place-items-center rounded-3xl border border-border bg-background/75">
                          {selectedTeammate?.kind === "system" ? (
                            <ShieldCheck className="size-6 text-foreground/45" />
                          ) : (
                            <Bot className="size-6 text-foreground/45" />
                          )}
                        </div>
                        <div className="mt-5">
                          <div className="text-2xl font-semibold tracking-tight text-foreground">
                            {isCreating ? draft.name.trim() || "New teammate" : selectedTeammate?.name}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="bg-background/80">
                              <StatusDot
                                variant={
                                  isCreating
                                    ? "success"
                                    : teammateStatusVariant(
                                        selectedTeammate?.status ?? "active",
                                      )
                                }
                                className="mr-2"
                              />
                              {isCreating
                                ? "Active"
                                : teammateStatusLabel(
                                    selectedTeammate?.status ?? "active",
                                  )}
                            </Badge>
                            <Badge variant="outline" className="bg-background/80">
                              {isCreating
                                ? "Custom"
                                : selectedTeammate?.kind === "system"
                                  ? "System"
                                  : "Custom"}
                            </Badge>
                          </div>
                          <p className="mt-4 text-sm leading-6 text-foreground/58">
                            {isCreating
                              ? "Create a teammate the Workspace Manager can recognize and route to."
                              : selectedTeammate
                                ? teammateSummary(selectedTeammate)
                                : "No teammate selected."}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-4 px-5 py-5 text-sm">
                        <MetricRow
                          label="Assigned issues"
                          value={`${isCreating ? 0 : selectedIssueCount}`}
                        />
                        <MetricRow
                          label="Working now"
                          value={`${isCreating ? 0 : selectedRunningCount}`}
                        />
                        <MetricRow
                          label="Completed"
                          value={`${isCreating ? 0 : selectedCompletedCount}`}
                        />
                        <MetricRow
                          label="Skills"
                          value={`${
                            draft.skills.filter(
                              (skill) => skill.name.trim() || skill.content.trim(),
                            ).length
                          }`}
                        />
                        <MetricRow
                          label="Created"
                          value={
                            isCreating
                              ? "Not created yet"
                              : relativeTimeLabel(selectedTeammate?.created_at ?? null)
                          }
                        />
                        <MetricRow
                          label="Updated"
                          value={
                            isCreating
                              ? "Draft"
                              : relativeTimeLabel(selectedTeammate?.updated_at ?? null)
                          }
                        />
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="bg-card/85">
                    <CardHeader>
                      <CardTitle>Routing note</CardTitle>
                    </CardHeader>
                      <CardContent>
                        <p className="text-sm leading-6 text-foreground/58">
                          The Workspace Manager routes from each teammate&apos;s
                          capability profile first, then falls back to their
                        instructions and teammate skill folders. Archived teammates
                        drop out of routing and disappear from normal navigation.
                        </p>
                      </CardContent>
                  </Card>
                </aside>

                <div className="min-w-0">
                  <Card className="overflow-hidden bg-card/85">
                    <Tabs
                      value={detailTab}
                      onValueChange={(value) => setDetailTab(value as DetailTab)}
                      className="block w-full"
                    >
                      <div className="border-b border-border px-5">
                        <TabsList
                          variant="line"
                          className="w-full justify-start rounded-none bg-transparent p-0"
                        >
                          {!isCreating ? (
                            <>
                              <TabsTrigger
                                value="activity"
                                className="h-12 rounded-none px-3"
                              >
                                <Activity className="size-4" />
                                Activity
                              </TabsTrigger>
                              <TabsTrigger
                                value="issues"
                                className="h-12 rounded-none px-3"
                              >
                                <ListTodo className="size-4" />
                                Issues
                              </TabsTrigger>
                            </>
                          ) : null}
                          <TabsTrigger
                            value="instructions"
                            className="h-12 rounded-none px-3"
                          >
                            <ScrollText className="size-4" />
                            Instructions
                          </TabsTrigger>
                          <TabsTrigger
                            value="skills"
                            className="h-12 rounded-none px-3"
                          >
                            <FileCode2 className="size-4" />
                            Skills
                          </TabsTrigger>
                        </TabsList>
                      </div>

                      {!isCreating ? (
                        <TabsContent value="activity" className="w-full px-5 py-5">
                          <div className="space-y-4">
                            <Card className="bg-background/55">
                              <CardHeader>
                                <CardTitle>Now</CardTitle>
                                <CardDescription>
                                  Current workload for this teammate.
                                </CardDescription>
                              </CardHeader>
                              <CardContent className="space-y-3">
                                {selectedRunningIssues.length > 0 ? (
                                  selectedRunningIssues.map((issue) => (
                                    <button
                                      key={issue.issue_id}
                                      type="button"
                                      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-background/70 px-4 py-3 text-left transition-colors hover:bg-background/90"
                                      onClick={() =>
                                        void openIssueDetailTab({
                                          workspaceId: issue.workspace_id,
                                          issueId: issue.issue_id,
                                          title: issue.title,
                                        })
                                      }
                                    >
                                      <div className="min-w-0">
                                        <div className="truncate text-sm font-medium text-foreground">
                                          {issue.issue_id} · {issue.title}
                                        </div>
                                        <div className="mt-1 text-sm text-foreground/48">
                                          Updated {relativeTimeLabel(issue.updated_at)}
                                        </div>
                                      </div>
                                      <Badge
                                        variant="outline"
                                        className="bg-background/80"
                                      >
                                        <StatusDot
                                          variant="primary"
                                          className="mr-2"
                                        />
                                        Working
                                      </Badge>
                                    </button>
                                  ))
                                ) : (
                                  <div className="rounded-2xl border border-dashed border-border bg-background/45 px-4 py-8 text-sm text-foreground/48">
                                    No active work right now.
                                  </div>
                                )}
                              </CardContent>
                            </Card>

                            <Card className="bg-background/55">
                              <CardHeader>
                                <CardTitle>Recent work</CardTitle>
                                <CardDescription>
                                  The latest issues this teammate has touched.
                                </CardDescription>
                              </CardHeader>
                              <CardContent className="space-y-3">
                                {selectedIssues.length > 0 ? (
                                  selectedIssues.slice(0, 5).map((issue) => (
                                    <button
                                      key={issue.issue_id}
                                      type="button"
                                      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-background/70 px-4 py-3 text-left transition-colors hover:bg-background/90"
                                      onClick={() =>
                                        void openIssueDetailTab({
                                          workspaceId: issue.workspace_id,
                                          issueId: issue.issue_id,
                                          title: issue.title,
                                        })
                                      }
                                    >
                                      <div className="min-w-0">
                                        <div className="truncate text-sm font-medium text-foreground">
                                          {issue.issue_id} · {issue.title}
                                        </div>
                                        <div className="mt-1 text-sm text-foreground/48">
                                          {issueStatusLabel(issue.status)} · Updated{" "}
                                          {relativeTimeLabel(issue.updated_at)}
                                        </div>
                                      </div>
                                      <Badge
                                        variant="outline"
                                        className={issuePriorityBadgeClass(
                                          issue.priority,
                                        )}
                                      >
                                        {issuePriorityLabel(issue.priority)}
                                      </Badge>
                                    </button>
                                  ))
                                ) : (
                                  <div className="rounded-2xl border border-dashed border-border bg-background/45 px-4 py-8 text-sm text-foreground/48">
                                    No issue activity yet.
                                  </div>
                                )}
                              </CardContent>
                            </Card>
                          </div>
                        </TabsContent>
                      ) : null}

                      {!isCreating ? (
                        <TabsContent value="issues" className="w-full px-5 py-5">
                          <Card className="bg-background/55">
                            <CardHeader>
                              <CardTitle>Assigned issues</CardTitle>
                              <CardDescription>
                                All issues currently assigned to this teammate.
                              </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3">
                              {selectedIssues.length > 0 ? (
                                selectedIssues.map((issue) => (
                                  <button
                                    key={issue.issue_id}
                                    type="button"
                                    className="flex w-full items-center justify-between gap-4 rounded-2xl border border-border bg-background/70 px-4 py-3 text-left transition-colors hover:bg-background/90"
                                    onClick={() =>
                                      void openIssueDetailTab({
                                        workspaceId: issue.workspace_id,
                                        issueId: issue.issue_id,
                                        title: issue.title,
                                      })
                                    }
                                  >
                                    <div className="min-w-0">
                                      <div className="truncate text-sm font-medium text-foreground">
                                        {issue.issue_id} · {issue.title}
                                      </div>
                                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/48">
                                        <span>{issueStatusLabel(issue.status)}</span>
                                        <span className="text-foreground/25">•</span>
                                        <span>
                                          Updated {relativeTimeLabel(issue.updated_at)}
                                        </span>
                                      </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                      <Badge
                                        variant="outline"
                                        className="bg-background/80"
                                      >
                                        {issueStatusLabel(issue.status)}
                                      </Badge>
                                      <Badge
                                        variant="outline"
                                        className={issuePriorityBadgeClass(
                                          issue.priority,
                                        )}
                                      >
                                        {issuePriorityLabel(issue.priority)}
                                      </Badge>
                                    </div>
                                  </button>
                                ))
                              ) : (
                                <div className="rounded-2xl border border-dashed border-border bg-background/45 px-4 py-8 text-sm text-foreground/48">
                                  No assigned issues yet.
                                </div>
                              )}
                            </CardContent>
                          </Card>
                        </TabsContent>
                      ) : null}

                      <TabsContent
                        value="instructions"
                        className="w-full px-5 py-5"
                      >
                        <Card className="bg-background/55">
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
                                Routing summary
                              </div>
                              <Textarea
                                value={draft.capabilitySummary}
                                onChange={(event) =>
                                  setDraft((current) => ({
                                    ...current,
                                    capabilitySummary: event.target.value,
                                  }))
                                }
                                placeholder="Own React dashboard implementation, UI refactors, and frontend build issues."
                                disabled={draftLocked}
                                className="min-h-[120px] resize-y bg-background/75"
                              />
                            </div>
                            <div>
                              <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
                                Capability tags
                              </div>
                              <Input
                                value={draft.capabilityTags}
                                onChange={(event) =>
                                  setDraft((current) => ({
                                    ...current,
                                    capabilityTags: event.target.value,
                                  }))
                                }
                                placeholder="frontend, react, dashboard, ui"
                                disabled={draftLocked}
                                className="h-11 bg-background/75"
                              />
                              <div className="mt-2 text-xs text-foreground/45">
                                Comma-separated domains, specialties, or routing cues.
                              </div>
                            </div>
                            <div>
                              <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
                                Preferred tools
                              </div>
                              <Input
                                value={draft.preferredTools}
                                onChange={(event) =>
                                  setDraft((current) => ({
                                    ...current,
                                    preferredTools: event.target.value,
                                  }))
                                }
                                placeholder="edit, bash, web_search"
                                disabled={draftLocked}
                                className="h-11 bg-background/75"
                              />
                              <div className="mt-2 text-xs text-foreground/45">
                                Optional comma-separated tool ids that are strong fits for this teammate.
                              </div>
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
                                className="min-h-[280px] resize-y bg-background/75"
                              />
                            </div>
                          </CardContent>
                        </Card>
                      </TabsContent>

                      <TabsContent value="skills" className="w-full px-5 py-5">
                        <Card className="bg-background/55">
                          <CardHeader>
                            <div>
                              <CardTitle>Skills</CardTitle>
                              <CardDescription>
                                Manage teammate-local skills stored under the workspace filesystem.
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
                            <div className="rounded-2xl border border-border bg-background/55 px-4 py-3 text-sm text-foreground/55">
                              Each skill lives at
                              <span className="mx-1 font-mono text-foreground/72">
                                teammates/&lt;teammate-id&gt;/skills/&lt;skill-id&gt;/SKILL.md
                              </span>
                              . Removing a skill deletes its entire skill folder, including any helper files inside it.
                            </div>
                            {draft.skills.length === 0 ? (
                              <div className="rounded-2xl border border-dashed border-border bg-background/45 px-4 py-8 text-center text-sm text-foreground/48">
                                No skills yet
                              </div>
                            ) : (
                              draft.skills.map((skill, index) => (
                                <div
                                  key={skill.localId}
                                  className="rounded-2xl border border-border bg-background/70 p-4"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                                      <FileCode2 className="size-4 text-foreground/45" />
                                      {skill.skillId?.trim() || skill.name.trim() || `Skill ${index + 1}`}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {skill.hasSidecarAssets ? (
                                        <Badge variant="outline" className="bg-card/80 text-[11px]">
                                          Helper files
                                        </Badge>
                                      ) : null}
                                      {!isCreating ? (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => void handleRevealSkill(skill)}
                                        >
                                          <FolderOpen className="size-4" />
                                          Reveal
                                        </Button>
                                      ) : null}
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
                                  </div>
                                  <div className="mt-3 text-xs text-foreground/45">
                                    {skill.sourceDir?.trim() ||
                                      teammateSkillRelativePath(
                                        draft.teammateId,
                                        skill.skillId,
                                      ) ||
                                      "A skill folder will be created after save."}
                                  </div>
                                  <div className="mt-4 grid gap-4">
                                    <div>
                                      <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
                                        Skill id
                                      </div>
                                      <Input
                                        value={skill.skillId ?? ""}
                                        onChange={(event) =>
                                          handleSkillChange(
                                            skill.localId,
                                            "skillId",
                                            event.target.value,
                                          )
                                        }
                                        placeholder="frontend-playbook"
                                        disabled={draftLocked}
                                        className="h-10 bg-card/80 font-mono text-[13px]"
                                      />
                                      <div className="mt-2 text-xs text-foreground/45">
                                        Stable folder and invocation id. Leave blank to derive it from the label.
                                      </div>
                                    </div>
                                    <div>
                                      <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
                                        Skill label
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
                                      <div className="mt-2 text-xs text-foreground/45">
                                        Stored as the SKILL.md description and used as the human-facing label.
                                      </div>
                                    </div>
                                    <div>
                                      <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-foreground/42">
                                        SKILL.md body
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
                                        className="min-h-[220px] resize-y bg-card/80 font-mono text-[13px]"
                                      />
                                      <div className="mt-2 text-xs text-foreground/45">
                                        The frontmatter is generated from the skill id and label. The textarea stores the markdown body that follows it.
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ))
                            )}
                          </CardContent>
                        </Card>
                      </TabsContent>
                    </Tabs>
                  </Card>
                </div>
              </div>
            </div>
          </div>
        )}
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

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground/45">{label}</span>
      <span className="text-right text-foreground/82">{value || "—"}</span>
    </div>
  );
}
