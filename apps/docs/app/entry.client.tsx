import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

// Shim for the esbuild `__name` helper. Some runtime-evaluated MDX paths
// (Fumadocs dynamic compile, AsyncFunction execution) expect `__name` to
// be available globally. Defining it as a no-op identity is safe.
declare global {
  // eslint-disable-next-line no-var
  var __name: <T>(fn: T, name?: string) => T;
}
if (typeof globalThis.__name === 'undefined') {
  globalThis.__name = (fn, _name) => fn;
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
