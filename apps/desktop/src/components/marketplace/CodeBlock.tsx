import { Check, ChevronDown, Copy } from "@/components/ui/icons";
import {
  Children,
  isValidElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { type BundledLanguage, bundledLanguages, codeToHtml } from "shiki";

const LONG_BLOCK_LINE_THRESHOLD = 30;
const HIGHLIGHT_CACHE_MAX = 200;
/**
 * How long the code body must stop changing before it is worth tokenizing.
 * Streaming output changes far faster than this, so a block being written is
 * highlighted once at the end rather than on every frame.
 */
const HIGHLIGHT_SETTLE_MS = 120;
const highlightCache = new Map<string, string>();

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  objc: "objc",
};

function isBundledLanguage(lang: string): lang is BundledLanguage {
  return Object.prototype.hasOwnProperty.call(bundledLanguages, lang);
}

function resolveLanguage(language: string | undefined): BundledLanguage | "text" {
  if (!language) return "text";
  const lower = language.toLowerCase();
  const aliased = LANGUAGE_ALIASES[lower];
  if (aliased) return aliased;
  return isBundledLanguage(lower) ? lower : "text";
}

function detectLanguage(code: string): BundledLanguage | "text" {
  const sample = code.slice(0, 600);
  const firstLine = sample.split("\n", 1)[0] ?? "";
  if (/<\?php\b/.test(sample)) return "php";
  if (/^#!\s*\/.*\b(?:bash|sh|zsh)\b/.test(firstLine)) return "bash";
  if (/^#!\s*\/.*\bpython/.test(firstLine)) return "python";
  if (/^#!\s*\/.*\bnode/.test(firstLine)) return "javascript";
  if (/^---\s*$/m.test(sample) && /^\s*\w+:\s/m.test(sample)) return "yaml";
  if (/^[A-Za-z_][\w-]*:\s*$/m.test(sample) && /^[ \t]+[\w-]+:(\s|$)/m.test(sample)) {
    return "yaml";
  }
  if (/<!DOCTYPE\b|<html\b|<head\b/i.test(sample)) return "html";
  if (sample.trim().startsWith("{") || sample.trim().startsWith("[")) {
    if (/^[\s\S]*"[^"]+"\s*:/.test(sample)) return "json";
  }
  // JSX-only patterns: closing tag, attribute on a Capitalized tag, or
  // self-closing Capitalized tag. Excludes generics like `<T>` and
  // `Map<string, User>`.
  const looksLikeJsx =
    /<\/[A-Z]\w*>|<[A-Z]\w*\s+[a-z][\w-]*\s*=|<[A-Z]\w*\s*\/>/.test(sample);
  if (/\b(?:interface\s+\w|type\s+\w+\s*=|export\s+(?:default\s+)?(?:function|class|const|interface|type)|import\s+[\w*{},\s]+from\s+["'])/.test(sample)) {
    return looksLikeJsx ? "tsx" : "typescript";
  }
  if (/\b(?:function\s+\w|const\s+\w+\s*=|=>\s*[{(]|require\s*\()/.test(sample)) {
    return looksLikeJsx ? "jsx" : "javascript";
  }
  if (/\b(?:def\s+\w+\s*\(|^\s*elif\s+|from\s+[\w.]+\s+import\b)/m.test(sample)) {
    return "python";
  }
  if (/\b(?:fn |let mut\b|impl\b|use\s+[\w:]+::|::\w+)/.test(sample)) return "rust";
  if (/^package\s+\w/m.test(sample) || /\bfunc\s+\w+\s*\(/.test(sample)) return "go";
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE)\b/im.test(sample)) {
    return "sql";
  }
  if (/\$\s*\w|\becho\s+|^\s*[a-z_]+=\S/im.test(sample)) return "bash";
  return "text";
}

function pickShikiTheme(): "vitesse-dark" | "vitesse-light" {
  if (typeof document === "undefined") return "vitesse-light";
  const themeAttr = document.documentElement.dataset.theme ?? "";
  return themeAttr.toLowerCase().includes("dark") ? "vitesse-dark" : "vitesse-light";
}

/**
 * One MutationObserver on <html> for the whole app, not one per code block.
 * A long conversation renders many CodeBlocks, and each used to observe the
 * root element itself — the theme changes at most a handful of times per
 * session, so N observers for one shared signal is pure overhead.
 */
type ShikiTheme = ReturnType<typeof pickShikiTheme>;
const themeSubscribers = new Set<(theme: ShikiTheme) => void>();
let rootThemeObserver: MutationObserver | null = null;

function subscribeShikiTheme(onChange: (theme: ShikiTheme) => void): () => void {
  themeSubscribers.add(onChange);
  if (!rootThemeObserver && typeof MutationObserver !== "undefined") {
    rootThemeObserver = new MutationObserver(() => {
      const next = pickShikiTheme();
      for (const subscriber of themeSubscribers) {
        subscriber(next);
      }
    });
    rootThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
  }
  return () => {
    themeSubscribers.delete(onChange);
    if (themeSubscribers.size === 0) {
      rootThemeObserver?.disconnect();
      rootThemeObserver = null;
    }
  };
}

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return "";
}

function findCodeChild(node: ReactNode): {
  language: string | undefined;
  code: string;
} {
  let language: string | undefined;
  let code = "";
  Children.forEach(node, (child) => {
    if (isValidElement(child) && child.type === "code") {
      const props = child.props as { className?: string; children?: ReactNode };
      const match = props.className?.match(/language-([\w-]+)/);
      if (match) language = match[1];
      code = extractText(props.children);
    }
  });
  if (!code) code = extractText(node);
  return { language, code };
}

interface CodeBlockProps {
  language?: string;
  code: string;
}

export function CodeBlock({ language, code }: CodeBlockProps) {
  const trimmed = code.replace(/\n$/, "");
  const lineCount = trimmed.split("\n").length;
  const isLong = lineCount > LONG_BLOCK_LINE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);
  const [copied, setCopied] = useState(false);
  // Carries the key it was produced for. Holding the HTML alone let a commit
  // paint the PREVIOUS body's highlight: when the settle timer fires,
  // `settledCode === trimmed` becomes true in the same commit that still holds
  // the older HTML, so a streaming block flashed its earlier, shorter self
  // before the effect could clear it.
  const [highlighted, setHighlighted] = useState<{
    key: string;
    html: string;
  } | null>(null);
  const [theme, setTheme] = useState(pickShikiTheme);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const explicitLanguage = resolveLanguage(language);
  const resolvedLanguage =
    explicitLanguage === "text" ? detectLanguage(trimmed) : explicitLanguage;

  // Highlight the text once it SETTLES, not on every streamed frame.
  //
  // The cache key contains the whole body, so while an agent streams a code
  // block every appended character was a miss that also STORED an entry —
  // re-tokenizing the growing block each frame and filling a 200-entry FIFO
  // with throwaway partials, evicting genuinely reusable ones. A block that is
  // already complete on mount settles immediately, so static content is
  // unaffected.
  const [settledCode, setSettledCode] = useState(trimmed);
  useEffect(() => {
    if (settledCode === trimmed) {
      return;
    }
    const timer = setTimeout(
      () => setSettledCode(trimmed),
      HIGHLIGHT_SETTLE_MS,
    );
    return () => clearTimeout(timer);
  }, [settledCode, trimmed]);

  const cacheKey = `${theme}:${resolvedLanguage}:${settledCode}`;
  const [inView, setInView] = useState(() => highlightCache.has(cacheKey));

  useEffect(() => subscribeShikiTheme(setTheme), []);

  useEffect(() => {
    if (inView) return;
    if (highlightCache.has(cacheKey)) {
      setInView(true);
      return;
    }
    const node = wrapperRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [cacheKey, inView]);

  useEffect(() => {
    const cached = highlightCache.get(cacheKey);
    if (cached) {
      setHighlighted({ key: cacheKey, html: cached });
      return;
    }
    // No clear needed: the render gates on the stored key, so stale HTML is
    // already invisible. Clearing here would only cost an extra render.
    if (!inView) return;

    let cancelled = false;
    void (async () => {
      try {
        const html = await codeToHtml(settledCode, {
          lang: resolvedLanguage,
          theme,
        });
        if (cancelled) return;
        if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
          const firstKey = highlightCache.keys().next().value;
          if (firstKey !== undefined) highlightCache.delete(firstKey);
        }
        highlightCache.set(cacheKey, html);
        setHighlighted({ key: cacheKey, html });
      } catch {
        if (!cancelled) setHighlighted(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, inView, resolvedLanguage, settledCode, theme]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  const langLabel = (() => {
    if (language?.trim()) return language.toLowerCase();
    if (resolvedLanguage !== "text") return resolvedLanguage;
    return "code";
  })();

  return (
    <div className="md-code-block-wrapper group/code-block" ref={wrapperRef}>
      <div className="md-code-block-header">
        <span className="md-code-block-lang">{langLabel}</span>
        <button
          aria-label={copied ? "Copied" : "Copy code"}
          className="md-code-block-copy"
          onClick={() => void handleCopy()}
          type="button"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Only show highlighted HTML when it corresponds to the text on screen.
          Two conditions, and both are load-bearing: the HTML must have been
          produced for the CURRENT key (otherwise the commit in which
          settledCode catches up paints the previous body), and settledCode
          must have caught up at all (otherwise a still-growing block freezes
          at an earlier frame). The plain <pre> below stays live throughout. */}
      {highlighted?.key === cacheKey && settledCode === trimmed ? (
        <div
          className={`md-code-block-shiki ${expanded ? "" : "md-code-block-collapsed"}`.trim()}
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      ) : (
        <pre
          className={`md-code-block ${expanded ? "" : "md-code-block-collapsed"}`.trim()}
        >
          <code>{trimmed}</code>
        </pre>
      )}
      {isLong ? (
        <button
          className="md-code-block-expand"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <ChevronDown
            className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Collapse" : `Show all ${lineCount} lines`}
        </button>
      ) : null}
    </div>
  );
}

export function codeBlockFromPreNode(children: ReactNode): {
  language: string | undefined;
  code: string;
} {
  return findCodeChild(children);
}
