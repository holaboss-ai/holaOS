import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";

import { HarnessPicker } from "@/components/harness/HarnessPicker";
import { useAvailableHarnesses } from "@/components/harness/useAvailableHarnesses";
import { settingsOpenAtom } from "@/components/layout/shell/state/ui";
import { useWorkspaceProjects } from "@/components/layout/shell/useWorkspaceLists";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "@/components/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { displayModelLabel } from "@/components/panes/ChatPane/helpers";
import { useChatComposerModelSelection } from "@/lib/chat/useChatComposerModelSelection";
import {
  automationModelChoiceForHarness,
  reconcileAutomationModel,
} from "./automationModelOptions";
import { SchedulePicker } from "./AutomationsPaneInlineEditors";

/** How an automation delivers when it fires — mirrors the runtime's
 *  ALLOWED_DELIVERY_CHANNELS. */
export type AutomationDeliveryChannel = "session_run" | "system_notification";

export interface ManualAutomationDraft {
  name: string;
  instruction: string;
  cron: string;
  channel: AutomationDeliveryChannel;
  /** Harness the automation's runs execute under. */
  harness: string;
  /** Project the automation's runs and outputs are delivered into. */
  projectId: string | null;
  /** Model pinned for the automation's runs (persisted as
   *  metadata.selected_model), or null to follow the workspace default. */
  model: string | null;
}

interface ManualAutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace whose installed harnesses populate the agent picker. */
  workspaceId: string | null;
  /** Prefill (e.g. from an example preview); applied when the form mounts. */
  initialDraft?: Partial<ManualAutomationDraft> | null;
  /** Persist the automation. Throws on failure; the dialog keeps itself open so
   *  the user can retry without losing their draft. */
  onCreate: (draft: ManualAutomationDraft) => Promise<void>;
}

const DEFAULT_CRON = "0 9 * * *"; // every day at 09:00

// Sentinel <Select> value for "no pinned model → workspace default" (Select
// can't hold null/empty).
const MODEL_WORKSPACE_DEFAULT = "__workspace_default__";

/**
 * Manual "New automation" builder — name + instruction + schedule + delivery,
 * written straight to a cronjob (no agent round-trip). The "Create with Hola"
 * path handles the conversational alternative.
 */
export function ManualAutomationDialog({
  open,
  onOpenChange,
  workspaceId,
  initialDraft,
  onCreate,
}: ManualAutomationDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[14%] left-1/2 z-[100] w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          {/* Mount the form only while open so every field — including the
              schedule picker's internal state — starts fresh each time. */}
          {open ? (
            <ManualAutomationForm
              workspaceId={workspaceId}
              initialDraft={initialDraft ?? null}
              onCancel={() => onOpenChange(false)}
              onCreate={onCreate}
            />
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ManualAutomationForm({
  workspaceId,
  initialDraft,
  onCancel,
  onCreate,
}: {
  workspaceId: string | null;
  initialDraft: Partial<ManualAutomationDraft> | null;
  onCancel: () => void;
  onCreate: (draft: ManualAutomationDraft) => Promise<void>;
}) {
  const [name, setName] = useState(initialDraft?.name ?? "");
  const [instruction, setInstruction] = useState(
    initialDraft?.instruction ?? "",
  );
  const [cron, setCron] = useState(initialDraft?.cron ?? DEFAULT_CRON);
  const [cronValid, setCronValid] = useState(true);
  // Notification-delivery cron was removed; automations always run the agent
  // on their instruction (session_run).
  const channel: AutomationDeliveryChannel = "session_run";
  const [harness, setHarness] = useState(initialDraft?.harness ?? "pi");
  const [projectId, setProjectId] = useState<string | null>(
    initialDraft?.projectId ?? null,
  );
  const [model, setModel] = useState<string | null>(initialDraft?.model ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { harnesses, isLoading: harnessesLoading } =
    useAvailableHarnesses(workspaceId);
  const { projects } = useWorkspaceProjects(workspaceId);
  const { availableChatModelOptions, runtimeDefaultModelLabel } =
    useChatComposerModelSelection();
  // Models are scoped to the selected agent: pi/Hola uses the runtime catalogue
  // (same as the composer), while CLI harnesses (claude-code, codex) expose only
  // their own namespace. Recomputes whenever the agent changes.
  const modelChoice = automationModelChoiceForHarness({
    harness,
    harnesses,
    chatModelOptions: availableChatModelOptions,
  });
  const workspaceDefaultModelLabel = runtimeDefaultModelLabel
    ? `Workspace default (${runtimeDefaultModelLabel})`
    : "Workspace default";
  // Label for "no explicit pin": pi follows the workspace default; a namespace
  // harness falls back to its own default model.
  const defaultOptionLabel = modelChoice.usesHarnessNamespace
    ? "Default (agent's default model)"
    : workspaceDefaultModelLabel;
  // A pin not in the current agent's list still shows so it isn't hidden.
  const modelNotInCatalog =
    model !== null && !modelChoice.options.some((option) => option.value === model);

  // Switching the agent re-scopes the model list; drop a now-invalid pin to the
  // new agent's default (or workspace default for pi).
  const handleHarnessChange = (nextHarness: string) => {
    setHarness(nextHarness);
    const nextChoice = automationModelChoiceForHarness({
      harness: nextHarness,
      harnesses,
      chatModelOptions: availableChatModelOptions,
    });
    setModel((prev) =>
      reconcileAutomationModel({ model: prev, choice: nextChoice }),
    );
  };

  // Picking a not-ready agent opens Settings → Agents. This dialog is a modal,
  // so leaving it open would block (and occlude) Settings — close it so the
  // user can actually go set the agent up. (Form is remounted fresh next open.)
  const settingsOpen = useAtomValue(settingsOpenAtom);
  useEffect(() => {
    if (settingsOpen) {
      onCancel();
    }
  }, [settingsOpen, onCancel]);

  const canCreate = instruction.trim().length > 0 && cronValid && !submitting;

  const handleCreate = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        instruction: instruction.trim(),
        cron: cron.trim(),
        channel,
        harness,
        projectId,
        model,
      });
      onCancel();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't create the automation.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-5">
      <div className="space-y-1">
        <DialogPrimitive.Title className="text-base font-medium text-foreground">
          New automation
        </DialogPrimitive.Title>
        <p className="text-xs text-muted-foreground">
          Set the task, when it runs, and how it delivers.
        </p>
      </div>

      <Field label="Name">
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Weekly analytics recap"
          className="h-8 text-sm"
        />
      </Field>

      <Field label="Instruction">
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="What should the agent do each time this runs?"
          rows={3}
          className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring dark:bg-input/30"
        />
      </Field>

      <Field label="Schedule">
        <SchedulePicker
          cron={cron}
          onChange={({ cron: next, valid }) => {
            setCron(next);
            setCronValid(valid);
          }}
        />
      </Field>

      <Field label="Agent">
        {/* Shared picker so automations get the same readiness gating as the
            composer: only verified ("ready") agents are selectable; others
            show "Set up" and route to Settings → Agents. Changing the agent
            re-scopes the Model list below. */}
        <HarnessPicker
          value={harness}
          harnesses={harnesses}
          isLoading={harnessesLoading}
          onChange={handleHarnessChange}
          className="h-8 rounded-md border border-input bg-transparent px-2.5 font-normal hover:bg-fg-2"
        />
      </Field>

      <Field label="Model">
        <Select
          items={[
            { value: MODEL_WORKSPACE_DEFAULT, label: defaultOptionLabel },
            ...(modelNotInCatalog && model
              ? [{ value: model, label: displayModelLabel(model) }]
              : []),
            ...modelChoice.options,
          ]}
          value={model ?? MODEL_WORKSPACE_DEFAULT}
          onValueChange={(value) =>
            setModel(value === MODEL_WORKSPACE_DEFAULT ? null : value)
          }
        >
          <SelectTrigger className="h-8 w-full bg-transparent text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" className="min-w-55">
            <SelectItem value={MODEL_WORKSPACE_DEFAULT}>
              {defaultOptionLabel}
            </SelectItem>
            {modelNotInCatalog && model ? (
              <SelectItem value={model}>{displayModelLabel(model)}</SelectItem>
            ) : null}
            {modelChoice.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-4 text-muted-foreground">
          Follows the agent's default unless you pin a specific model. The list
          changes with the selected agent.
        </p>
      </Field>

      {projects.length > 0 ? (
        <Field label="Project">
          <Select
            items={[
              { value: "none", label: "No project" },
              ...projects.map((project) => ({
                value: project.project_id,
                label: project.name,
              })),
            ]}
            value={projectId ?? "none"}
            onValueChange={(value) =>
              setProjectId(value === "none" ? null : value)
            }
          >
            <SelectTrigger className="h-8 w-full bg-transparent text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-55">
              <SelectItem value="none">No project</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.project_id} value={project.project_id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Runs happen inside the project and their output is saved there.
          </p>
        </Field>
      ) : null}

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleCreate()}
          disabled={!canCreate}
        >
          {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Create automation
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
