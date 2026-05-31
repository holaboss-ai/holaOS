import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
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
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { chatPanelViewAtom, chatSessionOpenRequestAtom } from "./state/ui";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";

const TEAMMATE_TABLE_GRID_COLUMNS =
  "grid-cols-[minmax(240px,2.4fr)_132px_132px_104px_96px]";

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
  if (!summary && capabilities.length === 0) {
    return null;
  }
  return {
    summary: summary || null,
    capabilities,
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
  if (teammate.kind === "system" && teammate.teammate_id === "hr") {
    return "The built-in HR teammate owns teammate design, bootstrap quality, and roster changes.";
  }
  return teammate.kind === "system"
    ? "The built-in General teammate picks up work when no custom teammate is a stronger routing match."
    : "No routing instructions yet.";
}

function teammateCreationRequestPrompt(name: string, role: string): string {
  return [
    "Please ask the built-in HR teammate to create this teammate.",
    "",
    `Teammate name: ${name}`,
    `Teammate role: ${role}`,
  ].join("\n");
}

export function TeammatesPane({ workspaceId }: { workspaceId: string }) {
  const openIssueDetailTab = useOpenIssueDetailTab();
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setChatSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
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
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createRole, setCreateRole] = useState("");
  const [createError, setCreateError] = useState("");
  const [isCreateSubmitting, setIsCreateSubmitting] = useState(false);

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

  const selectedTeammate = selectedTeammateId
    ? teammatesById[selectedTeammateId] ?? null
    : null;
  const showingDetail = Boolean(selectedTeammate);

  useEffect(() => {
    if (selectedTeammateId && !teammatesById[selectedTeammateId]) {
      setSelectedTeammateId(null);
      setDetailTab("activity");
    }
  }, [selectedTeammateId, teammatesById]);

  useEffect(() => {
    if (selectedTeammate) {
      setDraft(draftFromTeammate(selectedTeammate));
      return;
    }
    setDraft(emptyDraft());
  }, [selectedTeammate]);

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
    !!selectedTeammate &&
    selectedTeammate.kind === "custom" &&
    selectedTeammate.status === "active";

  const handleBackToList = useCallback(() => {
    setSelectedTeammateId(null);
    setDetailTab("activity");
    setStatusMessage("");
  }, []);

  const handleStartCreate = useCallback(() => {
    setCreateDialogOpen(true);
    setCreateName("");
    setCreateRole("");
    setCreateError("");
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
      if (selectedTeammate) {
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
  }, [draft, refresh, selectedTeammate, workspaceId]);

  const handleCreateDialogOpenChange = useCallback((nextOpen: boolean) => {
    setCreateDialogOpen(nextOpen);
    if (!nextOpen) {
      setCreateName("");
      setCreateRole("");
      setCreateError("");
      setIsCreateSubmitting(false);
    }
  }, []);

  const handleSubmitCreateRequest = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const name = createName.trim();
      const role = createRole.trim();
      if (!workspaceId.trim()) {
        setCreateError("Select a workspace before creating a teammate.");
        return;
      }
      if (!name) {
        setCreateError("Teammate name is required.");
        return;
      }
      if (!role) {
        setCreateError("Teammate role is required.");
        return;
      }

      setIsCreateSubmitting(true);
      setCreateError("");
      try {
        const ensured = await window.electronAPI.workspace.ensureMainSession(
          workspaceId,
        );
        const sessionId = ensured.session.session_id;
        await window.electronAPI.workspace.queueSessionInput({
          workspace_id: workspaceId,
          session_id: sessionId,
          text: teammateCreationRequestPrompt(name, role),
          image_urls: [],
          attachments: [],
        });
        setChatPanelView("chat");
        setChatSessionOpenRequest({
          sessionId,
          requestKey: Date.now(),
          mode: "session",
        });
        handleCreateDialogOpenChange(false);
        setStatusMessage(
          "Sent teammate creation request to the main session. Watch the chat panel for follow-up questions.",
        );
      } catch (error) {
        setCreateError(
          error instanceof Error
            ? error.message
            : "Failed to send teammate creation request",
        );
      } finally {
        setIsCreateSubmitting(false);
      }
    },
    [
      createName,
      createRole,
      handleCreateDialogOpenChange,
      setChatPanelView,
      setChatSessionOpenRequest,
      workspaceId,
    ],
  );

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
    : selectedTeammate?.name || "Teammate";

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-background">
        {/* Top bar — matches dashboard / board / issue detail. */}
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="font-medium uppercase tracking-wider text-muted-foreground">
              Teammates
            </span>
            {showingDetail ? (
              <>
                <span className="shrink-0 text-muted-foreground">/</span>
                <span className="truncate text-foreground">{headerTitle}</span>
              </>
            ) : null}
          </div>
          {!showingDetail ? (
            <div className="text-xs tabular-nums text-muted-foreground">
              {filteredTeammates.length} of {visibleTeammates.length}
            </div>
          ) : null}
        </header>

        {showingDetail ? (
          <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleBackToList}
                disabled={isSaving}
                className="-ml-2 gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                Back
              </Button>
              {selectedTeammate ? (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot
                      variant={teammateStatusVariant(selectedTeammate.status)}
                    />
                    {teammateStatusLabel(selectedTeammate.status)}
                  </span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {selectedTeammate.skills.length} skills · {selectedIssueCount} issues
                  </span>
                </>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void refresh()}
                disabled={isLoading}
                className="text-muted-foreground hover:text-foreground"
              >
                {isLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
              </Button>
              {selectedTeammate?.status === "archived" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleRestore()}
                  disabled={isSaving || selectedTeammate.kind === "system"}
                >
                  <RotateCcw className="size-3.5" />
                  Restore
                </Button>
              ) : null}
              {selectedTeammate?.kind === "custom" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setArchiveConfirmOpen(true)}
                  disabled={isSaving}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              ) : null}
              {canSave ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={draftLocked || isSaving}
                >
                  {isSaving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Save
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {statusMessage ? (
          <div className="border-b border-border bg-card/40 px-6 py-2 text-sm text-muted-foreground">
            {statusMessage}
          </div>
        ) : null}

        {!showingDetail ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-fg-4">
            <div className="mx-auto w-full max-w-[1180px] space-y-4 px-6 py-5">
              {/* Toolbar — search + filters + actions, no card wrapper */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="relative w-full max-w-sm">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Search teammates"
                      className="h-8 pl-8 text-sm"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowArchived((current) => !current)}
                    className={cn(
                      "text-muted-foreground hover:text-foreground",
                      showArchived ? "bg-fg-6 text-foreground" : "",
                    )}
                  >
                    {showArchived ? "Hide archived" : "Show archived"}
                    {showArchived && archivedCount > 0 ? (
                      <span className="ml-1 tabular-nums text-muted-foreground">
                        {archivedCount}
                      </span>
                    ) : null}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void refresh()}
                    disabled={isLoading}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {isLoading ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </Button>
                  <Button type="button" size="sm" onClick={handleStartCreate}>
                    <Plus className="size-3.5" />
                    New teammate
                  </Button>
                </div>
              </div>

              {/* Table card — bg-card surface, hairline border, divide-y rows */}
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                {/* Header */}
                <div
                  className={cn(
                    "grid gap-3 border-b border-border bg-fg-2 px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground",
                    TEAMMATE_TABLE_GRID_COLUMNS,
                  )}
                >
                  <div>Agent</div>
                  <div>Status</div>
                  <div>Workload</div>
                  <div>Issues</div>
                  <div>Updated</div>
                </div>

                {/* Body */}
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
                          className={cn(
                            "grid w-full gap-3 px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.025]",
                            TEAMMATE_TABLE_GRID_COLUMNS,
                          )}
                          onClick={() => handleSelectTeammate(teammate.teammate_id)}
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <div className="grid size-7 shrink-0 place-items-center rounded-full bg-fg-8 text-muted-foreground">
                              {teammate.kind === "system" ? (
                                <ShieldCheck className="size-3.5" />
                              ) : (
                                <UserRound className="size-3.5" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-foreground">
                                {teammate.name}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {teammateSummary(teammate)}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <StatusDot
                              variant={teammateStatusVariant(teammate.status)}
                            />
                            {teammateStatusLabel(teammate.status)}
                          </div>
                          <div className="flex items-center text-xs text-muted-foreground">
                            {teammateWorkloadLabel(
                              runningCount,
                              teammateIssues.length,
                            )}
                          </div>
                          <div className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                            <span className="text-foreground">
                              {teammateIssues.length}
                            </span>
                            <span>assigned</span>
                          </div>
                          <div className="flex items-center text-xs tabular-nums text-muted-foreground">
                            {relativeTimeLabel(teammate.updated_at)}
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                      {searchQuery.trim()
                        ? "No teammates match that search."
                        : "No teammates to show yet."}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto bg-fg-4">
            <div className="mx-auto w-full max-w-[1180px] px-6 py-5">
              <div className="grid items-start gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
                <aside className="space-y-4">
                  <div className="overflow-hidden rounded-xl border border-border bg-card">
                    <div className="px-4 py-4">
                      <div className="grid size-10 place-items-center rounded-full bg-fg-8 text-muted-foreground">
                        {selectedTeammate?.kind === "system" ? (
                          <ShieldCheck className="size-4" />
                        ) : (
                          <Bot className="size-4" />
                        )}
                      </div>
                      <div className="mt-3 text-base font-semibold tracking-tight text-foreground">
                        {selectedTeammate?.name}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <StatusDot
                            variant={teammateStatusVariant(
                              selectedTeammate?.status ?? "active",
                            )}
                          />
                          {teammateStatusLabel(
                            selectedTeammate?.status ?? "active",
                          )}
                        </span>
                        <span className="text-muted-foreground/40">·</span>
                        <span>
                          {selectedTeammate?.kind === "system"
                            ? "System"
                            : "Custom"}
                        </span>
                      </div>
                      <p className="mt-3 text-xs leading-snug text-muted-foreground">
                        {selectedTeammate
                          ? teammateSummary(selectedTeammate)
                          : "No teammate selected."}
                      </p>
                    </div>

                    <div className="space-y-2 border-t border-border px-4 py-3">
                      <MetricRow
                        label="Assigned issues"
                        value={`${selectedIssueCount}`}
                      />
                      <MetricRow
                        label="Working now"
                        value={`${selectedRunningCount}`}
                      />
                      <MetricRow
                        label="Completed"
                        value={`${selectedCompletedCount}`}
                      />
                      <MetricRow
                        label="Skills"
                        value={`${
                          draft.skills.filter(
                            (skill) =>
                              skill.name.trim() || skill.content.trim(),
                          ).length
                        }`}
                      />
                      <MetricRow
                        label="Created"
                        value={relativeTimeLabel(
                          selectedTeammate?.created_at ?? null,
                        )}
                      />
                      <MetricRow
                        label="Updated"
                        value={relativeTimeLabel(
                          selectedTeammate?.updated_at ?? null,
                        )}
                      />
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-card px-4 py-3">
                    <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Routing note
                    </div>
                    <p className="mt-2 text-xs leading-snug text-muted-foreground">
                      The Workspace Manager routes from each teammate&apos;s
                      capability profile first, then falls back to their
                      instructions and teammate skill folders. Archived
                      teammates drop out of routing and disappear from normal
                      navigation.
                    </p>
                  </div>
                </aside>

                <div className="min-w-0">
                  <div className="overflow-hidden rounded-xl border border-border bg-card">
                    <Tabs
                      value={detailTab}
                      onValueChange={(value) =>
                        setDetailTab(value as DetailTab)
                      }
                      className="block w-full"
                    >
                      <div className="border-b border-border px-3">
                        <TabsList
                          variant="line"
                          className="h-auto w-full justify-start gap-0 rounded-none bg-transparent p-0"
                        >
                          {(
                            [
                              {
                                value: "activity",
                                label: "Activity",
                                Icon: Activity,
                              },
                              {
                                value: "issues",
                                label: "Issues",
                                Icon: ListTodo,
                              },
                              {
                                value: "instructions",
                                label: "Instructions",
                                Icon: ScrollText,
                              },
                              {
                                value: "skills",
                                label: "Skills",
                                Icon: FileCode2,
                              },
                            ] as const
                          ).map(({ value, label, Icon }) => (
                            <TabsTrigger
                              key={value}
                              value={value}
                              className={cn(
                                // Strip the primitive's default `border` (4
                                // sides @ 1px transparent) so the active
                                // foreground colour doesn't leak onto the
                                // top / left / right edges as a faux box.
                                "-mb-px !h-9 !flex-none !rounded-none !border-0 !border-b-2 !border-b-transparent !bg-transparent !px-3 !text-sm !font-medium !text-muted-foreground !shadow-none",
                                "hover:!text-foreground",
                                // Active tab: only the bottom border lights
                                // up. It overlaps the container's
                                // border-b (via -mb-px) so the gray
                                // hairline turns into a foreground
                                // underline under the active tab only.
                                "data-active:!border-b-foreground data-active:!text-foreground",
                              )}
                            >
                              <Icon className="size-3.5" />
                              {label}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                      </div>

                      <TabsContent value="activity" className="w-full px-4 py-4">
                        <div className="space-y-5">
                          <DetailSection
                            eyebrow="Now"
                            meta={
                              selectedRunningIssues.length > 0
                                ? `${selectedRunningIssues.length} active`
                                : undefined
                            }
                          >
                            {selectedRunningIssues.length > 0 ? (
                              <ul className="divide-y divide-border">
                                {selectedRunningIssues.map((issue) => (
                                  <li key={issue.issue_id}>
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2.5 px-1.5 py-2 text-left transition-colors hover:bg-foreground/[0.025]"
                                      onClick={() =>
                                        void openIssueDetailTab({
                                          workspaceId: issue.workspace_id,
                                          issueId: issue.issue_id,
                                          title: issue.title,
                                        })
                                      }
                                    >
                                      <StatusDot variant="primary" pulse />
                                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                        {issue.issue_id}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                        {issue.title}
                                      </span>
                                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                        {relativeTimeLabel(issue.updated_at)}
                                      </span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <EmptyRow label="No active work right now." />
                            )}
                          </DetailSection>

                          <DetailSection eyebrow="Recent work">
                            {selectedIssues.length > 0 ? (
                              <ul className="divide-y divide-border">
                                {selectedIssues.slice(0, 5).map((issue) => (
                                  <li key={issue.issue_id}>
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2.5 px-1.5 py-2 text-left transition-colors hover:bg-foreground/[0.025]"
                                      onClick={() =>
                                        void openIssueDetailTab({
                                          workspaceId: issue.workspace_id,
                                          issueId: issue.issue_id,
                                          title: issue.title,
                                        })
                                      }
                                    >
                                      <StatusDot
                                        variant={issueRowDotVariant(issue.status)}
                                      />
                                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                        {issue.issue_id}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                        {issue.title}
                                      </span>
                                      {issue.priority ? (
                                        <span
                                          className={cn(
                                            "shrink-0 rounded px-1 py-px text-xs font-medium",
                                            issuePriorityBadgeClass(
                                              issue.priority,
                                            ),
                                          )}
                                        >
                                          {issuePriorityLabel(issue.priority)}
                                        </span>
                                      ) : null}
                                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                        {relativeTimeLabel(issue.updated_at)}
                                      </span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <EmptyRow label="No issue activity yet." />
                            )}
                          </DetailSection>
                        </div>
                      </TabsContent>

                      <TabsContent value="issues" className="w-full px-4 py-4">
                        <DetailSection
                          eyebrow="Assigned issues"
                          meta={`${selectedIssues.length} total`}
                        >
                          {selectedIssues.length > 0 ? (
                            <ul className="divide-y divide-border">
                              {selectedIssues.map((issue) => (
                                <li key={issue.issue_id}>
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-2.5 px-1.5 py-2 text-left transition-colors hover:bg-foreground/[0.025]"
                                    onClick={() =>
                                      void openIssueDetailTab({
                                        workspaceId: issue.workspace_id,
                                        issueId: issue.issue_id,
                                        title: issue.title,
                                      })
                                    }
                                  >
                                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                      {issue.issue_id}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                      {issue.title}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                      {issueStatusLabel(issue.status)}
                                    </span>
                                    {issue.priority ? (
                                      <span
                                        className={cn(
                                          "shrink-0 rounded px-1 py-px text-xs font-medium",
                                          issuePriorityBadgeClass(
                                            issue.priority,
                                          ),
                                        )}
                                      >
                                        {issuePriorityLabel(issue.priority)}
                                      </span>
                                    ) : null}
                                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                      {relativeTimeLabel(issue.updated_at)}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <EmptyRow label="No assigned issues yet." />
                          )}
                        </DetailSection>
                      </TabsContent>

                      <TabsContent
                        value="instructions"
                        className="w-full px-4 py-4"
                      >
                        <DetailSection
                          eyebrow="Identity"
                          description="Name the teammate and describe the routing behavior the Workspace Manager should recognize."
                        >
                          <div className="grid gap-4 pt-1">
                            <FormField label="Name">
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
                                className="h-9"
                              />
                            </FormField>
                            <FormField label="Routing summary">
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
                                className="min-h-[100px] resize-y"
                              />
                            </FormField>
                            <FormField
                              label="Capability tags"
                              hint="Comma-separated domains, specialties, or routing cues."
                            >
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
                                className="h-9"
                              />
                            </FormField>
                            <FormField label="Instructions">
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
                                className="min-h-[240px] resize-y"
                              />
                            </FormField>
                          </div>
                        </DetailSection>
                      </TabsContent>

                      <TabsContent value="skills" className="w-full px-4 py-4">
                        <DetailSection
                          eyebrow="Skills"
                          description="Manage teammate-local skills stored under the workspace filesystem."
                          action={
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleAddSkill}
                              disabled={draftLocked}
                            >
                              <Plus className="size-3.5" />
                              Add skill
                            </Button>
                          }
                        >
                          <div className="space-y-3">
                            <div className="rounded-md bg-fg-2 px-3 py-2 text-xs leading-snug text-muted-foreground">
                              Each skill lives at{" "}
                              <span className="font-mono text-foreground">
                                teammates/&lt;teammate-id&gt;/skills/&lt;skill-id&gt;/SKILL.md
                              </span>
                              . Removing a skill deletes its entire skill folder,
                              including any helper files inside it.
                            </div>
                            {draft.skills.length === 0 ? (
                              <EmptyRow label="No skills yet" />
                            ) : (
                              draft.skills.map((skill, index) => (
                                <div
                                  key={skill.localId}
                                  className="overflow-hidden rounded-lg border border-border bg-fg-2"
                                >
                                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                                      <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                                      <span className="truncate">
                                        {skill.skillId?.trim() ||
                                          skill.name.trim() ||
                                          `Skill ${index + 1}`}
                                      </span>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                      {skill.hasSidecarAssets ? (
                                        <span className="rounded bg-fg-8 px-1.5 py-0.5 text-xs text-muted-foreground">
                                          Helper files
                                        </span>
                                      ) : null}
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          void handleRevealSkill(skill)
                                        }
                                        className="text-muted-foreground hover:text-foreground"
                                      >
                                        <FolderOpen className="size-3.5" />
                                        Reveal
                                      </Button>
                                      {!draftLocked ? (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon-sm"
                                          aria-label="Remove skill"
                                          onClick={() =>
                                            handleRemoveSkill(skill.localId)
                                          }
                                          className="text-muted-foreground hover:text-destructive"
                                        >
                                          <X className="size-3.5" />
                                        </Button>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="space-y-3 bg-card px-3 py-3">
                                    <div className="font-mono text-xs text-muted-foreground">
                                      {skill.sourceDir?.trim() ||
                                        teammateSkillRelativePath(
                                          draft.teammateId,
                                          skill.skillId,
                                        ) ||
                                        "A skill folder will be created after save."}
                                    </div>
                                    <FormField
                                      label="Skill id"
                                      hint="Stable folder and invocation id. Leave blank to derive it from the label."
                                    >
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
                                        className="h-8 font-mono"
                                      />
                                    </FormField>
                                    <FormField
                                      label="Skill label"
                                      hint="Stored as the SKILL.md description and used as the human-facing label."
                                    >
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
                                        className="h-8"
                                      />
                                    </FormField>
                                    <FormField
                                      label="SKILL.md body"
                                      hint="The frontmatter is generated from the skill id and label. The textarea stores the markdown body that follows it."
                                    >
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
                                        className="min-h-[180px] resize-y font-mono"
                                      />
                                    </FormField>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </DetailSection>
                      </TabsContent>
                    </Tabs>
                  </div>
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

      <DialogPrimitive.Root
        open={createDialogOpen}
        onOpenChange={handleCreateDialogOpenChange}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop
            className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
            style={{
              animationDuration: "var(--duration-snappy)",
              animationTimingFunction: "var(--ease-out-expo)",
            }}
          />
          <DialogPrimitive.Popup
            className="fixed top-[16%] left-1/2 z-[100] w-[min(540px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl outline-none backdrop-blur-2xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
            style={{
              animationDuration: "var(--duration-base)",
              animationTimingFunction: "var(--ease-out-expo)",
            }}
          >
            <form onSubmit={handleSubmitCreateRequest} className="flex flex-col">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    New teammate
                  </div>
                  <div className="mt-1 text-xs text-foreground/48">
                    Send a teammate creation request to the main session.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleCreateDialogOpenChange(false)}
                  className="grid size-7 place-items-center rounded-md text-foreground/45 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                  aria-label="Close new teammate dialog"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="grid gap-4 px-4 py-4">
                <FormField label="Name">
                  <Input
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder="Frontend teammate"
                    disabled={isCreateSubmitting}
                    className="h-9"
                  />
                </FormField>
                <FormField
                  label="Role"
                  hint="The main session will route this through the roster workflow, ask any follow-up questions it still needs, and provision a stronger teammate when the remit is clear enough."
                >
                  <Textarea
                    value={createRole}
                    onChange={(event) => setCreateRole(event.target.value)}
                    placeholder="Own React dashboard implementation, UI polish, and frontend build issues."
                    disabled={isCreateSubmitting}
                    className="min-h-[100px] resize-y"
                  />
                </FormField>
                {createError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {createError}
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => handleCreateDialogOpenChange(false)}
                  disabled={isCreateSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isCreateSubmitting}>
                  {isCreateSubmitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  Send request
                </Button>
              </div>
            </form>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums text-foreground">
        {value || "—"}
      </span>
    </div>
  );
}

/**
 * Section block used inside teammate detail tabs. Matches the dashboard's
 * eyebrow + meta header pattern so all three surfaces (dashboard, board,
 * teammate detail) speak the same visual language.
 */
function DetailSection({
  eyebrow,
  meta,
  description,
  action,
  children,
}: {
  eyebrow: string;
  meta?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </h3>
          {description ? (
            <p className="text-xs leading-snug text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
        {meta ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
      {hint ? (
        <p className="text-xs leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

function issueRowDotVariant(
  status: IssueStatusPayload,
): "success" | "primary" | "warning" | "info" | "muted" {
  switch (status) {
    case "done":
      return "success";
    case "in_progress":
      return "primary";
    case "blocked":
      return "warning";
    case "in_review":
      return "info";
    case "backlog":
    case "todo":
    default:
      return "muted";
  }
}
