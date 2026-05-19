import { useCallback, useEffect, useMemo, useRef } from "react";

export const HTML_PREVIEW_LINK_MESSAGE_TYPE =
  "holaboss:html-preview-link";

const HTML_PREVIEW_SCRIPT_NONCE = "holaboss-html-preview";
const CONTENT_SECURITY_POLICY_META_PATTERN =
  /<meta\b[^>]*http-equiv=(["'])content-security-policy\1[^>]*>/gi;

const HTML_PREVIEW_CSP = [
  "default-src * data: blob:",
  "img-src * data: blob:",
  "media-src * data: blob:",
  "style-src * data: blob: 'unsafe-inline'",
  "font-src * data: blob:",
  "connect-src * data: blob:",
  "frame-src * data: blob:",
  `script-src 'nonce-${HTML_PREVIEW_SCRIPT_NONCE}'`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const HTML_PREVIEW_BRIDGE = [
  `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`,
  `<script nonce="${HTML_PREVIEW_SCRIPT_NONCE}">`,
  "(() => {",
  `  const messageType = ${JSON.stringify(HTML_PREVIEW_LINK_MESSAGE_TYPE)};`,
  "  const scrollToHash = (rawHref) => {",
  '    const hash = typeof rawHref === "string" ? rawHref.trim() : "";',
  "    if (!hash.startsWith('#')) {",
  "      return false;",
  "    }",
  "    const targetId = (() => {",
  "      try {",
  "        return decodeURIComponent(hash.slice(1));",
  "      } catch {",
  "        return hash.slice(1);",
  "      }",
  "    })();",
  "    if (!targetId) {",
  "      return false;",
  "    }",
  "    const target =",
  "      document.getElementById(targetId) ??",
  '      Array.from(document.querySelectorAll("a[name]")).find(',
  "        (anchor) => anchor.getAttribute('name') === targetId,",
  "      ) ??",
  "      null;",
  "    if (!target) {",
  "      return false;",
  "    }",
  "    const scrollElement =",
  "      document.scrollingElement ?? document.documentElement ?? document.body;",
  "    if (!scrollElement) {",
  "      return false;",
  "    }",
  "    const targetRect = target.getBoundingClientRect();",
  "    const scrollRect = scrollElement.getBoundingClientRect();",
  "    const top = scrollElement.scrollTop + (targetRect.top - scrollRect.top);",
  "    scrollElement.scrollTo({",
  "      top: Math.max(0, top),",
  "      behavior: 'smooth',",
  "    });",
  "    if (window.location.hash !== hash) {",
  "      history.replaceState(null, '', hash);",
  "    }",
  "    return true;",
  "  };",
  "  window.addEventListener('hashchange', () => {",
  "    scrollToHash(window.location.hash);",
  "  });",
  "  window.addEventListener('DOMContentLoaded', () => {",
  "    if (window.location.hash) {",
  "      scrollToHash(window.location.hash);",
  "    }",
  "  });",
  "  document.addEventListener(",
  '    "click",',
  "    (event) => {",
  "      if (",
  "        event.defaultPrevented ||",
  "        event.button !== 0 ||",
  "        event.metaKey ||",
  "        event.ctrlKey ||",
  "        event.shiftKey ||",
  "        event.altKey",
  "      ) {",
  "        return;",
  "      }",
  "      const target = event.target instanceof Element ? event.target : null;",
  '      const anchor = target?.closest("a[href]");',
  "      if (!anchor) {",
  "        return;",
  "      }",
  '      const href = anchor.getAttribute("href")?.trim() ?? "";',
  "      if (",
  "        !href ||",
  '        href.toLowerCase().startsWith("javascript:")',
  "      ) {",
  "        return;",
  "      }",
  "      if (href.startsWith('#')) {",
  "        event.preventDefault();",
  "        scrollToHash(href);",
  "        return;",
  "      }",
  "      event.preventDefault();",
  '      window.parent.postMessage({ type: messageType, href }, "*");',
  "    },",
  "    true,",
  "  );",
  "})();",
  "</script>",
].join("");

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

export function buildHtmlPreviewSrcDoc(rawHtml: string): string {
  const sanitizedHtml = rawHtml.replace(
    CONTENT_SECURITY_POLICY_META_PATTERN,
    "",
  );
  if (/<head\b[^>]*>/i.test(sanitizedHtml)) {
    return sanitizedHtml.replace(
      /<head\b([^>]*)>/i,
      `<head$1>${HTML_PREVIEW_BRIDGE}`,
    );
  }
  if (/<html\b[^>]*>/i.test(sanitizedHtml)) {
    return sanitizedHtml.replace(
      /<html\b([^>]*)>/i,
      `<html$1><head>${HTML_PREVIEW_BRIDGE}</head>`,
    );
  }
  return `<!doctype html><html><head>${HTML_PREVIEW_BRIDGE}</head><body>${sanitizedHtml}</body></html>`;
}

interface HtmlPreviewFrameProps {
  title: string;
  html: string;
  className?: string;
  onOpenLinkInBrowser?: (url: string) => void;
  onOpenLocalLink?: (href: string) => void;
}

export function HtmlPreviewFrame({
  title,
  html,
  className,
  onOpenLinkInBrowser,
  onOpenLocalLink,
}: HtmlPreviewFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const srcDoc = useMemo(() => buildHtmlPreviewSrcDoc(html), [html]);

  const handlePreviewMessage = useCallback(
    (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== "object") {
        return;
      }
      const { type, href } = data as {
        href?: unknown;
        type?: unknown;
      };
      if (
        type !== HTML_PREVIEW_LINK_MESSAGE_TYPE ||
        typeof href !== "string"
      ) {
        return;
      }
      const normalizedHttpHref = normalizeHttpUrl(href);
      if (normalizedHttpHref) {
        onOpenLinkInBrowser?.(normalizedHttpHref);
        return;
      }
      onOpenLocalLink?.(href);
    },
    [onOpenLinkInBrowser, onOpenLocalLink],
  );

  useEffect(() => {
    window.addEventListener("message", handlePreviewMessage);
    return () => {
      window.removeEventListener("message", handlePreviewMessage);
    };
  }, [handlePreviewMessage]);

  return (
    <iframe
      ref={iframeRef}
      title={title}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className={className}
    />
  );
}
