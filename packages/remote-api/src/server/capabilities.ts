import { os } from "./base";
import { CapabilitiesServiceError } from "./context";

const catalog = os.capabilities.catalog.handler(({ input, context }) =>
  context.capabilities.catalog(input)
);

const listInstalled = os.capabilities.listInstalled.handler(({ input, context }) =>
  context.capabilities.listInstalled(input)
);

const install = os.capabilities.install.handler(
  async ({ input, context, errors }) => {
    try {
      return await context.capabilities.install(input);
    } catch (error) {
      if (error instanceof CapabilitiesServiceError && error.code === "NOT_FOUND") {
        throw errors.NOT_FOUND();
      }
      throw error;
    }
  }
);

const create = os.capabilities.create.handler(({ input, context }) =>
  context.capabilities.create(input)
);

const importPlugin = os.capabilities.importPlugin.handler(
  async ({ input, context, errors }) => {
    try {
      return await context.capabilities.importPlugin(input);
    } catch (error) {
      throw errors.BAD_REQUEST({
        message: error instanceof Error ? error.message : "could not import plugin",
      });
    }
  }
);

const uninstall = os.capabilities.uninstall.handler(({ input, context }) =>
  context.capabilities.uninstall(input)
);

const toggle = os.capabilities.toggle.handler(async ({ input, context, errors }) => {
  try {
    return await context.capabilities.toggle(input);
  } catch (error) {
    if (error instanceof CapabilitiesServiceError && error.code === "NOT_FOUND") {
      throw errors.NOT_FOUND();
    }
    throw error;
  }
});

export const capabilitiesRouter = {
  catalog,
  listInstalled,
  install,
  create,
  importPlugin,
  uninstall,
  toggle,
};
