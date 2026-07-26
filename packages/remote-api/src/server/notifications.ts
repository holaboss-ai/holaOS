import { os } from "./base";
import { NotificationsServiceError } from "./context";

const list = os.notifications.list.handler(({ input, context }) =>
  context.notifications.list(input)
);

const update = os.notifications.update.handler(
  async ({ input, context, errors }) => {
    try {
      return await context.notifications.update(input);
    } catch (error) {
      if (
        error instanceof NotificationsServiceError &&
        error.code === "NOT_FOUND"
      ) {
        throw errors.NOT_FOUND();
      }
      throw error;
    }
  }
);

export const notificationsRouter = { list, update };
