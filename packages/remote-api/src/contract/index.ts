import type {
  InferContractRouterInputs,
  InferContractRouterOutputs,
} from "@orpc/contract";
import { benchContract } from "./bench";
import { capabilitiesContract } from "./capabilities";
import { channelsContract } from "./channels";
import { cronjobsContract } from "./cronjobs";
import { evalsContract } from "./evals";
import { memoryContract } from "./memory";
import { notificationsContract } from "./notifications";
import { outputsContract } from "./outputs";
import { skillsContract } from "./skills";

export const remoteApiContract = {
  memory: memoryContract,
  outputs: outputsContract,
  notifications: notificationsContract,
  cronjobs: cronjobsContract,
  capabilities: capabilitiesContract,
  skills: skillsContract,
  channels: channelsContract,
  evals: evalsContract,
  bench: benchContract,
};

export type RemoteApiContract = typeof remoteApiContract;

export type RemoteApiInputs = InferContractRouterInputs<RemoteApiContract>;
export type RemoteApiOutputs = InferContractRouterOutputs<RemoteApiContract>;

export * from "./shared";
export type { OutputRecord } from "./outputs";
export type { NotificationRecord } from "./notifications";
export type { CronjobRecord } from "./cronjobs";
export type { CapabilityCatalogEntry, WorkspaceCapability } from "./capabilities";
export type { ChannelConnection } from "./channels";
export { BENCH_RUN_PHASES, BENCH_RUN_STATUSES, benchSubjectSchema } from "./bench";
export type { BenchEvent, BenchRun, BenchRunSummary, BenchSubject } from "./bench";
export {
  EVAL_AGENT_CONDITIONS,
  EVAL_QUESTION_TYPES,
  EVAL_RUN_KINDS,
  evalPlanRunSchema,
  evalPlanSchema,
  evalTargetSchema,
} from "./evals";
export type {
  EvalPlan,
  EvalPlanRun,
  EvalReport,
  EvalTarget,
  EvalTargetOption,
  Evaluation,
  EvaluationProposal,
  EvaluationRun,
} from "./evals";
