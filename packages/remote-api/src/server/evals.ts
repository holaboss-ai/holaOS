import { os } from "./base";
import { EvalsServiceError, type EvalsServiceErrorCode } from "./context";

type ErrorFactories = Partial<Record<EvalsServiceErrorCode, (options?: { message?: string }) => Error>>;

async function mapEvalsErrors<T>(run: () => T | Promise<T>, errors: ErrorFactories): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EvalsServiceError) {
      const factory = errors[error.code];
      if (factory) {
        throw factory({ message: error.message });
      }
    }
    throw error;
  }
}

const list = os.evals.list.handler(({ input, context }) => context.evals.list(input));

const targets = os.evals.targets.handler(({ input, context }) => context.evals.targets(input));

const create = os.evals.create.handler(({ input, context }) => context.evals.create(input));

const get = os.evals.get.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.get(input), errors),
);

const update = os.evals.update.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.update(input), errors),
);

const setPlan = os.evals.setPlan.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.setPlan(input), errors),
);

const start = os.evals.start.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.start(input), errors),
);

const cancel = os.evals.cancel.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.cancel(input), errors),
);

const retryRun = os.evals.retryRun.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.retryRun(input), errors),
);

const decideProposal = os.evals.decideProposal.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.decideProposal(input), errors),
);

const saveOpinion = os.evals.saveOpinion.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.saveOpinion(input), errors),
);

const report = os.evals.report.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.report(input), errors),
);

const exportReport = os.evals.exportReport.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.exportReport(input), errors),
);

const publish = os.evals.publish.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.publish(input), errors),
);

const setReportUrl = os.evals.setReportUrl.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.setReportUrl(input), errors),
);

const saveDistribution = os.evals.saveDistribution.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.saveDistribution(input), errors),
);

const createVersion = os.evals.createVersion.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.createVersion(input), errors),
);

const importReproduction = os.evals.importReproduction.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.importReproduction(input), errors),
);

const del = os.evals.delete.handler(({ input, context, errors }) =>
  mapEvalsErrors(() => context.evals.delete(input), errors),
);

export const evalsRouter = {
  list,
  get,
  targets,
  create,
  update,
  setPlan,
  start,
  cancel,
  retryRun,
  decideProposal,
  saveOpinion,
  report,
  exportReport,
  publish,
  setReportUrl,
  saveDistribution,
  createVersion,
  importReproduction,
  delete: del,
};
