import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { EvalTargetOption } from "@holaboss/remote-api/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtom, useSetAtom } from "jotai";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { overlayOpenCountAtom } from "@/components/layout/shell/overlay-presence";
import { notifyMainSessionsChanged } from "@/components/layout/shell/useWorkspaceLists";
import { Button } from "@/components/ui/button";
import { Loader2, RotateCw } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChatComposerModelSelection } from "@/lib/chat/useChatComposerModelSelection";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";
import { useEvaluationTargets } from "./data";
import {
  errorMessage,
  QUESTION_TYPE_OPTIONS,
  type QuestionType,
  targetDetail,
  targetKey,
  toEvalTarget,
} from "./format";
import { newEvaluationDialogOpenAtom } from "./state";
import { useOpenEvaluation } from "./useOpenEvaluation";

export function NewEvaluationDialog() {
  const [open, setOpen] = useAtom(newEvaluationDialogOpenAtom);
  const setOverlayCount = useSetAtom(overlayOpenCountAtom);

  useEffect(() => {
    if (!open) {
      return;
    }
    setOverlayCount((count) => count + 1);
    return () => setOverlayCount((count) => Math.max(0, count - 1));
  }, [open, setOverlayCount]);

  return (
    <DialogPrimitive.Root onOpenChange={setOpen} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[10%] left-1/2 z-[100] w-[520px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          {open ? <NewEvaluationForm onClose={() => setOpen(false)} /> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const BRAIN_DEFAULT = "__default__";

function NewEvaluationForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const openEvaluation = useOpenEvaluation();
  const targetsQuery = useEvaluationTargets();
  const targets = targetsQuery.data?.targets ?? [];
  const {
    availableChatModelOptionGroups,
    availableChatModelOptions,
    resolvedChatModel,
  } = useChatComposerModelSelection();

  const [questionType, setQuestionType] =
    useState<QuestionType>("single_model");
  const [question, setQuestion] = useState("");
  const [title, setTitle] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [brainModel, setBrainModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const multi = questionType === "comparison";
  const requiredTargets = multi ? 2 : 1;
  const effectiveBrainModel = brainModel ?? (resolvedChatModel || null);

  useEffect(() => {
    if (!multi) {
      setSelectedKeys((prev) => prev.slice(0, 1));
    }
  }, [multi]);

  useEffect(() => {
    if (targets.length === 1 && selectedKeys.length === 0) {
      setSelectedKeys([targetKey(targets[0])]);
    }
  }, [selectedKeys.length, targets]);

  const selectedTargets = useMemo(
    () =>
      selectedKeys
        .map((key) => targets.find((target) => targetKey(target) === key))
        .filter((target): target is EvalTargetOption => Boolean(target)),
    [selectedKeys, targets],
  );

  const createMutation = useMutation(
    remoteApiQuery.evals.create.mutationOptions({
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: remoteApiQuery.evals.list.key(),
        });
        notifyMainSessionsChanged();
        onClose();
        openEvaluation(created);
        if (created.kickoff_error) {
          toast.error("The agent couldn't start planning", {
            description: `${created.kickoff_error} Ask in the chat, or set up the plan manually.`,
          });
        }
      },
      onError: (cause) => {
        setError(errorMessage(cause, "Couldn't create the evaluation."));
      },
    }),
  );

  const toggleTarget = (key: string) => {
    setSelectedKeys((prev) => {
      if (!multi) {
        return [key];
      }
      return prev.includes(key)
        ? prev.filter((entry) => entry !== key)
        : [...prev, key];
    });
  };

  const typeOption =
    QUESTION_TYPE_OPTIONS.find((option) => option.value === questionType) ??
    QUESTION_TYPE_OPTIONS[0];
  const canCreate =
    question.trim().length > 0 &&
    selectedTargets.length >= requiredTargets &&
    (multi || selectedTargets.length === 1) &&
    !createMutation.isPending;

  const submit = () => {
    if (!canCreate) {
      return;
    }
    setError(null);
    createMutation.mutate({
      title: title.trim() || null,
      questionType,
      question: question.trim(),
      brainModel: effectiveBrainModel,
      targets: selectedTargets.map(toEvalTarget),
    });
  };

  const header = (
    <div className="space-y-1">
      <DialogPrimitive.Title className="font-medium text-base text-foreground">
        New evaluation
      </DialogPrimitive.Title>
      <p className="text-muted-foreground text-xs">
        One question about a model running on this machine. The agent drafts a
        test plan for you to check before anything runs.
      </p>
    </div>
  );

  if (targetsQuery.isPending) {
    return (
      <div className="flex flex-col gap-4 p-5">
        {header}
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="size-3.5 animate-spin" />
          Looking for local model servers…
        </div>
      </div>
    );
  }

  if (targets.length === 0) {
    return (
      <div className="flex flex-col gap-4 p-5">
        {header}
        <div className="rounded-lg border border-border bg-fg-2 px-3 py-3 text-[13px] text-muted-foreground leading-5">
          {targetsQuery.isError
            ? `Couldn't check for local models: ${errorMessage(targetsQuery.error)}`
            : "No local model is running. holaOS finds llama.cpp, Ollama, LM Studio and vLLM servers on this machine automatically. Start one with a model loaded, then check again."}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={targetsQuery.isFetching}
            onClick={() => void targetsQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            <RotateCw
              className={cn(
                "size-3.5",
                targetsQuery.isFetching && "animate-spin",
              )}
            />
            Check again
          </Button>
        </div>
      </div>
    );
  }

  const brainItems = [
    ...(availableChatModelOptions.length === 0
      ? [{ value: BRAIN_DEFAULT, label: "Default model" }]
      : []),
    ...availableChatModelOptions.map((option) => ({
      value: option.value,
      label: option.selectedLabel ?? option.label,
    })),
  ];

  return (
    <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-5">
      {header}

      <Field label="Question type">
        <div className="grid gap-1.5" role="radiogroup">
          {QUESTION_TYPE_OPTIONS.map((option) => {
            const selected = option.value === questionType;
            return (
              <button
                aria-checked={selected}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                  selected
                    ? "border-primary/40 bg-primary/6"
                    : "border-border hover:bg-fg-4",
                )}
                key={option.value}
                onClick={() => setQuestionType(option.value)}
                role="radio"
                type="button"
              >
                <span className="font-medium text-foreground text-sm">
                  {option.label}
                </span>
                <span className="text-muted-foreground text-xs">
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Question">
        <textarea
          autoFocus
          className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-foreground text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring dark:bg-input/30"
          maxLength={2000}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={typeOption.placeholder}
          rows={3}
          value={question}
        />
      </Field>

      <Field
        hint={
          multi
            ? targets.length < 2
              ? "A comparison needs two or more running models, and only one is running now."
              : "Pick at least two."
            : selectedTargets.length === 0
              ? "Pick one."
              : undefined
        }
        label={multi ? "Models to compare" : "Model"}
      >
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {targets.map((target) => {
            const key = targetKey(target);
            const checked = selectedKeys.includes(key);
            return (
              <label
                className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-fg-2"
                key={key}
              >
                <input
                  checked={checked}
                  className="size-4 shrink-0 accent-primary"
                  name="evaluation-target"
                  onChange={() => toggleTarget(key)}
                  type={multi ? "checkbox" : "radio"}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-foreground text-sm">
                    {target.model_id}
                  </span>
                  <span className="truncate text-muted-foreground text-xs">
                    {targetDetail(target)}
                    {target.context_window
                      ? ` · ${Math.round(target.context_window / 1024)}k context`
                      : ""}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </Field>

      <Field
        hint="Plans the tests and drafts the write-up. The tests themselves run on the local model."
        label="Analyst model"
      >
        {availableChatModelOptions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Uses your default chat model.
          </p>
        ) : (
          <Select
            items={brainItems}
            onValueChange={(value) =>
              setBrainModel(
                typeof value === "string" && value !== BRAIN_DEFAULT
                  ? value
                  : null,
              )
            }
            value={effectiveBrainModel ?? BRAIN_DEFAULT}
          >
            <SelectTrigger className="h-8 w-full bg-transparent text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-55">
              {availableChatModelOptionGroups.length > 0
                ? availableChatModelOptionGroups.map((group) => (
                    <SelectGroup key={group.label}>
                      <SelectLabel>{group.label}</SelectLabel>
                      {group.options
                        .filter((option) => !option.disabled)
                        .map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  ))
                : availableChatModelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      <Field label="Title (optional)">
        <Input
          className="h-8 text-sm"
          maxLength={160}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Uses the question if left empty"
          value={title}
        />
      </Field>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          disabled={createMutation.isPending}
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button disabled={!canCreate} onClick={submit} size="sm" type="button">
          {createMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          Create evaluation
        </Button>
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      {children}
      {hint ? (
        <p className="text-[11px] text-muted-foreground leading-4">{hint}</p>
      ) : null}
    </div>
  );
}
