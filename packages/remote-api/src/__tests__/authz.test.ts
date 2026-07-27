import { describe, expect, it } from "vitest";
import type { RemoteApiIdentity } from "../server";
import { makeTestClient } from "./testContext";

function makeClient(identity?: RemoteApiIdentity) {
  return makeTestClient({
    memory: {
      search: (input) => ({ ok: true, workspaceId: input.workspaceId }),
    },
    identity,
  });
}

describe("remoteApiRouter authz seam", () => {
  it("no-ops when no identity is present (in-process path)", async () => {
    const client = makeClient();
    const result = await client.memory.search({ workspaceId: "ws_b", query: "x" });
    expect(result).toMatchObject({ ok: true });
  });

  it("allows a call whose workspaceId matches the identity", async () => {
    const client = makeClient({ workspaceId: "ws_a", subject: "u1", scopes: [] });
    const result = await client.memory.search({ workspaceId: "ws_a", query: "x" });
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects a call for a workspace the identity is not authorized for", async () => {
    const client = makeClient({ workspaceId: "ws_a", subject: "u1", scopes: [] });
    await expect(
      client.memory.search({ workspaceId: "ws_b", query: "x" })
    ).rejects.toThrow();
  });
});
