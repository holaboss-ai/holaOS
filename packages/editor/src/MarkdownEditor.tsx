import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Editor, EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { isNodeSelection } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
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

// Highlight common languages out of the box. `common` covers ~37 languages
// (js/ts/python/rust/go/sql/json/html/css/bash/md/etc.) at ~70KB. If size
// matters later we can swap to a hand-picked subset.
const lowlight = createLowlight(common);

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
  { value, onChange, placeholder, readOnly = false, autoFocus, className, onReady },
  ref,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // Disable StarterKit's plain code block — we replace it with the
        // lowlight-powered version below for syntax highlighting.
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
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
        placeholder: ({ editor, node }) => {
          // Show a "press / for commands" hint on empty paragraphs to teach
          // the slash menu without needing a separate onboarding step.
          if (node.type.name === "paragraph" && editor.isFocused) {
            return "Press / for commands…";
          }
          return placeholder ?? "Start writing…";
        },
        showOnlyCurrent: true,
        emptyEditorClass: "hb-md-empty",
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

  // Track the currently-hovered node so the drag-handle column can know
  // what "+" should insert next to. Tiptap's DragHandle gives us this via
  // its onNodeChange callback.
  const [activeNode, setActiveNode] = useState<{ node: Node | null; pos: number }>({
    node: null,
    pos: 0,
  });

  // Notion-style pointer-drag suppression for the bubble menu.
  //
  // Without this, every selection-grow event (each pixel as the user drags
  // to select text) triggers a `shouldShow` re-evaluation; the bubble
  // appears and follows the moving anchor — flickery and not what users
  // expect. Notion / BlockNote both hide the toolbar for the duration of
  // the mouse drag and re-show on `pointerup`.
  //
  // Implementation: a ref + DOM listeners. The bubble's `shouldShow`
  // reads the ref directly. After `pointerup` we dispatch an empty
  // transaction to force `shouldShow` to re-run (the selection itself
  // didn't change at the moment of release, so without this nudge the
  // bubble would only re-appear on the next document mutation).
  const pointerDraggingRef = useRef(false);
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onDown = () => {
      pointerDraggingRef.current = true;
    };
    const onUp = () => {
      if (!pointerDraggingRef.current) return;
      pointerDraggingRef.current = false;
      // Force shouldShow to re-evaluate now that the drag is over.
      // Wrap in microtask so the focus/selection finishes settling first.
      queueMicrotask(() => {
        if (editor.isDestroyed) return;
        editor.view.dispatch(editor.view.state.tr);
      });
    };
    // pointerdown only fires when the press starts inside the editor —
    // exactly the case where we want to suppress. pointerup is on document
    // because the user might release outside the editor's bounding box.
    dom.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    return () => {
      dom.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
    };
  }, [editor]);

  return (
    <div className={`hb-md-editor ${className ?? ""}`.trim()}>
      {editor && !readOnly ? (
        <DragHandle
          editor={editor}
          className="hb-drag-handle"
          onNodeChange={({ node, pos }) => setActiveNode({ node, pos })}
        >
          <DragHandleColumn editor={editor} node={activeNode.node} pos={activeNode.pos} />
        </DragHandle>
      ) : null}
      {editor ? (
        <BubbleMenu
          editor={editor}
          // Mount the bubble into document.body so the parent's overflow:auto
          // doesn't clip it. Critical — without this, the bubble renders
          // but sits inside .hb-md-editor__content and gets clipped.
          appendTo={() => document.body}
          // shouldShow contract (Notion-style):
          //   - editor must be editable
          //   - selection must be non-empty + actually contain text
          //   - skip while user is dragging to make a selection (anti-flicker)
          //   - skip on NodeSelection (image/table/etc. — inline marks N/A)
          //   - skip inside code blocks where marks are noise
          //
          // Intentionally NOT checking `view.hasFocus()`. When the user
          // moves the pointer onto a bubble button focus briefly leaves
          // the editor — that check would hide the bubble exactly when
          // the user is about to click it. Novel and BlockNote both omit
          // this check for the same reason.
          shouldShow={({ editor, state, from, to }) => {
            if (!editor.isEditable) return false;
            if (pointerDraggingRef.current) return false;
            if (isNodeSelection(state.selection)) return false;
            if (state.selection.empty) return false;
            if (editor.isActive("codeBlock")) return false;
            const hasText = state.doc.textBetween(from, to).length > 0;
            return hasText;
          }}
          // Reduce the default 250ms debounce — Notion-feel needs <100ms.
          updateDelay={50}
          options={{
            placement: "top",
            offset: 8,
            flip: true,
            shift: { padding: 8 },
          }}
          data-hb-bubble-root=""
        >
          <BubbleToolbar editor={editor} />
        </BubbleMenu>
      ) : null}
      <EditorContent editor={editor} className="hb-md-editor__content" />
    </div>
  );
});
