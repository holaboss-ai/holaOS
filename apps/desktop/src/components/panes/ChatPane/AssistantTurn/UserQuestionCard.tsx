import { useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  LoaderCircle,
  Sparkles,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import type {
  ActiveUserQuestion,
  ActiveUserQuestionAnswer,
  ActiveUserQuestionItem,
} from "../userQuestion";
import { recommendedOption } from "../userQuestion";

interface QuestionSelection {
  optionId: string | null;
  freeform: string;
  notes: string;
}

interface UserQuestionCardProps {
  question: ActiveUserQuestion;
  onSubmit: (answers: ActiveUserQuestionAnswer[]) => Promise<void>;
  disabled?: boolean;
}

function initialSelections(
  question: ActiveUserQuestion,
): Record<string, QuestionSelection> {
  const next: Record<string, QuestionSelection> = {};
  for (const item of question.questions) {
    // Prefill the recommended option; if the agent marked none, fall back to
    // the first option so the card is always pre-answered (confirm, not fill).
    // Only a question with no options at all stays blank (freeform-required).
    next[item.id] = {
      optionId: recommendedOption(item)?.id ?? item.options[0]?.id ?? null,
      freeform: "",
      notes: "",
    };
  }
  return next;
}

function isFilled(
  item: ActiveUserQuestionItem,
  selection: QuestionSelection,
): boolean {
  if (selection.optionId) {
    return item.options.some((entry) => entry.id === selection.optionId);
  }
  return selection.freeform.trim().length > 0;
}

export function UserQuestionCard({
  question,
  onSubmit,
  disabled = false,
}: UserQuestionCardProps) {
  const [selections, setSelections] = useState<
    Record<string, QuestionSelection>
  >(() => initialSelections(question));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(() => {
    // Open on the first question the agent couldn't prefill, so a required
    // pick is what the user sees first; otherwise start at the top.
    const firstUnfilled = question.questions.findIndex(
      (item) => !isFilled(item, initialSelections(question)[item.id]),
    );
    return firstUnfilled >= 0 ? firstUnfilled : 0;
  });

  const total = question.questions.length;
  const current = question.questions[index];
  const selection = selections[current.id];

  const update = (patch: Partial<QuestionSelection>) => {
    setSelections((currentState) => ({
      ...currentState,
      [current.id]: { ...currentState[current.id], ...patch },
    }));
  };

  const remaining = useMemo(
    () =>
      question.questions.filter((item) => !isFilled(item, selections[item.id]))
        .length,
    [question.questions, selections],
  );

  const handleSubmit = async () => {
    if (remaining > 0 || submitting || disabled) {
      return;
    }
    const answers: ActiveUserQuestionAnswer[] = [];
    for (const item of question.questions) {
      const entry = selections[item.id];
      const notes = item.allowNotes ? entry.notes.trim() : "";
      if (entry.optionId) {
        answers.push({
          question_id: item.id,
          option_id: entry.optionId,
          notes: notes || null,
        });
        continue;
      }
      const freeform = entry.freeform.trim();
      if (freeform) {
        answers.push({
          question_id: item.id,
          response_text: freeform,
          notes: notes || null,
        });
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(answers);
    } catch (submitError) {
      setSubmitting(false);
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Couldn't submit — please try again",
      );
    }
  };

  const label = current.title ?? current.prompt;

  return (
    <div className="mt-1 w-full max-w-[440px] overflow-hidden rounded-xl border border-border bg-card text-left">
      <div className="flex items-center gap-2 px-3.5 pt-2.5">
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <div className="truncate text-xs font-medium text-muted-foreground">
          {question.title ?? "Let's align before we start"}
        </div>
      </div>

      <div className="px-3.5 py-2.5">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {current.prompt !== label ? (
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {current.prompt}
          </div>
        ) : null}

        <div className="mt-2 flex flex-col gap-1">
          {current.options.map((option) => {
            const selected = selection.optionId === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() =>
                  update({ optionId: option.id, freeform: "" })
                }
                className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                  selected
                    ? "border-primary/40 bg-primary/[0.06]"
                    : "border-transparent hover:bg-accent"
                }`}
              >
                {selected ? (
                  <CircleDot className="mt-0.5 size-3.5 shrink-0 text-primary" />
                ) : (
                  <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] text-foreground">
                      {option.label}
                    </span>
                    {option.recommended ? (
                      <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                        Recommended
                      </span>
                    ) : null}
                  </div>
                  {option.description ? (
                    <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {option.description}
                    </div>
                  ) : null}
                </div>
              </button>
            );
          })}
          {current.allowFreeform ? (
            <input
              type="text"
              value={selection.freeform}
              onChange={(event) =>
                update({ freeform: event.target.value, optionId: null })
              }
              placeholder={current.freeformPlaceholder ?? "Or write your own…"}
              className="mt-0.5 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
            />
          ) : null}
          {current.allowNotes ? (
            <input
              type="text"
              value={selection.notes}
              onChange={(event) => update({ notes: event.target.value })}
              placeholder={current.notesPlaceholder ?? "Add a note (optional)"}
              className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
            />
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
        {total > 1 ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
              disabled={index === 0}
              aria-label="Previous question"
              className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <div className="flex items-center gap-1 px-0.5">
              {question.questions.map((item, dotIndex) => {
                const filled = isFilled(item, selections[item.id]);
                const isCurrent = dotIndex === index;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setIndex(dotIndex)}
                    aria-label={`Question ${dotIndex + 1}`}
                    className={`size-1.5 rounded-full transition-colors ${
                      isCurrent
                        ? "bg-primary"
                        : filled
                          ? "bg-muted-foreground"
                          : "bg-border"
                    }`}
                  />
                );
              })}
            </div>
            <button
              type="button"
              onClick={() =>
                setIndex((value) => Math.min(total - 1, value + 1))
              }
              disabled={index === total - 1}
              aria-label="Next question"
              className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {error ? <span className="text-destructive">{error}</span> : null}
          </span>
        )}

        <Button
          type="button"
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={remaining > 0 || submitting || disabled}
        >
          {submitting ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : remaining === 0 ? (
            <ArrowRight className="size-3.5" />
          ) : null}
          {remaining > 0 ? `${remaining} more to go` : "Sounds good, start"}
        </Button>
      </div>

      {total > 1 && error ? (
        <div className="border-t border-border px-3.5 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
