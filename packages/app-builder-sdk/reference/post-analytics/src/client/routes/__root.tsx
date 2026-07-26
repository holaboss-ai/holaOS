import "@holaboss/ui/styles.css"
import "../app.css"

import type { ReactNode } from "react"

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="holaos-light">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Twitter analytics — holaOS</title>
      </head>
      <body className="antialiased">{children}</body>
    </html>
  )
}
