import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  outExtensions: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
    dts: format === "cjs" ? ".d.cts" : ".d.ts",
  }),
  dts: { resolve: true },
  clean: true,
  target: "es2022",
  deps: {
    neverBundle: ["react", "react-dom"],
  },
  hooks: {
    "build:done": () => {
      // Ship the tokens next to the JS output so consumers can
      // `import "@holaboss/ui/tokens.css"` and
      // `import "@holaboss/ui/themes/holaos.css"` without a bundler
      // alias.
      mkdirSync(path.join(here, "dist", "themes"), { recursive: true });
      cpSync(
        path.join(here, "src", "tokens", "tokens.css"),
        path.join(here, "dist", "tokens.css"),
      );
      cpSync(
        path.join(here, "src", "tokens", "themes", "holaos.css"),
        path.join(here, "dist", "themes", "holaos.css"),
      );
    },
  },
});
