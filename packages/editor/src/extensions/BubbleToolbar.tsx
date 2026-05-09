import { useRef, useState } from "react";
import type { Editor } from "@tiptap/core";

import {
  IconBold,
  IconCode,
  IconItalic,
  IconLink,
  IconStrike,
  IconUnderline,
  IconChevronDown,
} from "../icons";
import { TURN_INTO_OPTIONS, currentTurnIntoLabel } from "./blockTypes";

interface BubbleToolbarProps {
  editor: Editor;
}

interface MarkButton {
  id: string;
  label: string;
  shortcut: string;
  icon: typeof IconBold;
  isActive: (e: Editor) => boolean;
  toggle: (e: Editor) => void;
  enabled?: (e: Editor) => boolean;
}

const MARK_BUTTONS: MarkButton[] = [
  {
    id: "bold",
    label: "Bold",
    shortcut: "⌘B",
    icon: IconBold,
    isActive: (e) => e.isActive("bold"),
    toggle: (e) => e.chain().focus(undefined, { scrollIntoView: false }).toggleBold().run(),
  },
  {
    id: "italic",
    label: "Italic",
    shortcut: "⌘I",
    icon: IconItalic,
    isActive: (e) => e.isActive("italic"),
    toggle: (e) => e.chain().focus(undefined, { scrollIntoView: false }).toggleItalic().run(),
  },
  {
    id: "underline",
    label: "Underline",
    shortcut: "⌘U",
    icon: IconUnderline,
    isActive: (e) => e.isActive("underline"),
    toggle: (e) => e.chain().focus(undefined, { scrollIntoView: false }).toggleUnderline().run(),
  },
  {
    id: "strike",
    label: "Strikethrough",
    shortcut: "⌘⇧X",
    icon: IconStrike,
    isActive: (e) => e.isActive("strike"),
    toggle: (e) => e.chain().focus(undefined, { scrollIntoView: false }).toggleStrike().run(),
  },
  {
    id: "code",
    label: "Inline code",
    shortcut: "⌘E",
    icon: IconCode,
    isActive: (e) => e.isActive("code"),
    toggle: (e) => e.chain().focus(undefined, { scrollIntoView: false }).toggleCode().run(),
  },
];

// Bubble toolbar shown when text is selected. Notion-style: a single dense
// row of inline-mark buttons + a "Turn into" dropdown for changing the block
// type without leaving the selection.
export function BubbleToolbar({ editor }: BubbleToolbarProps) {
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);
  // Capture the selection at the moment the user opens Turn-into. Between
  // the trigger click and the item click the editor's effective selection
  // can drift (DOM focus shuffling between portal element and editor),
  // and a `setNode` against the wrong selection silently rewrites the
  // last block of the document instead of the one the user picked.
  // Restoring this snapshot before applying makes the action robust.
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);

  const captureSelection = () => {
    const sel = editor.state.selection;
    savedSelectionRef.current = { from: sel.from, to: sel.to };
  };

  const restoreSelection = () => {
    const saved = savedSelectionRef.current;
    if (!saved) return;
    editor.commands.setTextSelection(saved);
  };

  const onLinkClick = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", previous ?? "");
    if (url === null) return; // cancelled
    if (url === "") {
      editor.chain().focus(undefined, { scrollIntoView: false }).extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus(undefined, { scrollIntoView: false }).extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div className="hb-bubble" role="toolbar">
      {/* Turn-into dropdown */}
      <div className="hb-bubble__turn">
        <button
          type="button"
          className="hb-bubble__turn-trigger"
          onMouseDown={(e) => {
            e.preventDefault();
            // Snapshot the live selection before any DOM focus shuffles.
            captureSelection();
            setTurnIntoOpen((v) => !v);
          }}
          aria-haspopup="menu"
          aria-expanded={turnIntoOpen}
        >
          <span className="hb-bubble__turn-label">{currentTurnIntoLabel(editor)}</span>
          <IconChevronDown className="hb-bubble__chevron" />
        </button>
        {turnIntoOpen ? (
          <div
            role="menu"
            className="hb-bubble__turn-menu"
            onMouseLeave={() => setTurnIntoOpen(false)}
          >
            {TURN_INTO_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = opt.isActive(editor);
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="menuitem"
                  data-active={active || undefined}
                  className="hb-bubble__turn-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    // Restore the original selection before mutating —
                    // see savedSelectionRef comment.
                    restoreSelection();
                    opt.apply(editor);
                    setTurnIntoOpen(false);
                  }}
                >
                  <Icon className="hb-bubble__turn-icon" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <span className="hb-bubble__sep" aria-hidden="true" />

      {/* Inline marks */}
      {MARK_BUTTONS.map((b) => {
        const Icon = b.icon;
        const active = b.isActive(editor);
        return (
          <button
            key={b.id}
            type="button"
            data-active={active || undefined}
            className="hb-bubble__btn"
            title={`${b.label} (${b.shortcut})`}
            aria-label={b.label}
            aria-pressed={active}
            onMouseDown={(e) => {
              e.preventDefault();
              b.toggle(editor);
            }}
          >
            <Icon className="hb-bubble__icon" />
          </button>
        );
      })}

      <span className="hb-bubble__sep" aria-hidden="true" />

      <button
        type="button"
        data-active={editor.isActive("link") || undefined}
        className="hb-bubble__btn"
        title="Link (⌘K)"
        aria-label="Link"
        onMouseDown={(e) => {
          e.preventDefault();
          onLinkClick();
        }}
      >
        <IconLink className="hb-bubble__icon" />
      </button>
    </div>
  );
}
