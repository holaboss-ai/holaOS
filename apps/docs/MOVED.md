# Docs moved

The Holaboss documentation site has moved to the **holaboss-frontend** monorepo
(`apps/docs`), where it deploys to the `holaboss-docs-*` Cloudflare Workers as
part of that repo's `.github/workflows/deploy.yml` (push `develop` → staging,
`main` → production).

This copy under `holaOS/apps/docs` is **retired**. Its `deploy:*` scripts have
been disarmed (they exit 1) so nobody accidentally publishes stale content over
the worker that holaboss-frontend now owns. The source is kept here only as
history — do not deploy it, and make content changes in holaboss-frontend.
