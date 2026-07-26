import "@holaboss/ui/styles.css"
import "./app.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Dashboard } from "../../src/client/routes/index"

const container = document.getElementById("root")
if (!container) throw new Error("missing #root")

createRoot(container).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
)
