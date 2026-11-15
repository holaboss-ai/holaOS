import {
  EVAL_AGENT_CONDITIONS,
  EVAL_RUN_KINDS,
  type EvalPlan,
  type EvalPlanRun,
  type EvalTargetOption,
} from "@holaboss/remote-api/contract";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  Loader2,
  MessageSquareText,
  Play,
  Plus,
  X,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";
import { useEvaluationTargets, useInvalidateEvaluation } from "./data";
import { useServerDraft } from "./draft";
import {
  AGENT_CONDITION_LABELS,
  type EvaluationDetail,
  errorMessage,
  formatMinutes,
  pluralize,
  RUN_KIND_LABELS,
  readTarget,
  targetDetail,
  targetKey,
  toEvalTarget,
} from "./format";
import { Callout, Panel, ToggleChip } from "./parts";

const EMPTY_PLAN: EvalPlan = { runs: [], estimate_minutes: null, notes: null };
const MAX_RUNS = 12;
const RUN_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

type RunKind = (typeof EVAL_RUN_KINDS)[number];
type AgentCondition = (typeof EVAL_AGENT_CONDITIONS)[number];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function uniqueKey(seed: string, taken: Set<string>): string {
  const base = slugify(seed) || "run";
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    const tail = `-${suffix}`;
    candidate = `${base.slice(0, 40 - tail.length)}${tail}`;
    suffix += 1;
  }
  return candidate;
}

function resolveKeys(runs: EvalPlanRun[]): EvalPlanRun[] {
  const taken = new Set(
    runs.map((run) => run.key.trim()).filter((key) => key.length > 0),
  );
  return runs.map((run) => {
    if (run.key.trim()) {
      return { ...run, key: run.key.trim() };
    }
    const key = uniqueKey(run.label, taken);
    taken.add(key);
    return { ...run, key };
  });
}

function validatePlan(plan: EvalPlan): string[] {
  const problems: string[] = [];
  if (plan.runs.length === 0) {
    problems.push("Add at least one run.");
  }
  if (plan.runs.length > MAX_RUNS) {
    problems.push(`A plan can have at most ${MAX_RUNS} runs.`);
  }
  const resolved = resolveKeys(plan.runs);
  const seen = new Set<string>();
  resolved.forEach((run, index) => {
    const name = run.label.trim() || `Run ${index + 1}`;
    if (!run.label.trim()) {
      problems.push(`Run ${index + 1} needs a name.`);
    }
    if (!run.target?.model_id) {
      problems.push(`${name} needs a model.`);
    }
    if (run.kinds.length === 0) {
      problems.push(`${name} needs at least one test.`);
    }
    if (!RUN_KEY_PATTERN.test(run.key)) {
      problems.push(
        `${name}: the key can only use lowercase letters, digits and dashes.`,
      );
    } else if (seen.has(run.key)) {
      problems.push(`Two runs use the key "${run.key}".`);
    }
    seen.add(run.key);
  });
  return problems;
}

export function PlanSection({
  detail,
  onStarted,
}: {
  detail: EvaluationDetail;
  onStarted: () => void;
}) {
  const evaluation = detail.evaluation;
  const evalId = evaluation.eval_id;
  const editable =
    evaluation.status === "draft" || evaluation.status === "planned";
  const serverPlan = evaluation.plan ?? EMPTY_PLAN;
  const { draft, setDraft, dirty, discard, markSaved, changedWhileEditing } =
    useServerDraft<EvalPlan>(serverPlan);
  const invalidate = useInvalidateEvaluation(evalId);
  const targetsQuery = useEvaluationTargets(editable);
  const targets = targetsQuery.data?.targets ?? [];
  const problems = useMemo(() => validatePlan(draft), [draft]);

  const setPlanMutation = useMutation(
    remoteApiQuery.evals.setPlan.mutationOptions(),
  );
  const startMutation = useMutation(remoteApiQuery.evals.start.mutationOptions());
  const busy = setPlanMutation.isPending || startMutation.isPending;

  const savePlan = async (): Promise<boolean> => {
    const plan: EvalPlan = { ...draft, runs: resolveKeys(draft.runs) };
    try {
      const updated = await setPlanMutation.mutateAsync({ evalId, plan });
      markSaved(updated.plan ?? plan);
      await invalidate({ evaluation: updated });
      return true;
    } catch (cause) {
      toast.error(errorMessage(cause, "Couldn't save the plan."));
      return false;
    }
  };

  const startEvaluation = async () => {
    if (dirty && !(await savePlan())) {
      return;
    }
    try {
      const started = await startMutation.mutateAsync({ evalId });
      await invalidate({ detail: started });
      onStarted();
    } catch (cause) {
      toast.error(errorMessage(cause, "Couldn't start the evaluation."));
    }
  };

  const updateRun = (index: number, patch: Partial<EvalPlanRun>) => {
    setDraft((prev) => ({
      ...prev,
      runs: prev.runs.map((run, i) => (i === index ? { ...run, ...patch } : run)),
    }));
  };

  const removeRun = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      runs: prev.runs.filter((_, i) => i !== index),
    }));
  };

  const addRun = () => {
    setDraft((prev) => {
      const last = prev.runs[prev.runs.length - 1];
      const requested = Array.isArray(evaluation.targets)
        ? readTarget(evaluation.targets[0])
        : null;
      const fallbackTarget = targets[0] ? toEvalTarget(targets[0]) : null;
      const target = last?.target ?? requested ?? fallbackTarget;
      if (!target) {
        return prev;
      }
      const next: EvalPlanRun = {
        key: "",
        label: "",
        target,
        kinds: last?.kinds?.length ? [...last.kinds] : [...EVAL_RUN_KINDS],
        sampling: last?.sampling ?? null,
        samples: last?.samples ?? null,
        agent_conditions: last?.agent_conditions ?? null,
        notes: null,
      };
      return { ...prev, runs: [...prev.runs, next] };
    });
  };

  const canAdd =
    draft.runs.length < MAX_RUNS &&
    (draft.runs.length > 0 || targets.length > 0);
  const isEmpty = serverPlan.runs.length === 0 && draft.runs.length === 0;

  if (isEmpty) {
    return (
      <div className="flex flex-col gap-3">
        {editable ? (
          <Callout
            action={
              <Button
                disabled={!canAdd}
                onClick={addRun}
                size="sm"
                type="button"
                variant="ghost"
              >
                Set up manually
              </Button>
            }
            icon={<MessageSquareText />}
          >
            The agent is drafting a test plan in the chat on the right. It
            shows up here when it's ready, and you can ask for changes there.
          </Callout>
        ) : (
          <Callout icon={<AlertTriangle />}>
            This evaluation has no test plan.
          </Callout>
        )}
      </div>
    );
  }

  const estimate = formatMinutes(draft.estimate_minutes);

  return (
    <div className="flex flex-col gap-3">
      {changedWhileEditing ? (
        <Callout
          action={
            <Button onClick={discard} size="sm" type="button" variant="ghost">
              Discard my edits
            </Button>
          }
          tone="warning"
        >
          The agent changed the plan while you were editing it.
        </Callout>
      ) : null}

      <Panel
        actions={
          estimate ? (
            <span className="text-muted-foreground text-xs">
              Estimated time: {estimate}
            </span>
          ) : null
        }
        description={
          editable
            ? "Each run tests one model with one setup. Edit it here or ask the agent in the chat."
            : "The plan can't change once the evaluation has started."
        }
        title="Test plan"
      >
        {draft.notes?.trim() ? (
          <p className="mb-3 whitespace-pre-wrap text-muted-foreground text-xs leading-5">
            {draft.notes.trim()}
          </p>
        ) : null}
        <ol className="-mx-4 divide-y divide-border border-border border-y">
          {draft.runs.map((run, index) =>
            editable ? (
              <EditableRunRow
                disabled={busy}
                index={index}
                key={index}
                onChange={(patch) => updateRun(index, patch)}
                onRemove={() => removeRun(index)}
                placeholderKey={resolveKeys(draft.runs)[index]?.key ?? ""}
                run={run}
                targets={targets}
              />
            ) : (
              <ReadOnlyRunRow key={`${run.key}-${index}`} run={run} />
            ),
          )}
        </ol>
        {editable ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              disabled={!canAdd || busy}
              onClick={addRun}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Plus className="size-3.5" />
              Add run
            </Button>
            <div className="flex-1" />
            {dirty ? (
              <Button
                disabled={busy}
                onClick={discard}
                size="sm"
                type="button"
                variant="ghost"
              >
                Discard
              </Button>
            ) : null}
            <Button
              disabled={!dirty || busy || problems.length > 0}
              onClick={() => void savePlan()}
              size="sm"
              type="button"
              variant="outline"
            >
              {setPlanMutation.isPending && !startMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              Save plan
            </Button>
            <Button
              disabled={busy || problems.length > 0}
              onClick={() => void startEvaluation()}
              size="sm"
              type="button"
            >
              {startMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              Start evaluation
            </Button>
          </div>
        ) : null}
        {editable && problems.length > 0 && draft.runs.length > 0 ? (
          <ul className="mt-2 space-y-0.5 text-[11px] text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}

function EditableRunRow({
  run,
  index,
  targets,
  placeholderKey,
  disabled,
  onChange,
  onRemove,
}: {
  run: EvalPlanRun;
  index: number;
  targets: EvalTargetOption[];
  placeholderKey: string;
  disabled: boolean;
  onChange: (patch: Partial<EvalPlanRun>) => void;
  onRemove: () => void;
}) {
  const kinds = run.kinds as RunKind[];
  const conditions = (run.agent_conditions ?? []) as AgentCondition[];
  const hasAgent = kinds.includes("agent");
  const currentKey = run.target ? targetKey(run.target) : "";
  const targetMissing =
    Boolean(run.target) &&
    !targets.some((target) => targetKey(target) === currentKey);
  const targetItems = [
    ...(targetMissing && run.target
      ? [{ value: currentKey, label: `${run.target.model_id} (not running)` }]
      : []),
    ...targets.map((target) => ({
      value: targetKey(target),
      label: target.model_id,
    })),
  ];

  const toggleKind = (kind: RunKind) => {
    const next = kinds.includes(kind)
      ? kinds.filter((entry) => entry !== kind)
      : EVAL_RUN_KINDS.filter((entry) => entry === kind || kinds.includes(entry));
    onChange({
      kinds: next,
      agent_conditions: next.includes("agent")
        ? conditions.length > 0
          ? conditions
          : ["full"]
        : null,
    });
  };

  const toggleCondition = (condition: AgentCondition) => {
    const next = conditions.includes(condition)
      ? conditions.filter((entry) => entry !== condition)
      : EVAL_AGENT_CONDITIONS.filter(
          (entry) => entry === condition || conditions.includes(entry),
        );
    onChange({ agent_conditions: next.length > 0 ? next : null });
  };

  const setSampling = (patch: { temperature?: number | null; top_p?: number | null }) => {
    const sampling = { ...(run.sampling ?? {}), ...patch };
    const empty =
      sampling.temperature == null &&
      sampling.top_p == null &&
      sampling.min_p == null;
    onChange({ sampling: empty ? null : sampling });
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="w-5 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
          {index + 1}
        </span>
        <Input
          aria-label="Run name"
          className="h-7 min-w-0 flex-1 text-sm"
          disabled={disabled}
          maxLength={80}
          onChange={(event) => onChange({ label: event.target.value })}
          placeholder="Name, e.g. Q4, full tools"
          value={run.label}
        />
        <Input
          aria-label="Run key"
          className="h-7 w-28 shrink-0 font-mono text-xs"
          disabled={disabled}
          maxLength={40}
          onChange={(event) =>
            onChange({ key: event.target.value.toLowerCase() })
          }
          placeholder={placeholderKey || "key"}
          title="Used to cite this run's numbers in the write-up"
          value={run.key}
        />
        <Button
          aria-label="Remove run"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          disabled={disabled}
          onClick={onRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-7">
        <Select
          disabled={disabled}
          items={targetItems}
          onValueChange={(value) => {
            const picked = targets.find((target) => targetKey(target) === value);
            if (picked) {
              onChange({ target: toEvalTarget(picked) });
            }
          }}
          value={currentKey || null}
        >
          <SelectTrigger
            aria-label="Model"
            className="h-7 max-w-64 min-w-40 bg-transparent text-xs"
            size="sm"
          >
            <SelectValue placeholder="Pick a model" />
          </SelectTrigger>
          <SelectContent align="start" className="min-w-55">
            {targetMissing && run.target ? (
              <SelectItem disabled value={currentKey}>
                {run.target.model_id} (not running)
              </SelectItem>
            ) : null}
            {targets.map((target) => (
              <SelectItem key={targetKey(target)} value={targetKey(target)}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{target.model_id}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {targetDetail(target)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <LabeledGroup label="Tests">
          {EVAL_RUN_KINDS.map((kind) => (
            <ToggleChip
              disabled={disabled}
              key={kind}
              onClick={() => toggleKind(kind)}
              pressed={kinds.includes(kind)}
            >
              {RUN_KIND_LABELS[kind] ?? kind}
            </ToggleChip>
          ))}
        </LabeledGroup>
        {hasAgent ? (
          <LabeledGroup label="Agent tools">
            {EVAL_AGENT_CONDITIONS.map((condition) => (
              <ToggleChip
                disabled={disabled}
                key={condition}
                onClick={() => toggleCondition(condition)}
                pressed={conditions.includes(condition)}
              >
                {AGENT_CONDITION_LABELS[condition] ?? condition}
              </ToggleChip>
            ))}
          </LabeledGroup>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-7">
        <LabeledGroup label="Samples">
          <NumberField
            ariaLabel="Samples"
            disabled={disabled}
            integer
            max={10}
            min={1}
            onChange={(value) => onChange({ samples: value })}
            placeholder="3"
            value={run.samples ?? null}
          />
        </LabeledGroup>
        <LabeledGroup label="Temperature">
          <NumberField
            ariaLabel="Temperature"
            disabled={disabled}
            max={2}
            min={0}
            onChange={(value) => setSampling({ temperature: value })}
            placeholder="default"
            value={run.sampling?.temperature ?? null}
          />
        </LabeledGroup>
        <LabeledGroup label="Top-p">
          <NumberField
            ariaLabel="Top-p"
            disabled={disabled}
            max={1}
            min={0}
            onChange={(value) => setSampling({ top_p: value })}
            placeholder="default"
            value={run.sampling?.top_p ?? null}
          />
        </LabeledGroup>
      </div>
      {run.notes?.trim() ? (
        <p className="pl-7 text-muted-foreground text-xs leading-5">
          {run.notes.trim()}
        </p>
      ) : null}
    </li>
  );
}

function ReadOnlyRunRow({ run }: { run: EvalPlanRun }) {
  const parts: string[] = [
    run.kinds.map((kind) => RUN_KIND_LABELS[kind] ?? kind).join(", "),
  ];
  if (run.kinds.includes("agent") && run.agent_conditions?.length) {
    parts.push(
      run.agent_conditions
        .map((condition) => AGENT_CONDITION_LABELS[condition] ?? condition)
        .join(" + "),
    );
  }
  if (run.samples) {
    parts.push(pluralize(run.samples, "sample"));
  }
  if (run.sampling?.temperature != null) {
    parts.push(`temp ${run.sampling.temperature}`);
  }
  if (run.sampling?.top_p != null) {
    parts.push(`top-p ${run.sampling.top_p}`);
  }
  return (
    <li className="flex flex-col gap-0.5 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-foreground text-sm">
          {run.label}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {run.key}
        </span>
        <span className="ml-auto truncate text-muted-foreground text-xs">
          {run.target.model_id}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{parts.join(" · ")}</p>
    </li>
  );
}

function LabeledGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function NumberField({
  value,
  onChange,
  min,
  max,
  integer,
  placeholder,
  disabled,
  ariaLabel,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  min: number;
  max: number;
  integer?: boolean;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(value == null ? "" : String(value));
    }
  }, [value]);

  const parsed = text.trim() === "" ? null : Number(text);
  const invalid =
    parsed !== null &&
    (!Number.isFinite(parsed) ||
      parsed < min ||
      parsed > max ||
      (integer && !Number.isInteger(parsed)));

  return (
    <input
      aria-invalid={invalid}
      aria-label={ariaLabel}
      className={cn(
        "h-6 w-16 rounded-md border border-input bg-transparent px-1.5 text-xs tabular-nums outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring disabled:opacity-50 dark:bg-input/30",
        invalid && "border-destructive",
      )}
      disabled={disabled}
      inputMode="decimal"
      onBlur={() => {
        focusedRef.current = false;
        setText(value == null ? "" : String(value));
      }}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const nextParsed = next.trim() === "" ? null : Number(next);
        if (nextParsed === null) {
          onChange(null);
          return;
        }
        if (
          Number.isFinite(nextParsed) &&
          nextParsed >= min &&
          nextParsed <= max &&
          (!integer || Number.isInteger(nextParsed))
        ) {
          onChange(nextParsed);
        }
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      placeholder={placeholder}
      value={text}
    />
  );
}
