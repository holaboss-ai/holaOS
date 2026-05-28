import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Editor, EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { isNodeSelection } from "@tiptap/core";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Markdown } from "@tiptap/markdown";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import type { Node } from "@tiptap/pm/model";

import { SlashCommand } from "./extensions/SlashCommand";
import { BubbleToolbar } from "./extensions/BubbleToolbar";
import { DragHandleColumn } from "./extensions/DragHandleColumn";
import { CodeBlockView } from "./extensions/CodeBlockView";
import { tightenMarkdownTables } from "./markdown";

// Memoised so DragHandle's frequent onNodeChange (every block transition
// during mouse move) doesn't cascade re-renders into the bubble surface.
const MemoBubbleToolbar = memo(BubbleToolbar);
const MemoDragHandleColumn = memo(DragHandleColumn);

// Stable callback references for BubbleMenu — both `appendTo` and
// `shouldShow` get hoisted out of the component so their identity is
// constant across renders. The React BubbleMenu wrapper has these in its
// useEffect dependency array; an inline lambda recreated every render
// fires that effect every render, which dispatches a `updateOptions`
// transaction, which re-evaluates shouldShow, which can flip visibility.
// That's the canonical "bubble menu flickers on mouse move" bug.
const bubbleAppendTo = (): HTMLElement => document.body;

const bubbleShouldShow: NonNullable<BubbleMenuProps["shouldShow"]> = ({
  editor,
  state,
  from,
  to,
}) => {
  if (!editor.isEditable) return false;
  if (state.selection.empty) return false;
  if (isNodeSelection(state.selection)) return false;
  if (editor.isActive("codeBlock")) return false;
  return state.doc.textBetween(from, to).length > 0;
};

// Highlight common languages out of the box. `common` covers ~37 languages
// (js/ts/python/rust/go/sql/json/html/css/bash/md/etc.) at ~70KB. If size
// matters later we can swap to a hand-picked subset.
const lowlight = createLowlight(common);

function normalizeHttpUrl(rawHref: string): string | null {
  try {
    const parsed = new URL(rawHref);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export interface MarkdownEditorProps {
  /** The markdown source. Treated as the controlled value. */
  value: string;
  /** Called with the updated markdown after each transaction. */
  onChange?: (markdown: string) => void;
  /** Placeholder shown when the document is empty. */
  placeholder?: string;
  /** Read-only mode (no edits accepted). */
  readOnly?: boolean;
  /** Autofocus on mount. */
  autoFocus?: boolean;
  /** Extra class on the outer wrapper. Inner ProseMirror surface gets a fixed class for styling. */
  className?: string;
  /** Notified once when the editor instance is created. Useful for parent toolbars. */
  onReady?: (editor: Editor) => void;
  /** Called when the user clicks an http(s) link inside the editor. */
  onLinkClick?: (url: string) => void;
  /** Called when the user clicks a non-http link (relative path, file://, etc). */
  onLocalLinkClick?: (href: string) => void;
}

export interface MarkdownEditorRef {
  /** Returns the current markdown source. */
  getMarkdown: () => string;
  /** Replaces the document with new markdown. */
  setMarkdown: (markdown: string) => void;
  /** Underlying Tiptap editor (escape hatch for advanced consumers). */
  editor: Editor | null;
  /** Move focus into the editor. */
  focus: () => void;
}

// Tiptap-managed Markdown editor.
//
// v0 scope (matches design doc Phase 0): paragraph, headings, lists, code
// blocks, blockquote, hr, hard break, links, basic marks. Slash menu / drag
// handle / custom blocks land in Phase 1.
//
// Markdown round-trip uses the official @tiptap/markdown v3 extension:
//   - parse:     editor.commands.setContent(md, { contentType: 'markdown' })
//   - serialize: editor.getMarkdown()
export const MarkdownEditor = forwardRef<
  MarkdownEditorRef,
  MarkdownEditorProps
>(function MarkdownEditor(
  {
    value,
    onChange,
    placeholder,
    readOnly = false,
    autoFocus,
    className,
    onReady,
    onLinkClick,
    onLocalLinkClick,
  },
  ref,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;
  const onLocalLinkClickRef = useRef(onLocalLinkClick);
  onLocalLinkClickRef.current = onLocalLinkClick;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // Disable StarterKit's plain code block — we replace it with the
        // lowlight-powered version below for syntax highlighting.
        codeBlock: false,
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        },
      }),
      CodeBlockLowlight.extend({
        addNodeView() {
          return ReactNodeViewRenderer(CodeBlockView);
        },
      }).configure({
        lowlight,
        defaultLanguage: null,
        HTMLAttributes: { class: "hb-md-code" },
      }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "paragraph"
            ? (placeholder ?? "Press / for commands…")
            : "",
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      // GFM tables — Tiptap StarterKit doesn't ship these, so without them
      // @tiptap/markdown silently drops `| ... |` table rows when parsing
      // the markdown source (no schema target = no nodes created).
      Table.configure({ resizable: true, allowTableNodeSelection: true }),
      TableRow,
      TableHeader,
      TableCell,
      // Be explicit that the markdown bridge runs in GFM mode — pairs
      // with the Table* extensions above and follows the configuration
      // Tiptap's docs call out for pipe-table support. (marked defaults
      // gfm to true, but stating it here protects intent if upstream
      // defaults shift.)
      Markdown.configure({ markedOptions: { gfm: true } }),
      SlashCommand,
    ],
    [placeholder],
  );

  const editor = useEditor({
    extensions,
    // Pre-process: GFM requires table rows to be contiguous; some sources
    // (often LLM-generated) put a blank line between every row, which
    // marked then turns into literal-text paragraphs. Tighten before parse.
    content: tightenMarkdownTables(value),
    contentType: "markdown",
    editable: !readOnly,
    autofocus: autoFocus ?? false,
    editorProps: {
      handleDOMEvents: {
        click: (_view, event) => {
          const target = event.target as HTMLElement | null;
          const anchor = target?.closest?.("a");
          if (!anchor) return false;
          const rawHref = (anchor.getAttribute("href") ?? "").trim();
          if (!rawHref) return false;
          const normalized = normalizeHttpUrl(rawHref);
          if (normalized) {
            const cb = onLinkClickRef.current;
            if (!cb) return false;
            event.preventDefault();
            cb(normalized);
            return true;
          }
          if (rawHref.startsWith("#")) return false;
          const cb = onLocalLinkClickRef.current;
          if (!cb) return false;
          event.preventDefault();
          cb(rawHref);
          return true;
        },
      },
    },
    onUpdate({ editor }) {
      onChangeRef.current?.(editor.getMarkdown());
    },
  });

  // Notify parent once the editor is ready.
  const readyFiredRef = useRef(false);
  useEffect(() => {
    if (editor && !readyFiredRef.current) {
      readyFiredRef.current = true;
      onReady?.(editor);
    }
  }, [editor, onReady]);

  // Dev-only diagnostic: expose the live editor instance on `window`
  // so it can be inspected from the renderer console while debugging
  // schema / extension state. Skipped entirely in production bundles
  // (NODE_ENV is replaced at build time by Vite / esbuild / tsup), and
  // cleared on unmount so it can't outlive the component.
  useEffect(() => {
    if (!editor) return;
    if (typeof window === "undefined") return;
    const isProd =
      (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process
        ?.env?.NODE_ENV === "production";
    if (isProd) return;
    const w = window as unknown as { __hbEditor?: Editor };
    w.__hbEditor = editor;
    return () => {
      if (w.__hbEditor === editor) {
        delete w.__hbEditor;
      }
    };
  }, [editor]);

  // Reflect external value changes without overwriting in-flight edits.
  // We compare against the editor's current markdown to avoid an update cycle.
  // Both sides are normalised so that an external "value with blank-line
  // tables" doesn't keep diverging from the editor's tightened version.
  useEffect(() => {
    if (!editor) return;
    const tightened = tightenMarkdownTables(value);
    const current = editor.getMarkdown();
    if (current === tightened) return;
    const wasFocused = editor.isFocused;
    editor.commands.setContent(tightened, {
      contentType: "markdown",
      emitUpdate: false,
    });
    if (wasFocused) editor.commands.focus("end");
  }, [editor, value]);

  // Reflect read-only flag changes.
  useEffect(() => {
    if (!editor) return;
    if (editor.isEditable === !readOnly) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useImperativeHandle(
    ref,
    (): MarkdownEditorRef => ({
      getMarkdown: () => (editor ? editor.getMarkdown() : value),
      setMarkdown: (md: string) => {
        editor?.commands.setContent(tightenMarkdownTables(md), {
          contentType: "markdown",
          emitUpdate: true,
        });
      },
      get editor() {
        return editor ?? null;
      },
      focus: () => editor?.commands.focus(),
    }),
    [editor, value],
  );

  // Drag-handle's currently-hovered node lives in a ref, NOT useState.
  // DragHandle fires `onNodeChange` on every block transition the mouse
  // crosses. Pushing that into setState would re-render MarkdownEditor on
  // every mouse move — and the BubbleMenu wrapper's useEffect deps include
  // its own props, which would then dispatch `updateOptions` transactions
  // on every render. That cascade is exactly what made the bubble flicker
  // when the cursor hovered text. The DragHandleColumn re-mounts in place
  // each time the handle re-positions, so it can read the latest values
  // from this ref without React state at all.
  const activeNodeRef = useRef<{ node: Node | null; pos: number }>({
    node: null,
    pos: 0,
  });
  const handleDragNodeChange = useCallback(
    ({ node, pos }: { node: Node | null; pos: number }) => {
      activeNodeRef.current = { node, pos };
    },
    [],
  );

  return (
    <div className={`hb-md-editor ${className ?? ""}`.trim()}>
      {editor && !readOnly ? (
        <DragHandle
          editor={editor}
          className="hb-drag-handle"
          onNodeChange={handleDragNodeChange}
        >
          <MemoDragHandleColumn editor={editor} nodeRef={activeNodeRef} />
        </DragHandle>
      ) : null}
      {editor ? (
        // Stable references for every prop — see notes on bubbleAppendTo /
        // bubbleShouldShow above. With these, BubbleMenu's deps-effect
        // doesn't re-fire on parent re-renders.
        <BubbleMenu
          editor={editor}
          appendTo={bubbleAppendTo}
          shouldShow={bubbleShouldShow}
        >
          <MemoBubbleToolbar editor={editor} />
        </BubbleMenu>
      ) : null}
      <EditorContent editor={editor} className="hb-md-editor__content" />
    </div>
  );
});
