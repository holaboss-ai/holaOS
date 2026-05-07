import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Editor, EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import type { Node } from "@tiptap/pm/model";

import { SlashCommand } from "./extensions/SlashCommand";
import { BubbleToolbar } from "./extensions/BubbleToolbar";
import { DragHandleColumn } from "./extensions/DragHandleColumn";
import { CodeBlockView } from "./extensions/CodeBlockView";

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
      Markdown,
      SlashCommand,
    ],
    [placeholder],
  );

  const editor = useEditor({
    extensions,
    content: value,
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

  // Reflect external value changes without overwriting in-flight edits.
  // We compare against the editor's current markdown to avoid an update cycle.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getMarkdown();
    if (current === value) return;
    const wasFocused = editor.isFocused;
    editor.commands.setContent(value, {
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
        editor?.commands.setContent(md, {
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
          // Use the plugin's built-in shouldShow:
          //   - editor focused
          //   - selection non-empty
          //   - selection contains text (not just an empty block)
          //   - editor is editable
          // We additionally hide inside code blocks where marks are noise.
          shouldShow={({ editor, view, state, from, to }) => {
            if (!view.hasFocus()) return false;
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
