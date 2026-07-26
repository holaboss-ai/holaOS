import { os } from "./base";
import { ChannelsServiceError } from "./context";

const list = os.channels.list.handler(({ input, context }) => context.channels.list(input));

const validate = os.channels.validate.handler(({ input, context }) =>
  context.channels.validate(input),
);

const startDeviceAuth = os.channels.startDeviceAuth.handler(({ input, context }) =>
  context.channels.startDeviceAuth(input),
);

const pollDeviceAuth = os.channels.pollDeviceAuth.handler(({ input, context }) =>
  context.channels.pollDeviceAuth(input),
);

const create = os.channels.create.handler(async ({ input, context, errors }) => {
  try {
    return await context.channels.create(input);
  } catch (error) {
    if (error instanceof ChannelsServiceError && error.code === "INVALID_TOKEN") {
      throw errors.INVALID_TOKEN({ message: error.message });
    }
    throw error;
  }
});

const del = os.channels.delete.handler(async ({ input, context, errors }) => {
  try {
    return await context.channels.delete(input);
  } catch (error) {
    if (error instanceof ChannelsServiceError && error.code === "NOT_FOUND") {
      throw errors.NOT_FOUND();
    }
    throw error;
  }
});

const setHarness = os.channels.setHarness.handler(async ({ input, context, errors }) => {
  try {
    return await context.channels.setHarness(input);
  } catch (error) {
    if (error instanceof ChannelsServiceError && error.code === "NOT_FOUND") {
      throw errors.NOT_FOUND();
    }
    throw error;
  }
});

const setModel = os.channels.setModel.handler(async ({ input, context, errors }) => {
  try {
    return await context.channels.setModel(input);
  } catch (error) {
    if (error instanceof ChannelsServiceError && error.code === "NOT_FOUND") {
      throw errors.NOT_FOUND();
    }
    throw error;
  }
});

const listSessions = os.channels.listSessions.handler(async ({ input, context, errors }) => {
  try {
    return await context.channels.listSessions(input);
  } catch (error) {
    if (error instanceof ChannelsServiceError && error.code === "NOT_FOUND") {
      throw errors.NOT_FOUND();
    }
    throw error;
  }
});

export const channelsRouter = {
  list,
  validate,
  startDeviceAuth,
  pollDeviceAuth,
  create,
  delete: del,
  setHarness,
  setModel,
  listSessions,
};
