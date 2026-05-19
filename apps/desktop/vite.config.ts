import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), react()],
  build: {
    outDir: "out/dist",
    emptyOutDir: true,
    sourcemap: "hidden"
  },
  resolve: {
    // Array form so we can use exact-match regexes — string aliases are
    // prefix-matched and would break subpath imports.
    alias: [
      // Editor package: load from source so Vite owns the module graph and
      // HMR works on every save in sdk/editor/src/. The dist/ is only
      // for non-Vite consumers (tests, packaging) and is built via tsup.
      {
        find: /^@holaboss\/editor$/,
        replacement: path.resolve(__dirname, "../../sdk/editor/src/index.ts")
      },
      // Stylesheet subpath — same reason: load source so CSS edits HMR.
      {
        find: /^@holaboss\/editor\/styles\.css$/,
        replacement: path.resolve(__dirname, "../../sdk/editor/src/styles.css")
      },
      { find: "@", replacement: path.resolve(__dirname, "src") }
    ],
    // Force a single React instance even when imported from linked packages.
    // Without this, a bare `import "react"` inside the linked package's
    // source can resolve to a different React copy and break hooks
    // ("Cannot read properties of null (reading 'useRef')").
    dedupe: ["react", "react-dom"]
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
