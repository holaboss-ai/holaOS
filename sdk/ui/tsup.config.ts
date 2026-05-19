import { defineConfig } from "tsup";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: false,
  clean: true,
  external: ["react", "react-dom"],
  async onSuccess() {
    // Bundle css next to the JS output so consumers can `import
    // "@holaboss/ui/tokens.css"` directly.
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
});
