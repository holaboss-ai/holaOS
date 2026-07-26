import { os } from "./base";
import { CronjobsServiceError } from "./context";

const isNotFound = (error: unknown): boolean =>
  error instanceof CronjobsServiceError && error.code === "NOT_FOUND";

const list = os.cronjobs.list.handler(({ input, context }) =>
  context.cronjobs.list(input)
);

const create = os.cronjobs.create.handler(({ input, context }) =>
  context.cronjobs.create(input)
);

const runNow = os.cronjobs.runNow.handler(async ({ input, context, errors }) => {
  try {
    return await context.cronjobs.runNow(input);
  } catch (error) {
    if (isNotFound(error)) {
      throw errors.NOT_FOUND();
    }
    throw error;
  }
});

const update = os.cronjobs.update.handler(async ({ input, context, errors }) => {
  try {
    return await context.cronjobs.update(input);
  } catch (error) {
    if (isNotFound(error)) {
      throw errors.NOT_FOUND();
    }
    throw error;
  }
});

const del = os.cronjobs.delete.handler(async ({ input, context, errors }) => {
  try {
    return await context.cronjobs.delete(input);
  } catch (error) {
    if (isNotFound(error)) {
      throw errors.NOT_FOUND();
    }
    throw error;
  }
});

export const cronjobsRouter = { list, runNow, create, update, delete: del };
