import { atom } from "jotai";

export const newEvaluationDialogOpenAtom = atom(false);

export type EvaluationSection =
  | "plan"
  | "runs"
  | "findings"
  | "report"
  | "distribute";

export const evaluationSectionByIdAtom = atom<
  Record<string, EvaluationSection>
>({});
