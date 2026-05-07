import { useState } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

import { IconCheck, IconCopy } from "../icons";

// React NodeView for fenced code blocks. Mirrors what Tiptap's default
// `addNodeView` would render (`<pre><code>`) and adds:
//   - language pill (read-only display in v0)
//   - Copy button that lifts text out of the node, writes to clipboard,
//     and flashes a "Copied" state for 1.2s
export function CodeBlockView({ node }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const language = (node.attrs.language as string | null) ?? null;

  const onCopy = () => {
    const text = node.textContent ?? "";
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <NodeViewWrapper as="pre" className="hb-md-code-wrap" data-language={language || undefined}>
      <div className="hb-md-code__chrome" contentEditable={false}>
        {language ? (
          <span className="hb-md-code__lang" aria-label={`Language: ${language}`}>
            {language}
          </span>
        ) : (
          <span className="hb-md-code__lang hb-md-code__lang--muted">Plain</span>
        )}
        <button
          type="button"
          className="hb-md-code__copy"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCopy}
          aria-label="Copy code"
          data-copied={copied || undefined}
        >
          {copied ? (
            <>
              <IconCheck className="hb-md-code__copy-icon" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <IconCopy className="hb-md-code__copy-icon" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <NodeViewContent<"code"> as="code" className={language ? `language-${language}` : undefined} />
    </NodeViewWrapper>
  );
}
