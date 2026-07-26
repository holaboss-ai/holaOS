import { os } from "./base";

const search = os.memory.search.handler(({ input, context }) =>
  context.memory.search(input)
);

const get = os.memory.get.handler(({ input, context }) =>
  context.memory.get(input)
);

const upsert = os.memory.upsert.handler(({ input, context }) =>
  context.memory.upsert(input)
);

const status = os.memory.status.handler(({ input, context }) =>
  context.memory.status(input)
);

const sync = os.memory.sync.handler(({ input, context }) =>
  context.memory.sync(input)
);

const browseTree = os.memory.browseTree.handler(({ input, context }) =>
  context.memory.browseTree(input)
);

const readFile = os.memory.readFile.handler(({ input, context }) =>
  context.memory.readFile(input)
);

const readNodeDetail = os.memory.readNodeDetail.handler(({ input, context }) =>
  context.memory.readNodeDetail(input)
);

const browseGraph = os.memory.browseGraph.handler(({ input, context }) =>
  context.memory.browseGraph(input)
);

export const memoryRouter = {
  search,
  get,
  upsert,
  status,
  sync,
  browseTree,
  readFile,
  readNodeDetail,
  browseGraph,
};
