# @holaboss/app-sdk

Generated TypeScript client for the Holaboss product API. Consumed by the Holaboss web app and the open-source [holaOS](https://github.com/holaboss-ai/holaOS) desktop.

This package is a thin, type-safe wrapper over the Holaboss REST API (the Hono server that fronts the Python services). It is generated from the server's OpenAPI surface using [Kubb](https://kubb.dev/), so the types, functions, and React Query hooks stay in sync with the live contract.

## Install

```bash
npm install @holaboss/app-sdk
# or
bun add @holaboss/app-sdk
```

React hooks are optional; if you use them, install the peer:

```bash
npm install @tanstack/react-query
```

## Subpath exports

| Subpath | For | Contains |
|---|---|---|
| `@holaboss/app-sdk/core` | Non-React consumers, main/preload code in Electron, Node scripts | Generated fetch functions + `createAppClient` |
| `@holaboss/app-sdk/react` | React UIs | Generated TanStack Query hooks |
| `@holaboss/app-sdk/zod` | Client-side runtime validation | Generated Zod schemas |
| `@holaboss/app-sdk/clients/app` | Advanced: configure the underlying fetch client | Low-level `createClient` + request/response types |
| `@holaboss/app-sdk` | Convenience re-export of `core + react + zod` | Everything |

## Usage

### Create a configured client

```ts
import { createAppClient } from "@holaboss/app-sdk/core";

export const appClient = createAppClient({
  baseURL: "https://api.holaboss.ai/api/marketplace",
  credentials: "include",
});

export const appClientOptions = { client: appClient } as const;
```

### Call a generated function (non-React)

```ts
import { listMarketplaceTemplates } from "@holaboss/app-sdk/core";

const templates = await listMarketplaceTemplates({
  client: appClient,
});
```

### Use a generated React Query hook

```tsx
import { useListMarketplaceTemplates } from "@holaboss/app-sdk/react";

function TemplatesList() {
  const { data } = useListMarketplaceTemplates({
    client: appClientOptions,
  });
  return <ul>{data?.map((t) => <li key={t.id}>{t.name}</li>)}</ul>;
}
```

## Stability & versioning

This package follows [Semantic Versioning](https://semver.org/).

- **patch** (`0.x.y`) — internal changes to generated code with no observable API change
- **minor** (`0.x.0`) — additive changes: new endpoints, new optional request/response fields
- **major** — breaking changes: removed endpoints, removed fields, required field additions, request/response shape changes

While on `0.x`, breaking changes are allowed on minor bumps per standard semver-for-0.x conventions, but we will call them out in release notes and bump conservatively.

**Consumers should pin an exact version** (no `^` ranges) until this package reaches `1.0.0`.

## Regenerating

Code is generated from the Holaboss Hono server's OpenAPI spec at `/api/marketplace/openapi.json`. To regenerate with the server running locally:

```bash
bun install
KUBB_APP_OPENAPI_URL=http://127.0.0.1:4000/api/marketplace/openapi.json bun run codegen
```

The `src/generated/` tree is committed. Do not run codegen as part of the release pipeline — regeneration is a deliberate human action, reviewed in a PR, followed by a version bump.

## License

MIT
