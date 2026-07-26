import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDesktopEnv, resolveDesktopEnvPaths } from "./desktopEnv";

const REMOTE_ENV = "HOLABOSS_BACKEND_BASE_URL";

function withIsolatedRemoteEnv(run: () => void) {
  const previousValue = process.env[REMOTE_ENV];
  delete process.env[REMOTE_ENV];
  try {
    run();
  } finally {
    if (previousValue === undefined) {
      delete process.env[REMOTE_ENV];
    } else {
      process.env[REMOTE_ENV] = previousValue;
    }
  }
}

test("loads legacy desktop/.env when apps/desktop/.env is absent", () => {
  withIsolatedRemoteEnv(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "holaboss-desktop-env-"));
    const desktopRoot = path.join(root, "apps", "desktop");
    const legacyDesktopDir = path.join(root, "desktop");
    try {
      fs.mkdirSync(desktopRoot, { recursive: true });
      fs.mkdirSync(legacyDesktopDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDesktopDir, ".env"),
        `${REMOTE_ENV}=https://legacy.example\n`,
        "utf8",
      );

      const loadedPaths = loadDesktopEnv({ desktopRoot });
      const { legacyEnvPath } = resolveDesktopEnvPaths({ desktopRoot });

      assert.deepEqual(loadedPaths, [legacyEnvPath]);
      assert.equal(process.env[REMOTE_ENV], "https://legacy.example");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("apps/desktop/.env takes precedence over legacy desktop/.env", () => {
  withIsolatedRemoteEnv(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "holaboss-desktop-env-"));
    const desktopRoot = path.join(root, "apps", "desktop");
    const legacyDesktopDir = path.join(root, "desktop");
    try {
      fs.mkdirSync(desktopRoot, { recursive: true });
      fs.mkdirSync(legacyDesktopDir, { recursive: true });
      fs.writeFileSync(
        path.join(desktopRoot, ".env"),
        `${REMOTE_ENV}=https://canonical.example\n`,
        "utf8",
      );
      fs.writeFileSync(
        path.join(legacyDesktopDir, ".env"),
        `${REMOTE_ENV}=https://legacy.example\n`,
        "utf8",
      );

      const loadedPaths = loadDesktopEnv({ desktopRoot });
      const { preferredEnvPath, legacyEnvPath } = resolveDesktopEnvPaths({
        desktopRoot,
      });

      assert.deepEqual(loadedPaths, [legacyEnvPath, preferredEnvPath]);
      assert.equal(process.env[REMOTE_ENV], "https://canonical.example");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test(".env.production overrides .env without outranking the canonical location", () => {
  withIsolatedRemoteEnv(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "holaboss-desktop-env-"));
    const desktopRoot = path.join(root, "apps", "desktop");
    const legacyDesktopDir = path.join(root, "desktop");
    try {
      fs.mkdirSync(desktopRoot, { recursive: true });
      fs.mkdirSync(legacyDesktopDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDesktopDir, ".env.production"),
        `${REMOTE_ENV}=https://legacy-production.example\n`,
        "utf8",
      );
      fs.writeFileSync(
        path.join(desktopRoot, ".env"),
        `${REMOTE_ENV}=https://canonical.example\n`,
        "utf8",
      );
      fs.writeFileSync(
        path.join(desktopRoot, ".env.production"),
        `${REMOTE_ENV}=https://canonical-production.example\n`,
        "utf8",
      );

      const loadedPaths = loadDesktopEnv({ desktopRoot, includeProduction: true });

      assert.deepEqual(loadedPaths, [
        path.join(legacyDesktopDir, ".env.production"),
        path.join(desktopRoot, ".env"),
        path.join(desktopRoot, ".env.production"),
      ]);
      assert.equal(process.env[REMOTE_ENV], "https://canonical-production.example");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
