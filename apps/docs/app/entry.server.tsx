// Cloudflare Workers entry — uses react-dom/server's edge-compatible
// renderToReadableStream instead of Node's renderToPipeableStream (which
// relies on streams/pipe APIs unavailable on Workers).
import type { AppLoadContext, EntryContext } from 'react-router';
import { ServerRouter } from 'react-router';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  let shellRendered = false;

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: request.signal,
      onError(error: unknown) {
        responseStatusCode = 500;
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  // Wait for the full response for bots and SPA mode so they get the
  // complete HTML rather than a streamed shell.
  const userAgent = request.headers.get('user-agent');
  if (
    (userAgent && isbot(userAgent)) ||
    (routerContext as unknown as { isSpaMode?: boolean }).isSpaMode
  ) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
