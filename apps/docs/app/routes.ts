import { route, type RouteConfig } from '@react-router/dev/routes';

// The docs app is mounted at /docs/* on the same hostname as the landing
// site. Every route explicitly carries the /docs prefix (no RR basename)
// so incoming URLs match directly.
//
// `/docs` (exact) is handled by the frontend worker. CF workers routes
// only claim `/docs/*` for this worker, so a bare `/docs` typed or
// bookmarked hits the frontend directly. The `docs-escape` route below
// exists so that in-SPA navigations to `/docs` (popstate from a subpage,
// or a client-side <Link>) break out of this worker's router and do a
// full document reload, which CF then routes to the frontend.
export default [
  route('docs', 'routes/docs-escape.tsx'),
  route('docs/api/search', 'routes/search.ts'),
  route('docs/og/*', 'routes/og.docs.tsx'),

  route('docs/llms.txt', 'llms/index.ts'),
  route('docs/llms-full.txt', 'llms/full.ts'),
  route('docs/llms.mdx/*', 'llms/mdx.ts'),

  route('docs/*', 'routes/docs.tsx'),

  route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig;
