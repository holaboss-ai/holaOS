import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import mdx from 'fumadocs-mdx/vite';
import * as MdxConfig from './source.config';

export default defineConfig(({ command }) => ({
  // The docs app is mounted under /docs on the same hostname as landing.
  // Setting `base` prefixes every asset URL in the build output so the
  // browser fetches from the right path; the Worker then rewrites those
  // requests to look them up in the Assets binding.
  // Vite requires a trailing slash; React Router basename matches prefix-wise.
  base: '/docs/',
  plugins: [
    {
      name: 'docs-dev-entry-redirect',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url?.split('?')[0];

          // In production `/docs` belongs to the landing app, but in local
          // docs-only dev we need a concrete page entry. Redirect the common
          // entry URLs to the first real docs page before Vite's base-path
          // warning page can take over.
          if (
            command === 'serve' &&
            (url === '/' || url === '/docs' || url === '/docs/')
          ) {
            res.statusCode = 302;
            res.setHeader('Location', '/docs/getting-started');
            res.end();
            return;
          }

          next();
        });
      },
    },
    mdx(MdxConfig),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
}));
