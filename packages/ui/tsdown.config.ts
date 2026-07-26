import { execFileSync } from "node:child_process";
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
      // 1. Ship the raw tokens next to the JS output so a consumer that
      //    wants CSS variables without the baked-in utility set can
      //    `import "@holaboss/ui/tokens.css"` (or `/themes/holaos.css`)
      //    directly. This is the escape hatch — the recommended path is
      //    the single `@holaboss/ui/styles.css` import below.
      mkdirSync(path.join(here, "dist", "themes"), { recursive: true });
      cpSync(
        path.join(here, "src", "tokens", "tokens.css"),
        path.join(here, "dist", "tokens.css"),
      );
      cpSync(
        path.join(here, "src", "tokens", "themes", "holaos.css"),
        path.join(here, "dist", "themes", "holaos.css"),
      );

      // 2. Run Tailwind on src/styles.css to emit a single dist/styles.css
      //    with every utility class the primitives + layouts use already
      //    compiled — so consumers don't need to add @holaboss/ui to their
      //    own Tailwind `@source` list.
      execFileSync(
        "bunx",
        [
          "@tailwindcss/cli",
          "--input",
          path.join(here, "src", "styles.css"),
          "--output",
          path.join(here, "dist", "styles.css"),
        ],
        { stdio: "inherit", cwd: here },
      );
    },
  },
});
