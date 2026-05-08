import { useState } from "react";
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
    toggle: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    id: "italic",
    label: "Italic",
    shortcut: "⌘I",
    icon: IconItalic,
    isActive: (e) => e.isActive("italic"),
    toggle: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    id: "underline",
    label: "Underline",
    shortcut: "⌘U",
    icon: IconUnderline,
    isActive: (e) => e.isActive("underline"),
    toggle: (e) => e.chain().focus().toggleUnderline().run(),
  },
  {
    id: "strike",
    label: "Strikethrough",
    shortcut: "⌘⇧X",
    icon: IconStrike,
    isActive: (e) => e.isActive("strike"),
    toggle: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    id: "code",
    label: "Inline code",
    shortcut: "⌘E",
    icon: IconCode,
    isActive: (e) => e.isActive("code"),
    toggle: (e) => e.chain().focus().toggleCode().run(),
  },
];

// Bubble toolbar shown when text is selected. Notion-style: a single dense
// row of inline-mark buttons + a "Turn into" dropdown for changing the block
// type without leaving the selection.
export function BubbleToolbar({ editor }: BubbleToolbarProps) {
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);

  const onLinkClick = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", previous ?? "");
    if (url === null) return; // cancelled
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
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
