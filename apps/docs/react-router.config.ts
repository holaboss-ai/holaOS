import type { Config } from '@react-router/dev/config';

// SSR-only on Cloudflare Workers. All routes in app/routes.ts explicitly
// carry the /docs prefix to match the incoming URL on the shared hostname
// (www.imerchstaging.com/docs/*). We deliberately do NOT use a React
// Router `basename` here because Fumadocs' clientLoader rendering pipeline
// drops the router context needed for Link basename-prepend to work.
export default {
  ssr: true,
  future: {
    v8_middleware: true,
  },
  // Lazy route discovery fetches a manifest during client navigation.
  // Default path is `/__manifest` which would be routed to the landing
  // worker (not this one). Move it under `/docs/` so the request hits us.
  routeDiscovery: {
    mode: 'lazy',
    manifestPath: '/docs/__manifest',
  },
} satisfies Config;
