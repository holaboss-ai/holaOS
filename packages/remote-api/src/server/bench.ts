import { os } from "./base";
import { BenchServiceError, type BenchServiceErrorCode } from "./context";

type ErrorFactories = Partial<Record<BenchServiceErrorCode, (options?: { message?: string }) => Error>>;

async function mapBenchErrors<T>(run: () => T | Promise<T>, errors: ErrorFactories): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BenchServiceError) {
      const factory = errors[error.code];
      if (factory) {
        throw factory({ message: error.message });
      }
    }
    throw error;
  }
}

const start = os.bench.start.handler(({ input, context, errors }) =>
  mapBenchErrors(() => context.bench.start(input), errors),
);

const get = os.bench.get.handler(({ input, context, errors }) =>
  mapBenchErrors(() => context.bench.get(input), errors),
);

const current = os.bench.current.handler(({ input, context }) => context.bench.current(input));

const cancel = os.bench.cancel.handler(({ input, context, errors }) =>
  mapBenchErrors(() => context.bench.cancel(input), errors),
);

const record = os.bench.record.handler(({ input, context, errors }) =>
  mapBenchErrors(() => context.bench.record(input), errors),
);

const setArtifacts = os.bench.setArtifacts.handler(({ input, context, errors }) =>
  mapBenchErrors(() => context.bench.setArtifacts(input), errors),
);

const list = os.bench.list.handler(({ input, context }) => context.bench.list(input));

export const benchRouter = {
  list,
  start,
  get,
  current,
  cancel,
  record,
  setArtifacts,
};
