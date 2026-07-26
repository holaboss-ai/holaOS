import test from "node:test";
import assert from "node:assert/strict";

const routeModule = await import("./appSurfaceRoute.ts");

test("app surface route keeps explicit paths intact", () => {
  assert.equal(
    routeModule.resolveAppSurfacePath({
      path: "/drafts/draft-42",
      resourceId: "draft-42",
      view: "draft",
    }),
    "/drafts/draft-42",
  );
});

test("app surface route resolves home and view-only routes", () => {
  assert.equal(
    routeModule.resolveAppSurfacePath({ path: null, resourceId: null, view: "home" }),
    "/",
  );
  assert.equal(
    routeModule.resolveAppSurfacePath({ path: null, resourceId: null, view: "preview" }),
    "/preview",
  );
});

test("app surface route resolves resource routes and legacy fallback routes", () => {
  assert.equal(
    routeModule.resolveAppSurfacePath({ path: null, resourceId: "draft-42", view: "editor" }),
    "/editor/draft-42",
  );
  assert.equal(
    routeModule.resolveAppSurfacePath({ path: null, resourceId: "artifact-7", view: null }),
    "/posts/artifact-7",
  );
});
