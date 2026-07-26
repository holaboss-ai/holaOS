import type { BaseLayoutProps, LinkItemType } from 'fumadocs-ui/layouts/shared';
import { gitConfig } from './shared';

// Primary nav mirrors the landing top bar (features/landing GlobalTopBar).
// The docs site and landing both run on sibling Cloudflare Workers under
// the same domain, so clicks must be plain same-tab <a> navigations — a
// fumadocs/react-router Link would SPA-route inside the docs worker and
// 404 before CF can route to the landing worker. `external: true` on
// fumadocs LinkItem triggers target=_blank, which we don't want. Using
// CustomItemType is the clean escape hatch.
const navLinkClass =
  'inline-flex h-9 items-center rounded-[12px] px-3 font-hb-sans text-sm text-hb-fg-muted transition-colors hover:bg-hb-bg-100 hover:text-hb-fg';

const crossWorkerLink = (label: string, href: string): LinkItemType => ({
  type: 'custom',
  on: 'nav',
  children: (
    <a className={navLinkClass} href={href}>
      {label}
    </a>
  ),
});

const PRIMARY_NAV: LinkItemType[] = [
  crossWorkerLink('Desktop', '/desktop'),
  crossWorkerLink('HolaOS', '/holaos'),
  crossWorkerLink('Marketplace', '/marketplace'),
  crossWorkerLink('Create', '/create'),
];

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // Split brand into two click targets: "holaOS" (logo + name) → /
      // (landing worker), "Docs" → /docs (docs home). The docs site and
      // landing live on different Cloudflare Workers on the same domain,
      // so both must be plain <a> — a fumadocs/react-router <Link> would
      // SPA-navigate inside the docs worker and 404 before CF can route
      // to the landing worker.
      //
      // fumadocs passes `{ href, className, ...props }` to this render
      // function (see layouts/shared/client.js InlineNavTitle). We apply
      // its className to an outer <span> so nav styling is preserved;
      // we ignore the single-href anchor shape because we need two.
      title: ({ className }) => (
        <span className={className}>
          <a
            href="/"
            className="inline-flex items-center gap-2 transition-opacity hover:opacity-80"
          >
            <img
              src="/docs/logo.svg"
              alt=""
              className="h-[22px] w-[22px] rounded-md"
            />
            <span className="font-hb-mono text-[13px] tracking-tight text-hb-fg">
              holaOS
            </span>
          </a>
          <span className="mx-1.5 font-hb-mono text-[13px] text-hb-fg-subtle select-none">
            :
          </span>
          <a
            href="/docs"
            className="font-hb-mono text-[13px] tracking-tight text-hb-fg-subtle transition-colors hover:text-hb-fg"
          >
            Docs
          </a>
        </span>
      ),
    },
    links: PRIMARY_NAV,
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
