// Cloudflare Worker entry. The docs app is mounted at /docs/* on the same
// hostname as the landing site. This worker:
//   1. Serves static assets (under /docs/assets/*, /docs/images/*, and file
//      extensions like .svg .ico .png) from the Assets binding with the
//      /docs prefix stripped.
//   2. Falls through to the React Router SSR request handler for everything
//      else — including RR's single-fetch `.data` URLs used during client
//      navigation, which MUST reach the framework handler rather than the
//      Assets binding.
//
// Shim for the esbuild `__name` helper so runtime-evaluated code
// (e.g. Fumadocs MDX dynamic compile) doesn't crash with
// "ReferenceError: __name is not defined".
declare global {
  // eslint-disable-next-line no-var
  var __name: <T>(fn: T, name?: string) => T;
}
if (typeof globalThis.__name === 'undefined') {
  globalThis.__name = (fn, _name) => fn;
}

// @ts-expect-error - server build is generated at build time
import * as serverBuild from '../build/server/index.js';
import {
  createContext,
  createRequestHandler,
  RouterContextProvider,
} from 'react-router';

export const cloudflareContext = createContext<{
  env: Env;
  ctx: ExecutionContext;
}>();

const requestHandler = createRequestHandler(
  serverBuild as unknown as Parameters<typeof createRequestHandler>[0],
  'production',
);

const DOCS_PREFIX = '/docs';

// Paths that unambiguously refer to static build output. Anything else
// (including `/docs/foo.data` used by RR single-fetch) is handled by SSR.
const STATIC_PREFIXES = ['/assets/', '/images/'];
const STATIC_EXTS =
  /\.(svg|png|jpg|jpeg|webp|gif|ico|css|js|mjs|map|woff2?|ttf|txt|xml|json|wasm)$/i;

function looksLikeStaticAsset(pathname: string): boolean {
  if (pathname.endsWith('.data')) return false;
  if (STATIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  return STATIC_EXTS.test(pathname);
}

// Path renames / restructures. Prefix-matched; first match wins, so
// order specific → general. The matched segment is stripped and `to`
// is prepended, preserving the remainder — e.g.
// `/docs/platform-internals/runtime/apis` → `/docs/contribute/runtime/apis`.
const REDIRECTS: Array<[from: string, to: string]> = [
  // Exact leaves under app-development first (otherwise the prefix
  // rules below would swallow them with the wrong target).
  [
    '/docs/app-development/templates/materialization',
    '/docs/contribute/templates-materialization',
  ],
  ['/docs/app-development/templates/versioning', '/docs/templates/publishing'],
  ['/docs/app-development/templates/structure', '/docs/templates/anatomy'],
  ['/docs/app-development/bridge-sdk', '/docs/apps/bridge-sdk'],
  ['/docs/app-development/troubleshooting', '/docs/apps/troubleshooting'],
  // Prefix groups next.
  ['/docs/app-development/templates', '/docs/templates'],
  ['/docs/app-development/skills', '/docs/templates/skills'],
  ['/docs/app-development/apps', '/docs/apps'],
  // Bare root last — catches `/docs/app-development` itself and
  // anything not matched above.
  ['/docs/app-development', '/docs/apps'],
  // Earlier rename: platform-internals → contribute.
  ['/docs/platform-internals', '/docs/contribute'],
];

function tryRedirect(url: URL): Response | null {
  for (const [from, to] of REDIRECTS) {
    if (url.pathname === from || url.pathname.startsWith(`${from}/`)) {
      const suffix = url.pathname.slice(from.length);
      const dest = new URL(url);
      dest.pathname = to + suffix;
      return Response.redirect(dest.href, 301);
    }
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const redirect = tryRedirect(url);
    if (redirect) return redirect;

    if (
      url.pathname.startsWith(`${DOCS_PREFIX}/`) &&
      url.pathname !== `${DOCS_PREFIX}/`
    ) {
      const inner = url.pathname.slice(DOCS_PREFIX.length);
      if (looksLikeStaticAsset(inner)) {
        const stripped = new URL(url);
        stripped.pathname = inner;
        const assetResp = await env.ASSETS.fetch(
          new Request(stripped, request),
        );
        if (assetResp.status !== 404) return assetResp;
      }
    }

    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
