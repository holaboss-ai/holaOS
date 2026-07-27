import { createRouterClient } from "@orpc/server";
import type { RemoteApiContext, RemoteApiIdentity } from "../server";
import { remoteApiRouter } from "../server/router";

/**
 * A whole RemoteApiContext where every method throws, so a test only has to
 * describe the handful of calls it actually exercises.
 *
 * Before this, each test file declared the full context inline. That is eight
 * copies of a shape the router owns, which meant adding one method to a service
 * interface failed eight files at tsc — none of which cared about the method.
 *
 * The throwing default is the point: a call the test did not plan for fails
 * loudly at the call rather than quietly returning an empty list.
 */
export function notUsed(): never {
  throw new Error("not used");
}

/** Per-service partial — override only the methods under test. */
export type TestContextOverrides = {
  [K in keyof Omit<RemoteApiContext, "identity">]?: Partial<RemoteApiContext[K]>;
} & { identity?: RemoteApiIdentity };

function baseContext(): Omit<RemoteApiContext, "identity"> {
  return {
    memory: {
      search: notUsed,
      get: notUsed,
      upsert: notUsed,
      status: notUsed,
      sync: notUsed,
      browseTree: notUsed,
      readFile: notUsed,
      readNodeDetail: notUsed,
      browseGraph: notUsed,
    },
    outputs: { list: notUsed },
    notifications: { list: notUsed, update: notUsed },
    cronjobs: {
      list: notUsed,
      runNow: notUsed,
      create: notUsed,
      update: notUsed,
      delete: notUsed,
    },
    skills: { catalog: notUsed, install: notUsed, importUpload: notUsed },
    channels: {
      list: notUsed,
      validate: notUsed,
      startDeviceAuth: notUsed,
      pollDeviceAuth: notUsed,
      create: notUsed,
      delete: notUsed,
      setModel: notUsed,
      setHarness: notUsed,
      listSessions: notUsed,
    },
    capabilities: {
      catalog: notUsed,
      listInstalled: notUsed,
      install: notUsed,
      create: notUsed,
      importPlugin: notUsed,
      uninstall: notUsed,
      toggle: notUsed,
    },
  };
}

export function makeTestContext(
  overrides: TestContextOverrides = {},
): RemoteApiContext {
  const base = baseContext();
  // Merged one service at a time rather than in a loop: a keyed loop widens the
  // value type past what tsc will spread, and being explicit costs one line each.
  return {
    memory: { ...base.memory, ...overrides.memory },
    outputs: { ...base.outputs, ...overrides.outputs },
    notifications: { ...base.notifications, ...overrides.notifications },
    cronjobs: { ...base.cronjobs, ...overrides.cronjobs },
    skills: { ...base.skills, ...overrides.skills },
    channels: { ...base.channels, ...overrides.channels },
    capabilities: { ...base.capabilities, ...overrides.capabilities },
    identity: overrides.identity,
  };
}

/** The common case: a router client over a context built from `overrides`. */
export function makeTestClient(overrides: TestContextOverrides = {}) {
  return createRouterClient(remoteApiRouter, {
    context: makeTestContext(overrides),
  });
}
