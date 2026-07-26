import tailwind from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const here = fileURLToPath(new URL(".", import.meta.url))
const nm = (pkg: string) => fileURLToPath(new URL(`./node_modules/${pkg}`, import.meta.url))

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5193,
    strictPort: false,
  },
  resolve: {
    preserveSymlinks: false,
    alias: {
      "@holaboss/ui/styles.css": `${nm("@holaboss/ui")}/dist/styles.css`,
      "@holaboss/ui": nm("@holaboss/ui"),
      "lucide-react": nm("lucide-react"),
      react: nm("react"),
      "react-dom": nm("react-dom"),
    },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["@holaboss/ui", "lucide-react", "react", "react-dom", "react-dom/client"],
  },
  root: here,
})
