# @holaboss/app-host

The **HolaApp desktop host bridge**. Lets a HolaApp web page (running inside the
holaOS desktop client) request native desktop operations — the first one being
"open a chat session pre-filled with this context."

> Distinct from `@holaboss/app-sdk` (the generated product REST client) and
> `@holaboss/app-builder-sdk` (for authoring app *modules*). This package is the
> *host RPC* a hosted web page uses to drive the desktop UI.

Two entry points:

- **`@holaboss/app-host`** — the web client. Safe to import anywhere; degrades
  to a no-op when not inside the desktop.
- **`@holaboss/app-host/protocol`** — the shared contract (constants + types).
  The desktop preload + main import this so the two sides can't drift.

## Usage (web)

```ts
import { host } from "@holaboss/app-host";

async function discuss(record) {
  if (!host.isAvailable()) {
    // Not in the desktop — keep your web fallback.
    return;
  }
  await host.chat.start({
    prompt: `Let's discuss "${record.title}".`,
    context: [
      {
        app: "need-review",
        kind: "record",
        title: record.title,
        refs: { recordId: record.recordId },
        snapshot: { mime: "text/html", content: record.artifactHtml },
        mcp: { server: "need-review", hint: "get_record by recordId" },
      },
    ],
  });
}
```

`host.isAvailable()` is `false` and ops reject with `HostUnavailableError` when
the bridge is absent — always gate on it.

See `docs/plans/2026-06-23-holaapp-desktop-host-bridge.md` for the full design.
