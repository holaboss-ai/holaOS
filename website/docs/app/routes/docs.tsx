import type { Route } from './+types/docs';
import type { ComponentProps, CSSProperties } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import type { SidebarPageTreeComponents } from 'fumadocs-ui/components/sidebar/page-tree';
import {
  SidebarFolder,
  SidebarFolderContent as BaseSidebarFolderContent,
  SidebarFolderTrigger as BaseSidebarFolderTrigger,
  SidebarItem as BaseSidebarItem,
  useFolder,
  useFolderDepth,
} from 'fumadocs-ui/components/sidebar/base';
import { useTreePath } from 'fumadocs-ui/contexts/tree';
import { getPageMarkdownUrl, source } from '@/lib/source';
import browserCollections from 'collections/browser';
import { baseOptions } from '@/lib/layout.shared';
import { gitConfig } from '@/lib/shared';
import { useFumadocsLoader } from 'fumadocs-core/source/client';
import { usePathname } from 'fumadocs-core/framework';
import { getPageImagePath } from '@/lib/og';
import { useMDXComponents } from '@/components/mdx';
import { twMerge } from 'tailwind-merge';

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = params['*'].split('/').filter((v) => v.length > 0);
  const page = source.getPage(slugs);
  if (!page) throw new Response('Not found', { status: 404 });

  return {
    path: page.path,
    markdownUrl: getPageMarkdownUrl(page).url,
    pageTree: await source.serializePageTree(source.getPageTree()),
    imagePath: getPageImagePath(slugs),
  };
}

const clientLoader = browserCollections.docs.createClientLoader({
  component(
    { toc, frontmatter, default: Mdx },
    {
      markdownUrl,
      path,
      imagePath,
    }: {
      markdownUrl: string;
      path: string;
      imagePath: string;
    },
  ) {
    return (
      <DocsPage toc={toc}>
        <title>{frontmatter.title}</title>
        <meta name="description" content={frontmatter.description} />
        <meta property="og:image" content={imagePath} />
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <div className="flex flex-row gap-2 items-center border-b -mt-4 pb-6">
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover
            markdownUrl={markdownUrl}
            githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/content/docs/${path}`}
          />
        </div>
        <DocsBody>
          <Mdx components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

function isActive(href: string, pathname: string) {
  const normalizedHref = href.length > 1 && href.endsWith('/') ? href.slice(0, -1) : href;
  const normalizedPath = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  return normalizedHref === normalizedPath;
}

function getItemOffset(depth: number) {
  return `calc(${2 + 3 * depth} * var(--spacing))`;
}

function getSidebarItemClass(options: { variant: 'link' | 'button'; highlight?: boolean }) {
  return twMerge(
    'relative flex flex-row items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground wrap-anywhere [&_svg]:size-4 [&_svg]:shrink-0',
    options.variant === 'link'
      ? 'transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 hover:transition-none data-[active=true]:bg-fd-primary/10 data-[active=true]:text-fd-primary data-[active=true]:hover:transition-colors'
      : 'transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 hover:transition-none',
    options.highlight
      ? "data-[active=true]:before:content-[''] data-[active=true]:before:bg-fd-primary data-[active=true]:before:absolute data-[active=true]:before:w-px data-[active=true]:before:inset-y-2.5 data-[active=true]:before:inset-s-2.5"
      : '',
  );
}

function StyledSidebarItem(props: ComponentProps<typeof BaseSidebarItem>) {
  const depth = useFolderDepth();
  const style = props.style as CSSProperties | undefined;

  return (
    <BaseSidebarItem
      {...props}
      className={twMerge(
        getSidebarItemClass({ variant: 'link', highlight: depth >= 1 }),
        props.className,
      )}
      style={{
        paddingInlineStart: getItemOffset(depth),
        ...style,
      }}
    />
  );
}

function StyledSidebarFolderTrigger(props: ComponentProps<typeof BaseSidebarFolderTrigger>) {
  const folder = useFolder();
  const style = props.style as CSSProperties | undefined;

  if (!folder) return <BaseSidebarFolderTrigger {...props} />;

  return (
    <BaseSidebarFolderTrigger
      {...props}
      className={twMerge(
        getSidebarItemClass({ variant: folder.collapsible ? 'button' : 'link' }),
        'w-full',
        props.className,
      )}
      style={{
        paddingInlineStart: getItemOffset(folder.depth - 1),
        ...style,
      }}
    />
  );
}

function StyledSidebarFolderContent({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseSidebarFolderContent>) {
  const depth = useFolderDepth();

  return (
    <BaseSidebarFolderContent
      {...props}
      className={twMerge(
        'relative',
        depth === 1 && "before:content-[''] before:absolute before:w-px before:inset-y-1 before:bg-fd-border before:inset-s-2.5",
        className,
      )}
    >
      <div className="flex flex-col gap-0.5 pt-0.5">{children}</div>
    </BaseSidebarFolderContent>
  );
}

const sidebarComponents: Partial<SidebarPageTreeComponents> = {
  Folder({ item, children }) {
    const path = useTreePath();
    const pathname = usePathname();
    const isActiveBranch = path.includes(item);
    const hasChildren = item.children.length > 0;
    const hasIndex = Boolean(item.index);

    if (hasIndex && !hasChildren && item.index) {
      return (
        <StyledSidebarItem
          href={item.index.url}
          active={isActive(item.index.url, pathname)}
          external={item.index.external}
          icon={item.icon ?? item.index.icon}
        >
          {item.name}
        </StyledSidebarItem>
      );
    }

    return (
      <SidebarFolder
        collapsible={item.collapsible}
        active={isActiveBranch}
        defaultOpen={item.defaultOpen}
      >
        <StyledSidebarFolderTrigger>
          {item.icon}
          {item.name}
        </StyledSidebarFolderTrigger>
        <StyledSidebarFolderContent>
          {item.index && hasChildren ? (
            <StyledSidebarItem
              href={item.index.url}
              active={isActive(item.index.url, pathname)}
              external={item.index.external}
              icon={item.index.icon}
            >
              Overview
            </StyledSidebarItem>
          ) : null}
          {children}
        </StyledSidebarFolderContent>
      </SidebarFolder>
    );
  },
};

export default function Page({ loaderData }: Route.ComponentProps) {
  const { path, pageTree, imagePath, markdownUrl } = useFumadocsLoader(loaderData);

  return (
    <DocsLayout
      {...baseOptions()}
      tree={pageTree}
      sidebar={{ components: sidebarComponents }}
      containerProps={{ className: 'max-w-none' }}
    >
      {clientLoader.useContent(path, { markdownUrl, path, imagePath })}
    </DocsLayout>
  );
}
