import { Check, ChevronDown, Copy } from "lucide-react";
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
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [theme, setTheme] = useState(pickShikiTheme);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const explicitLanguage = resolveLanguage(language);
  const resolvedLanguage =
    explicitLanguage === "text" ? detectLanguage(trimmed) : explicitLanguage;

  const cacheKey = `${theme}:${resolvedLanguage}:${trimmed}`;
  const [inView, setInView] = useState(() => highlightCache.has(cacheKey));

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(pickShikiTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => observer.disconnect();
  }, []);

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
      setHighlighted(cached);
      return;
    }
    setHighlighted(null);
    if (!inView) return;

    let cancelled = false;
    void (async () => {
      try {
        const html = await codeToHtml(trimmed, {
          lang: resolvedLanguage,
          theme,
        });
        if (cancelled) return;
        if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
          const firstKey = highlightCache.keys().next().value;
          if (firstKey !== undefined) highlightCache.delete(firstKey);
        }
        highlightCache.set(cacheKey, html);
        setHighlighted(html);
      } catch {
        if (!cancelled) setHighlighted(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, inView, resolvedLanguage, theme, trimmed]);

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
      {highlighted ? (
        <div
          className={`md-code-block-shiki ${expanded ? "" : "md-code-block-collapsed"}`.trim()}
          dangerouslySetInnerHTML={{ __html: highlighted }}
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
