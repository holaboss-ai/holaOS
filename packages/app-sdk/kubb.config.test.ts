import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import kubbConfig from "./kubb.config";

const packageJsonPath = resolve(import.meta.dirname, "package.json");
type KubbConfigShape = {
  input?: { path?: string };
  output?: { path?: string };
  plugins?: Array<{ name: string }>;
};

describe("@holaboss/app-sdk package scaffold", () => {
  it("defines the shared app sdk package with layered exports", () => {
    expect(existsSync(packageJsonPath)).toBe(true);

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      exports?: Record<string, unknown>;
      scripts?: Record<string, string>;
    };

    expect(packageJson.name).toBe("@holaboss/app-sdk");
    expect(packageJson.exports).toMatchObject({
      ".": expect.any(Object),
      "./core": expect.any(Object),
      "./react": expect.any(Object),
      "./zod": expect.any(Object),
    });
    expect(packageJson.scripts?.codegen).toBe(
      "kubb generate --config ./kubb.config.ts"
    );
  });

  it("targets the Hono OpenAPI surface and keeps generated layers separate", () => {
    const rawConfig = kubbConfig as KubbConfigShape | KubbConfigShape[];
    const config = (
      Array.isArray(rawConfig) ? rawConfig[0] : rawConfig
    ) as KubbConfigShape;

    expect(config.input?.path).toBe(
      "http://127.0.0.1:4000/api/marketplace/openapi.json"
    );
    expect(config.output?.path).toBe("./src/generated");

    const pluginNames = (config.plugins ?? []).map(
      (plugin: { name: string }) => plugin.name
    );
    expect(pluginNames).toContain("plugin-oas");
    expect(pluginNames).toContain("plugin-ts");
    expect(pluginNames).toContain("plugin-zod");
    expect(pluginNames).toContain("plugin-client");
    expect(pluginNames).toContain("plugin-react-query");
  });
});
