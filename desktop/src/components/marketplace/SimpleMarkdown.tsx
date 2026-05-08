/**
 * Markdown renderer shared by the marketplace README and workspace chat.
 * Uses react-markdown with GFM support while preserving the existing md-* CSS hooks.
 */

import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, codeBlockFromPreNode } from "./CodeBlock";
import { normalizeWrappedMarkdownFence } from "./markdownFenceNormalization.mjs";

/** Hand-shake URL scheme for `@`-mentions injected into markdown
 *  before render. The host pre-processes its source text to turn each
 *  `@<handle>` into `[@<handle>](holaboss-mention://<handle>)`; this
 *  module's link renderer recognises the scheme and delegates to
 *  `renderMention(handle)`. Keeping the contract here so callers don't
 *  guess the prefix. */
export const MENTION_URL_SCHEME = "holaboss-mention://";

function appendClassName(current: string | undefined, next: string): string {
  return current ? `${current} ${next}` : next;
}

function normalizeHttpUrl(rawHref: string | null | undefined): string | null {
  const trimmed = (rawHref ?? "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}

import type { ExtraProps } from "react-markdown";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MdProps = any;

function createMarkdownComponents(
  onLinkClick?: ((url: string) => void) | undefined,
  onLocalLinkClick?: ((href: string) => void) | undefined,
  renderMention?: ((handle: string) => ReactNode) | undefined,
): Components {
  return {
  a({ className, ...props }: MdProps) {
    const rawHref = typeof props.href === "string" ? props.href.trim() : "";
    if (renderMention && rawHref.startsWith(MENTION_URL_SCHEME)) {
      const handle = rawHref.slice(MENTION_URL_SCHEME.length);
      // Render the chip directly. The wrapping <a> is dropped — the
      // mention is a structural reference, not a navigable link.
      return <>{renderMention(handle)}</>;
    }
    const normalizedHttpHref = normalizeHttpUrl(rawHref);
    const isHttpHref = normalizedHttpHref !== null;
    const isAnchor = rawHref.startsWith("#");
    const localHref = !isHttpHref && !isAnchor && rawHref ? rawHref : null;
    const upstreamOnClick = props.onClick;
    return (
      <a
        {...props}
        className={appendClassName(className, "md-link")}
        onClick={(event) => {
          upstreamOnClick?.(event);
          if (event.defaultPrevented) {
            return;
          }
          if (isHttpHref && onLinkClick && normalizedHttpHref) {
            event.preventDefault();
            onLinkClick(normalizedHttpHref);
            return;
          }
          if (localHref && onLocalLinkClick) {
            event.preventDefault();
            onLocalLinkClick(localHref);
          }
        }}
        rel="noopener noreferrer"
        target={isHttpHref ? "_blank" : undefined}
      />
    );
  },
  blockquote({ className, ...props }: MdProps) {
    return <blockquote {...props} className={appendClassName(className, "md-blockquote")} />;
  },
  h1({ className, ...props }: MdProps) {
    return <h1 {...props} className={appendClassName(className, "md-h1")} />;
  },
  h2({ className, ...props }: MdProps) {
    return <h2 {...props} className={appendClassName(className, "md-h2")} />;
  },
  h3({ className, ...props }: MdProps) {
    return <h3 {...props} className={appendClassName(className, "md-h3")} />;
  },
  h4({ className, ...props }: MdProps) {
    return <h4 {...props} className={appendClassName(className, "md-h4")} />;
  },
  h5({ className, ...props }: MdProps) {
    return <h5 {...props} className={appendClassName(className, "md-h5")} />;
  },
  h6({ className, ...props }: MdProps) {
    return <h6 {...props} className={appendClassName(className, "md-h6")} />;
  },
  hr({ className, ...props }: MdProps) {
    return <hr {...props} className={appendClassName(className, "md-hr")} />;
  },
  img({ className, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & ExtraProps) {
    return <img {...props} alt={alt ?? ""} className={appendClassName(className, "md-img")} loading="lazy" />;
  },
  li({ className, ...props }: MdProps) {
    return <li {...props} className={appendClassName(className, "md-li md-oli")} />;
  },
  ol({ className, ...props }: MdProps) {
    return <ol {...props} className={appendClassName(className, "md-ol")} />;
  },
  p({ className, ...props }: MdProps) {
    return <p {...props} className={appendClassName(className, "md-p")} />;
  },
  pre({ children }: MdProps) {
    const { language, code } = codeBlockFromPreNode(children);
    return <CodeBlock code={code} language={language} />;
  },
  table({ className, ...props }: MdProps) {
    return <table {...props} className={appendClassName(className, "md-table")} />;
  },
  td({ className, ...props }: MdProps) {
    return <td {...props} className={appendClassName(className, "md-table-cell")} />;
  },
  th({ className, ...props }: MdProps) {
    return <th {...props} className={appendClassName(className, "md-table-head-cell")} />;
  },
  ul({ className, ...props }: MdProps) {
    return <ul {...props} className={appendClassName(className, "md-ul")} />;
  },
  code({ className, ...props }: MdProps) {
    return <code {...props} className={appendClassName(className, "md-inline-code")} />;
  }
  };
}

interface SimpleMarkdownProps {
  children: string;
  className?: string;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
  /** Optional renderer for `holaboss-mention://<handle>` links —
   *  callers pre-process their source to inject this scheme and pass
   *  a chip-style component (e.g. `EntityMention`). Without this
   *  prop, mention links fall through to the regular link renderer. */
  renderMention?: (handle: string) => ReactNode;
}

function SimpleMarkdownComponent({
  children,
  className = "",
  onLinkClick,
  onLocalLinkClick,
  renderMention,
}: SimpleMarkdownProps) {
  const normalizedChildren = useMemo(
    () => normalizeWrappedMarkdownFence(children),
    [children],
  );
  const components = useMemo(
    () => createMarkdownComponents(onLinkClick, onLocalLinkClick, renderMention),
    [onLinkClick, onLocalLinkClick, renderMention],
  );

  return (
    <div className={`simple-markdown ${className}`.trim()}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => {
          // Allow our internal mention scheme through unchanged so the
          // link renderer can detect it; everything else falls back to
          // react-markdown's default safety filter.
          if (url.startsWith(MENTION_URL_SCHEME)) {
            return url;
          }
          return defaultUrlTransform(url);
        }}
      >
        {normalizedChildren}
      </ReactMarkdown>
    </div>
  );
}

export const SimpleMarkdown = memo(SimpleMarkdownComponent);
