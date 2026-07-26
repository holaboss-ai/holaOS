import { os } from "./base";

const catalog = os.skills.catalog.handler(({ input, context }) =>
  context.skills.catalog(input)
);

const install = os.skills.install.handler(async ({ input, context, errors }) => {
  try {
    return await context.skills.install(input);
  } catch (error) {
    throw errors.NOT_FOUND({ message: error instanceof Error ? error.message : "skill not found" });
  }
});

const importUpload = os.skills.importUpload.handler(async ({ input, context, errors }) => {
  try {
    return await context.skills.importUpload(input);
  } catch (error) {
    throw errors.BAD_REQUEST({
      message: error instanceof Error ? error.message : "invalid skill upload",
    });
  }
});

export const skillsRouter = {
  catalog,
  install,
  importUpload,
};
