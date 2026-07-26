import { os } from "./base";

const list = os.outputs.list.handler(({ input, context }) =>
  context.outputs.list(input)
);

export const outputsRouter = { list };
