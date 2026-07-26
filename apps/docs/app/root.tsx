import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import { RootProvider } from 'fumadocs-ui/provider/react-router';
import type { Route } from './+types/root';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/noto-serif';
import './app.css';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import NotFound from './routes/not-found';
import { docsContentRoute, docsRoute } from '@/lib/shared';

export const links: Route.LinksFunction = () => [
  { rel: 'icon', type: 'image/svg+xml', href: '/docs/favicon.svg' },
  { rel: 'icon', type: 'image/x-icon', href: '/docs/favicon.ico' },
  { rel: 'apple-touch-icon', href: '/docs/apple-touch-icon.png' },
];

export const meta: Route.MetaFunction = () => [
  { title: 'holaOS Docs' },
  {
    name: 'description',
    content:
      'Guides, references, and platform internals for building and running long-horizon agents on holaOS.',
  },
  { property: 'og:title', content: 'holaOS Docs' },
  {
    property: 'og:description',
    content:
      'Guides, references, and platform internals for building and running long-horizon agents on holaOS.',
  },
  { property: 'og:type', content: 'website' },
  { property: 'og:site_name', content: 'holaOS' },
  { property: 'og:image', content: '/docs/logo.svg' },
  { name: 'twitter:card', content: 'summary_large_image' },
  { name: 'twitter:title', content: 'holaOS Docs' },
  {
    name: 'twitter:description',
    content:
      'Guides, references, and platform internals for building and running long-horizon agents on holaOS.',
  },
  { name: 'twitter:image', content: '/docs/logo.svg' },
  { name: 'theme-color', content: '#F58419' },
];

const NAME_SHIM = `if(typeof globalThis.__name==='undefined'){globalThis.__name=function(f){return f}}`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: NAME_SHIM }} />
        <Meta />
        <Links />
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) return <NotFound />;
    message = 'Error';
    details = error.statusText;
  } else if (error && error instanceof Error) {
    // Temporarily surface error details in production to diagnose staging.
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 w-full max-w-[1400px] mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}

const { rewrite: rewriteDocs } = rewritePath(
  `${docsRoute}{/*path}`,
  `${docsContentRoute}{/*path}/content.md`,
);
const { rewrite: rewriteSuffix } = rewritePath(
  `${docsRoute}{/*path}.mdx`,
  `${docsContentRoute}{/*path}/content.md`,
);
const serverMiddleware: Route.MiddlewareFunction = async ({ request }, next) => {
  const url = new URL(request.url);
  const suffixPath = rewriteSuffix(url.pathname);
  if (suffixPath) return Response.redirect(new URL(suffixPath, url));

  if (isMarkdownPreferred(request)) {
    const docsPath = rewriteDocs(url.pathname);
    if (docsPath) return Response.redirect(new URL(docsPath, url));
  }

  return next();
};
export const middleware = [serverMiddleware];
