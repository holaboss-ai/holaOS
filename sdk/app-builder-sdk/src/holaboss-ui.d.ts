declare module "@holaboss/ui" {
  import type { ComponentType } from "react"

  export const Button: ComponentType<any>
  export const StatusDot: ComponentType<any>
}

declare module "@holaboss/ui/styles.css" {
  const href: string
  export default href
}
