/**
 * Markdown renderer shared by the marketplace README and workspace chat.
 * Uses react-markdown with GFM support while preserving the existing md-* CSS hooks.
 */

import {
  createElement,
  isValidElement,
  memo,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
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
const STANDALONE_HTML_ANCHOR_PATTERN =
  /^<a\b[^>]*(?:id|name)=(["'])([^"'<>]+)\1[^>]*>\s*<\/a>$/i;
const ATX_HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCED_BLOCK_PATTERN = /^\s{0,3}(`{3,}|~{3,})/;

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

function decodeAnchorHref(rawHref: string): string {
  const trimmed = rawHref.trim().replace(/^#+/, "");
  if (!trimmed) {
    return "";
  }
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function extractStandaloneAnchorId(line: string): string | null {
  const match = line.trim().match(STANDALONE_HTML_ANCHOR_PATTERN);
  return match?.[2]?.trim() || null;
}

function markdownHeadingTextToPlainText(rawText: string): string {
  return rawText
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~]/g, "")
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1")
    .trim();
}

function slugifyHeadingText(rawText: string): string {
  const normalized = rawText
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "section";
}

function plainTextFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => plainTextFromNode(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return plainTextFromNode(node.props.children);
  }
  return "";
}

function isScrollableElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    /(auto|scroll)/.test(style.overflowY) &&
    element.scrollHeight > element.clientHeight + 1
  );
}

function findScrollableContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    if (isScrollableElement(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function scrollElementWithinContainer(
  container: HTMLElement,
  target: HTMLElement,
): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = container.scrollTop + (targetRect.top - containerRect.top);
  container.scrollTo({
    top: Math.max(0, top),
    behavior: "smooth",
  });
}

function resolveHeadingId(
  props: MdProps,
  headingSlugCounts: Map<string, number>,
): string {
  const explicitId =
    typeof props.id === "string" && props.id.trim() ? props.id.trim() : "";
  if (explicitId) {
    return explicitId;
  }
  const baseSlug = slugifyHeadingText(plainTextFromNode(props.children));
  const count = headingSlugCounts.get(baseSlug) ?? 0;
  headingSlugCounts.set(baseSlug, count + 1);
  return count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
}

function renderHeading(
  tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6",
  headingClassName: string,
  props: MdProps,
  headingSlugCounts: Map<string, number>,
) {
  const { className, ...restProps } = props;
  return createElement(tag, {
    ...restProps,
    id: resolveHeadingId(props, headingSlugCounts),
    className: appendClassName(className, headingClassName),
  });
}

function buildMarkdownAnchorAliasMap(
  markdown: string,
): Map<string, string> {
  const pendingAliases: string[] = [];
  const headingSlugCounts = new Map<string, number>();
  const aliases = new Map<string, string>();
  let activeFenceMarker: string | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmedLine = rawLine.trim();
    const fenceMatch = trimmedLine.match(FENCED_BLOCK_PATTERN);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!activeFenceMarker) {
        activeFenceMarker = marker[0];
      } else if (marker[0] === activeFenceMarker) {
        activeFenceMarker = null;
      }
      continue;
    }
    if (activeFenceMarker) {
      continue;
    }
    const explicitAnchorId = extractStandaloneAnchorId(trimmedLine);
    if (explicitAnchorId) {
      pendingAliases.push(explicitAnchorId);
      continue;
    }
    const headingMatch = trimmedLine.match(ATX_HEADING_PATTERN);
    if (!headingMatch) {
      continue;
    }
    const baseSlug = slugifyHeadingText(
      markdownHeadingTextToPlainText(headingMatch[2] ?? ""),
    );
    const count = headingSlugCounts.get(baseSlug) ?? 0;
    headingSlugCounts.set(baseSlug, count + 1);
    const resolvedHeadingId =
      count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
    for (const anchorId of pendingAliases) {
      aliases.set(anchorId, resolvedHeadingId);
    }
    pendingAliases.length = 0;
  }
  return aliases;
}

import type { ExtraProps } from "react-markdown";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MdProps = any;

function createMarkdownComponents(
  onLinkClick?: ((url: string) => void) | undefined,
  onLocalLinkClick?: ((href: string) => void) | undefined,
  onAnchorClick?: ((href: string) => boolean) | undefined,
  renderMention?: ((handle: string) => ReactNode) | undefined,
): Components {
  const headingSlugCounts = new Map<string, number>();
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
          if (isAnchor && onAnchorClick) {
            const handled = onAnchorClick(rawHref);
            if (handled) {
              event.preventDefault();
            }
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
  h1(props: MdProps) {
    return renderHeading("h1", "md-h1", props, headingSlugCounts);
  },
  h2(props: MdProps) {
    return renderHeading("h2", "md-h2", props, headingSlugCounts);
  },
  h3(props: MdProps) {
    return renderHeading("h3", "md-h3", props, headingSlugCounts);
  },
  h4(props: MdProps) {
    return renderHeading("h4", "md-h4", props, headingSlugCounts);
  },
  h5(props: MdProps) {
    return renderHeading("h5", "md-h5", props, headingSlugCounts);
  },
  h6(props: MdProps) {
    return renderHeading("h6", "md-h6", props, headingSlugCounts);
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const normalizedChildren = useMemo(
    () => normalizeWrappedMarkdownFence(children),
    [children],
  );
  const explicitAnchorAliases = useMemo(
    () => buildMarkdownAnchorAliasMap(normalizedChildren),
    [normalizedChildren],
  );
  const handleAnchorClick = useCallback((href: string) => {
    const rawTargetId = decodeAnchorHref(href);
    if (!rawTargetId) {
      return false;
    }
    const container = rootRef.current;
    if (!container) {
      return false;
    }
    const targetId = explicitAnchorAliases.get(rawTargetId) ?? rawTargetId;
    const target =
      container.querySelector<HTMLElement>(`#${CSS.escape(targetId)}`) ??
      Array.from(container.querySelectorAll<HTMLAnchorElement>("a[name]")).find(
        (anchor) => anchor.getAttribute("name") === targetId,
      ) ??
      null;
    if (!target) {
      return false;
    }
    const scrollContainer = findScrollableContainer(target);
    if (scrollContainer) {
      scrollElementWithinContainer(scrollContainer, target);
    } else {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    return true;
  }, [explicitAnchorAliases]);
  const components = useMemo(
    () =>
      createMarkdownComponents(
        onLinkClick,
        onLocalLinkClick,
        handleAnchorClick,
        renderMention,
      ),
    [handleAnchorClick, onLinkClick, onLocalLinkClick, renderMention],
  );

  return (
    <div ref={rootRef} className={`simple-markdown ${className}`.trim()}>
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
